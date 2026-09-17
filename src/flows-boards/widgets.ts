import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LiveSurfaces } from "../asks/live-surfaces.js";
import { askLabels, askMode } from "../asks/settings.js";
import { isReadOnlyPermission } from "../policy.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { boardTools, oneLine, partRecord, requirePart } from "./settings.js";

/**
 * R17-072: widgets the assistant builds, that stay current (OpenClaw's widget tool, `src/canvas/
 * widget-tool.ts`, MIT; written for Branch). The assistant proposes one — a title, a tool that only
 * looks something up, its settings, and how often to ask again — and the owner says yes or no.
 *
 * A widget that is accepted is a live page of bucket 23 (src/asks/live-surfaces.ts), nothing more: it
 * is shown in the same sealed frame (no script, no form, nothing fetched), and it is asked again as
 * unattended work, so only a call the approval rules allow outright is made. On top of that a widget
 * may only use a tool whose permission is a look-only one, so a widget can never change anything.
 */
export const WidgetSchema = z.object({
  title: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  everySeconds: z.number().int().min(30).max(86400).default(300),
  /** Why the assistant thinks this is worth keeping, in a sentence. */
  why: z.string().trim().min(1).max(300),
}).strict();

const ProposalSchema = WidgetSchema.extend({
  id: z.string().uuid(),
  fingerprint: z.string(),
  status: z.enum(["waiting", "accepted", "dismissed"]),
  surfaceId: z.string().nullable().default(null),
  at: z.string(),
});
export type WidgetProposal = z.infer<typeof ProposalSchema>;
const ListSchema = z.object({ items: z.array(ProposalSchema).max(80).default([]) }).strict();
/** Not "flowboards-widgets": that record is the part's switch. */
const listKey = "flowboards-widget-ideas";
const maxWaiting = 10;

export interface WidgetView { id: string; title: string; tool: string; everySeconds: number; frame: string; updatedAt: string | null; error: string | null }

export class Widgets {
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly registry: Pick<ToolRegistry, "names" | "permissionOf">, private readonly surfaces: LiveSurfaces) {}

  private items(): WidgetProposal[] { return partRecord(this.store, this.owner, listKey, ListSchema).items; }
  private saveItems(items: WidgetProposal[]): void {
    // Answered proposals are kept only as long as there is room; the oldest answered one goes first.
    const kept = [...items];
    while (kept.length > 60) {
      const oldest = kept.findIndex((item) => item.status === "dismissed");
      if (oldest < 0) break;
      kept.splice(oldest, 1);
    }
    this.store.save("settings", this.owner, listKey, { items: kept });
  }

  /** The assistant's proposal. Nothing is shown until the owner says yes. */
  propose(input: unknown): { id: string; status: "waiting" | "already asked" } {
    requirePart(this.store, this.owner, "widgets");
    const value = WidgetSchema.parse(input);
    if (!this.registry.names().includes(value.tool)) throw new Error(`There is no tool called ${value.tool}.`);
    const own = new Set<string>(Object.values(boardTools).flat());
    if (own.has(value.tool) || !isReadOnlyPermission(this.registry.permissionOf(value.tool)))
      throw new Error(`A widget can only use a tool that looks something up; ${value.tool} can change things.`);
    const fingerprint = createHash("sha256").update(JSON.stringify([value.tool, value.args])).digest("hex").slice(0, 24);
    const items = this.items();
    const same = items.find((item) => item.fingerprint === fingerprint && item.status !== "accepted");
    if (same) return { id: same.id, status: "already asked" };
    if (items.filter((item) => item.status === "waiting").length >= maxWaiting)
      throw new Error("There are already ten widget ideas waiting for the owner; wait for an answer first.");
    const proposal: WidgetProposal = { ...value, title: oneLine(value.title, 80), why: oneLine(value.why, 300),
      id: randomUUID(), fingerprint, status: "waiting", surfaceId: null, at: new Date().toISOString() };
    this.saveItems([...items, proposal]);
    return { id: proposal.id, status: "waiting" };
  }

  waiting(): WidgetProposal[] { return this.items().filter((item) => item.status === "waiting"); }

  /** The widgets that are showing, each with the address of its sealed frame. */
  list(): WidgetView[] {
    const ours = new Map(this.items().filter((item) => item.surfaceId).map((item) => [item.surfaceId!, item]));
    return this.surfaces.list().filter((surface) => ours.has(surface.id)).map((surface) => ({
      id: ours.get(surface.id)!.id, title: surface.title, tool: surface.tool, everySeconds: surface.everySeconds,
      frame: `/asks-surface/${surface.page}`, updatedAt: surface.updatedAt, error: surface.error,
    }));
  }

  /** The owner's answer. A yes makes the live page, which needs live pages switched on. */
  async decide(id: string, yes: boolean): Promise<{ id: string; status: string }> {
    requirePart(this.store, this.owner, "widgets");
    const items = this.items();
    const item = items.find((entry) => entry.id === id);
    if (!item || item.status !== "waiting") throw new Error("That widget idea is not waiting for an answer.");
    if (yes && askMode(this.store, this.owner, "live-surfaces") === "off")
      throw new Error(`Switch on "${askLabels["live-surfaces"]}" first; a widget is shown as one of those pages.`);
    if (yes) {
      const surface = await this.surfaces.add({ title: item.title, tool: item.tool, args: item.args, everySeconds: item.everySeconds });
      item.surfaceId = surface.id;
    }
    item.status = yes ? "accepted" : "dismissed";
    this.saveItems(items);
    return { id, status: item.status };
  }

  remove(id: string): { removed: boolean } {
    const items = this.items();
    const item = items.find((entry) => entry.id === id);
    if (!item) return { removed: false };
    if (item.surfaceId) this.surfaces.remove(item.surfaceId);
    this.saveItems(items.filter((entry) => entry.id !== id));
    return { removed: true };
  }
}

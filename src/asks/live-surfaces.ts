import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { appHeaders, appPage, mcpAppIn } from "../mcp-apps.js";
import type { Store } from "../store.js";
import { askMode, partSettings, requireAsk } from "./settings.js";

/**
 * A2240: live embedded app surfaces. A page a tool answers with (an MCP app, or a tool's plain
 * answer drawn as a page) can be pinned, and Branch asks the tool again on a timer so the page stays
 * up to date — a build status, a dashboard, a queue. The page is shown in the same sealed frame an
 * MCP app gets (no script, no form, nothing fetched), and the frame reloads itself with the
 * browser's own Refresh header, so nothing in the page needs to run.
 *
 * Asking the tool again goes through the one tool gate as work that runs by itself: only a call the
 * owner's rules allow outright is made. A call that would need a yes, or that is refused, leaves the
 * last page in place with the reason beside it. The frame's address is a long random name of its own,
 * because a frame cannot carry the session key; a new name is made when the surface is made again.
 */
export const SurfaceSchema = z.object({
  title: z.string().trim().min(1).max(80),
  tool: z.string().trim().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  everySeconds: z.number().int().min(30).max(86400).default(300),
}).strict();

export interface Surface extends z.infer<typeof SurfaceSchema> {
  id: string; page: string; html: string; updatedAt: string | null; error: string | null; dueAt: number;
}
const SavedSchema = z.object({ surfaces: z.array(z.object({ id: z.string(), page: z.string() }).merge(SurfaceSchema)).max(12).default([]) }).strict();
const savedKey = "asks-live-surfaces-list";
export const surfacePath = /^\/asks-surface\/([A-Za-z0-9_-]{32,48})$/;

const escape = (value: string): string => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** A tool's answer as a page: its MCP app when it sent one, otherwise its words, shown as text. */
export function surfaceHtml(result: unknown): string {
  const app = mcpAppIn(result);
  if (app) return app.html;
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return `<pre style="white-space:pre-wrap;word-break:break-word">${escape(String(text).slice(0, 100_000))}</pre>`;
}

export class LiveSurfaces {
  private readonly live = new Map<string, Surface>();
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly store: Store, private readonly owner: string,
    private readonly runTool: (name: string, args: unknown, surfaceId: string) => Promise<unknown>,
    private readonly now: () => number = Date.now) {
    for (const saved of partSettings(store, owner, savedKey, SavedSchema).surfaces)
      this.live.set(saved.id, { ...saved, html: "", updatedAt: null, error: null, dueAt: 0 });
  }
  private persist(): void {
    this.store.save("settings", this.owner, savedKey, { surfaces: [...this.live.values()].map(({ id, page, title, tool, args, everySeconds }) => ({ id, page, title, tool, args, everySeconds })) });
  }
  list(): Omit<Surface, "html" | "dueAt">[] {
    return [...this.live.values()].map(({ html: _html, dueAt: _due, ...rest }) => rest);
  }
  async add(input: unknown): Promise<Omit<Surface, "html" | "dueAt">> {
    requireAsk(this.store, this.owner, "live-surfaces");
    if (this.live.size >= 12) throw new Error("At most twelve live pages can be kept");
    const surface: Surface = { ...SurfaceSchema.parse(input), id: randomUUID(), page: randomBytes(24).toString("base64url"),
      html: "", updatedAt: null, error: null, dueAt: 0 };
    this.live.set(surface.id, surface);
    this.persist();
    await this.refresh(surface.id);
    return this.list().find((s) => s.id === surface.id)!;
  }
  remove(id: string): { removed: boolean } {
    const removed = this.live.delete(id);
    this.persist();
    return { removed };
  }
  /** Asks the tool again now. A refusal keeps the last page and says why. */
  async refresh(id: string): Promise<void> {
    const surface = this.live.get(id);
    if (!surface) throw new Error("That live page was not found");
    surface.dueAt = this.now() + surface.everySeconds * 1000;
    try {
      surface.html = surfaceHtml(await this.runTool(surface.tool, surface.args, surface.id));
      surface.updatedAt = new Date(this.now()).toISOString();
      surface.error = null;
    } catch (error) {
      surface.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    }
  }
  /** One beat: every surface that is due is asked again, one at a time. */
  async tick(): Promise<number> {
    if (askMode(this.store, this.owner, "live-surfaces") === "off") return 0;
    let refreshed = 0;
    for (const surface of [...this.live.values()]) {
      if (surface.dueAt > this.now()) continue;
      await this.refresh(surface.id);
      refreshed++;
    }
    return refreshed;
  }
  start(everyMs = 15000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), everyMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** The sealed page for a frame, answered before the session key is asked for. */
  serve(request: IncomingMessage, response: ServerResponse, path: string): boolean {
    const match = surfacePath.exec(path);
    if (!match || request.method !== "GET") return false;
    const surface = [...this.live.values()].find((s) => s.page === match[1]);
    if (!surface || askMode(this.store, this.owner, "live-surfaces") === "off") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "That live page is not there any more." }));
      return true;
    }
    const note = surface.error ? `<p style="border:1px solid;padding:.5rem">Not refreshed: ${escape(surface.error)}</p>` : "";
    const page = appPage({ server: surface.title, uri: surface.updatedAt ? `updated ${surface.updatedAt}` : "not loaded yet", html: note + surface.html });
    response.writeHead(200, { ...appHeaders(), refresh: String(Math.min(surface.everySeconds, 3600)) });
    response.end(page.body);
    return true;
  }
}

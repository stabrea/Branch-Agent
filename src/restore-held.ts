import { z } from "zod";
import { restoreHeldKey, type HeldRow } from "./backup.js";
import type { Store } from "./store.js";

/**
 * Q168 B: rows a restore took from a backup but did not put in place, because each says where the owner's
 * words go or who gets in (src/backup.ts `heldForTheOwner`). They wait here for the owner's yes, group by
 * group, and this computer's own value stays until then. The list lives in one setting that stays on this
 * computer, so a backup never carries it.
 */
const HeldRowSchema = z.object({ owner: z.string().min(1).max(200), id: z.string().min(1).max(200), data: z.string().max(4_000_000) }).strict();
const HeldListSchema = z.object({ rows: z.array(HeldRowSchema).max(500).default([]), restoredAt: z.string().nullable().default(null) }).strict();
const AnswerSchema = z.object({
  use: z.array(z.string().min(1).max(200)).max(500).default([]),
  keep: z.array(z.string().min(1).max(200)).max(500).default([]),
}).strict();

/** A model account is only half of where the owner's words go without its connection, so the two are one group. */
const groupOf = (id: string): string => (id === "model-connections" ? "accounts" : id);
export interface HeldGroup { group: string; ids: string[] }

export class RestoreHeld {
  constructor(private readonly store: Store) {}
  private get owner(): string { return this.store.profiles.ownerName; }
  private read(): z.infer<typeof HeldListSchema> {
    const saved = HeldListSchema.safeParse(this.store.get("settings", this.owner, restoreHeldKey)?.data ?? {});
    return saved.success ? saved.data : HeldListSchema.parse({});
  }
  private write(rows: HeldRow[]): void {
    if (rows.length) this.store.save("settings", this.owner, restoreHeldKey, { rows, restoredAt: new Date().toISOString() });
    else this.store.delete("settings", this.owner, restoreHeldKey);
  }
  /**
   * Adds what one restore held. A row the list already has (same owner and id) takes the newer file's value; the
   * rest of an earlier restore's list stays waiting, so a second restore never answers the first one's rows.
   */
  merge(held: readonly HeldRow[]): HeldGroup[] {
    if (held.length) {
      const key = (row: HeldRow) => `${row.owner}\u0000${row.id}`;
      const fresh = new Set(held.map(key));
      this.write([...this.read().rows.filter((row) => !fresh.has(key(row))), ...held]);
    }
    return this.groups();
  }
  /** What is waiting, grouped as the owner answers it. */
  groups(): HeldGroup[] {
    const groups = new Map<string, Set<string>>();
    for (const row of this.read().rows) groups.set(groupOf(row.id), (groups.get(groupOf(row.id)) ?? new Set()).add(row.id));
    return [...groups].map(([group, ids]) => ({ group, ids: [...ids].sort() }));
  }
  /** The owner's own list, from the owner's own window. */
  list(): { held: HeldGroup[] } {
    this.store.profiles.requireOwner("What a restore is waiting to hear about");
    return { held: this.groups() };
  }
  /**
   * The owner's answer: each group in `use` is put in place from the backup, each in `keep` is dropped and this
   * computer's own value stays. Anything not named keeps waiting. Checked for the owner inside, whoever calls.
   */
  answer(input: unknown): { used: string[]; kept: string[]; held: HeldGroup[] } {
    this.store.profiles.requireOwner("Answering what a restore is waiting to hear about");
    const { use, keep } = AnswerSchema.parse(input ?? {});
    const both = use.filter((group) => keep.includes(group));
    if (both.length) throw new Error(`Say either use or keep for ${both.join(", ")}, not both.`);
    const rows = this.read().rows, waiting = new Set(rows.map((row) => groupOf(row.id)));
    const unknown = [...use, ...keep].filter((group) => !waiting.has(group));
    if (unknown.length) throw new Error(`Nothing from a restore is waiting for ${unknown.join(", ")}.`);
    for (const row of rows.filter((one) => use.includes(groupOf(one.id))))
      this.store.save("settings", row.owner, row.id, JSON.parse(row.data) as Record<string, unknown>);
    this.write(rows.filter((row) => !use.includes(groupOf(row.id)) && !keep.includes(groupOf(row.id))));
    return { used: use, kept: keep, held: this.groups() };
  }
}

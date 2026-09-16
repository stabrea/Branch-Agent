import { z } from "zod";
import { errorText } from "./contracts.js";
import type { MemoryHygiene } from "./memory-hygiene.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import type { Store } from "./store.js";

/**
 * The quiet nightly pass over saved facts. Two things happen: every fact written since the last
 * pass is compared by meaning as well as by its words, so a question worded differently still
 * finds it; and facts that have come to say the same thing are written into the review queue as a
 * suggested merge. Nothing is ever deleted here — the owner accepts or ignores each suggestion,
 * which is the same rule the rest of memory tidying follows.
 */
export const ConsolidationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** How long between passes; a day by default, so it happens while nobody is waiting. */
  everyHours: z.number().int().min(1).max(168).default(24),
  lastRunAt: z.string().nullable().default(null),
}).strict();
export type ConsolidationSettings = z.infer<typeof ConsolidationSettingsSchema>;
export interface ConsolidationResult {
  embedded: number;
  /** Merges written into the review queue for the owner to accept or ignore. */
  proposed: number;
  /** Always zero: this pass never removes a fact by itself. */
  deleted: 0;
  ranAt: string;
  note: string;
}

export class MemoryConsolidation {
  constructor(
    private readonly store: Store,
    private readonly retrieval: MemoryRetrieval,
    private readonly hygiene: MemoryHygiene,
  ) {}
  settings(owner: string): ConsolidationSettings {
    const saved = ConsolidationSettingsSchema.safeParse(this.store.get("settings", owner, "memory-consolidation")?.data ?? {});
    return saved.success ? saved.data : ConsolidationSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): ConsolidationSettings {
    const value = ConsolidationSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "memory-consolidation", value);
    return value;
  }
  /** Whether enough time has passed since the last pass for another one to be worth doing. */
  due(owner: string, now: Date = new Date()): boolean {
    const settings = this.settings(owner);
    if (!settings.enabled) return false;
    if (!settings.lastRunAt) return true;
    return now.getTime() - Date.parse(settings.lastRunAt) >= settings.everyHours * 3_600_000;
  }
  /** Gives new facts their comparison by meaning; the cache means an unchanged fact costs nothing. */
  async embedNew(owner: string, signal = AbortSignal.timeout(60000)): Promise<number> {
    const result = await this.retrieval.index(owner, signal).catch(() => ({ embedded: 0, reason: "" }));
    return result.embedded;
  }
  /** One pass. Safe to call at any time; the nightly beat simply calls it when it is due. */
  async run(owner: string, now: Date = new Date(), signal = AbortSignal.timeout(120000)): Promise<ConsolidationResult> {
    const ranAt = now.toISOString();
    let embedded = 0, proposed = 0, note = "";
    try {
      embedded = await this.embedNew(owner, signal);
      proposed = this.hygiene.suggest(owner).staged.filter((entry) => entry.kind === "merge").length;
    } catch (error) { note = errorText(error).slice(0, 200); }
    this.configure(owner, { lastRunAt: ranAt });
    return { embedded, proposed, deleted: 0, ranAt, note };
  }
  /** The scheduler's beat: does nothing at all until a whole period has gone by. */
  async tick(owner: string, now: Date = new Date()): Promise<ConsolidationResult | null> {
    if (!this.due(owner, now)) return null;
    return this.run(owner, now).catch(() => null);
  }
}

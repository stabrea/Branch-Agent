import { z } from "zod";
import { factKindOf, layerOf, memoryHealth, type MemoryHealth } from "./memory-layers.js";
import type { MemoryHygiene, HygieneReview } from "./memory-hygiene.js";
import { memoryScope, visibleTo, writableTo, type MemoryRecord } from "./memory.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import type { Proposal } from "./memory-review.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * "Tidy my memory" as one thing the owner can run, rather than four checks spread across the app.
 * It looks for the same four troubles that creep in on their own — the same thing saved twice, a
 * fact a newer one contradicts, something not touched in a long time, and something nothing has
 * ever drawn on — and puts everything it finds in one list. It never removes anything: each finding
 * is written into the review queue as a suggestion, and the owner accepts or ignores it.
 */
export const staleAfterDays = 180;
export const TidySchema = z.object({
  /** Write what was found into the review queue as suggestions. Off simply reports. */
  stage: z.boolean().default(false),
  /** How long untouched counts as stale. */
  staleAfterDays: z.number().int().min(1).max(3650).default(staleAfterDays),
}).strict();
export interface TidyEntry { id: string; text: string; reason: string }
export interface TidyReport {
  duplicates: HygieneReview["duplicates"];
  contradictions: HygieneReview["contradictions"];
  stale: TidyEntry[];
  neverUsed: TidyEntry[];
  /** Notes made while doing a job that the job never finished clearing. */
  leftoverScratch: TidyEntry[];
  /** Suggestions written into the review queue; empty unless the owner asked to stage them. */
  staged: Proposal[];
  /** Always zero. Tidying proposes; the owner decides. */
  deleted: 0;
  health: MemoryHealth;
}

const summarise = (record: MemoryRecord, reason: string): TidyEntry => ({
  id: record.id, text: String(record.data.text).replace(/\s+/g, " ").slice(0, 200), reason,
});

export class MemoryTidy {
  constructor(
    readonly store: Store,
    private readonly hygiene: MemoryHygiene,
    private readonly retrieval?: MemoryRetrieval,
  ) {}
  /**
   * FQ-routing.isolated-agents: with `agent` set (a Trunk or delegated specialist) only the facts it
   * may read, the same rule memory.search keeps; the owner's own turn (no agent) sees every one.
   */
  private facts(owner: string, agent?: string): MemoryRecord[] {
    return (this.store.list("memory", owner) as MemoryRecord[]).filter((record) => visibleTo(record, agent));
  }
  private uses(owner: string): Map<string, number> { return this.retrieval?.useCounts(owner) ?? new Map(); }

  /** Counts only — never the wording of a fact — so this line is safe to hand to someone helping. */
  health(owner: string, agent?: string): MemoryHealth {
    const archived = this.store.archivedMemory(owner).filter((record) => visibleTo(record, agent)).length;
    return memoryHealth(this.facts(owner, agent), this.uses(owner), archived, this.store.memoryCapacity(owner));
  }
  /** Everything the four checks found, in one list. Nothing is changed unless `stage` is asked for. */
  run(owner: string, input: unknown = {}, now: number = Date.now(), agent?: string): TidyReport {
    const { stage, staleAfterDays: days } = TidySchema.parse(input ?? {});
    const records = this.facts(owner, agent), uses = this.uses(owner);
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const review = this.hygiene.review(owner, agent);
    const stale = records.filter((record) => record.updatedAt < cutoff)
      .map((record) => summarise(record, `Not touched since ${record.updatedAt.slice(0, 10)}.`)).slice(0, 20);
    const staleIds = new Set(stale.map((entry) => entry.id));
    const neverUsed = records.filter((record) => !(uses.get(record.id) ?? 0) && !staleIds.has(record.id))
      .map((record) => summarise(record, `Saved as a ${factKindOf(record)}, and never drawn on since.`)).slice(0, 20);
    const leftoverScratch = records.filter((record) => layerOf(record) === "task")
      .map((record) => summarise(record, "A note made while doing a job that is no longer running.")).slice(0, 20);
    return {
      duplicates: review.duplicates, contradictions: review.contradictions, stale, neverUsed, leftoverScratch,
      staged: stage ? this.stage(owner, stale, leftoverScratch, agent) : [], deleted: 0, health: this.health(owner, agent),
    };
  }
  /**
   * Writes the findings into the review queue. The duplicate and contradiction suggestions come
   * from the existing tidying pass, so a finding is never staged twice; the stale and leftover ones
   * are added here. Every one of them sets a fact aside in the archive, where it can be brought
   * back — nothing is deleted by accepting a suggestion. An agent's tidy stages only facts that agent
   * may change (`writableTo`, the rule memory.update keeps): a Trunk reads shared facts, but a
   * suggestion to archive one is not its to make.
   */
  private stage(owner: string, stale: TidyEntry[], leftover: TidyEntry[], agent?: string): Proposal[] {
    const staged = [...this.hygiene.suggest(owner, agent).staged];
    const covered = new Set(this.store.review.proposals(owner, "pending")
      .flatMap((proposal) => [proposal.memoryId, ...proposal.memoryIds].filter(Boolean) as string[]));
    for (const entry of [...stale, ...leftover]) {
      if (covered.has(entry.id) || !writableTo(this.store.get("memory", owner, entry.id), agent)) continue;
      covered.add(entry.id);
      staged.push(this.store.review.propose(owner, { kind: "archive", memoryIds: [entry.id],
        source: "Suggested while tidying memory", note: entry.reason }));
    }
    return staged;
  }
}

/** The shipped procedure the owner runs from the Memory screen; its one step is the tool below. */
export const tidyProcedureId = "0b9a1d7e-5c41-4f2a-9e3b-6d2f8a71d905";
export const tidyProcedureName = "Tidy my memory";
/**
 * Puts the shipped procedure in the owner's list if it is not already there. It is written down so
 * the owner can see exactly what tidying does, and it stays a proposal: the recipe checker compares
 * a step's whole result against a fixed expectation, and a tidy report says what it found, which is
 * different every time. So this one cannot be certified that way and is run from the Memory screen
 * or by calling `memory.tidy` — which is also why its step only looks, and stages nothing: checking
 * the recipe must never leave a pile of suggestions behind.
 */
export function shipTidyProcedure(store: Store, owner: string): void {
  if (store.get("procedures", owner, tidyProcedureId)) return;
  store.save("procedures", owner, tidyProcedureId, {
    version: 1, status: "proposed", history: [],
    definition: {
      id: tidyProcedureId, name: tidyProcedureName, preconditions: [], parameters: {},
      steps: [{ tool: "memory.tidy", args: { stage: false }, expected: { deleted: 0 } }],
    },
  });
}

export function registerMemoryTidy(registry: ToolRegistry, tidy: MemoryTidy): void {
  registry.register({
    name: "memory.tidy", permission: "memory.write",
    description: "Find repeated, contradicting, stale and never-used facts. Suggests only; deletes nothing.",
    parameters: TidySchema,
    execute: async (input, context) => tidy.run(memoryScope(tidy.store, context), input, Date.now(), context.agent),
  });
  // There is deliberately no separate health tool: `memory.tidy` already returns the same counts,
  // and the Memory screen and the diagnostics folder read them through `GET /api/memory/health`.
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FactKindSchema } from "./memory-layers.js";
import type { MemoryConsolidation } from "./memory-consolidate.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import type { Store } from "./store.js";

/**
 * Measuring whether memory actually finds the right fact. The set is a plain file of made-up facts
 * and the questions they ought to answer, kept in `data/memory-retrieval.json` so the owner can
 * replace it with their own. Running it saves the facts under a scope of their own, asks every
 * question, runs the nightly pass, and asks again — so the number says whether that pass helped.
 * The scope is emptied afterwards, so nothing the owner actually saved is touched at any point.
 */
export const evaluationOwner = "memory-evaluation";
const FactSchema = z.object({
  id: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(4000),
  kind: FactKindSchema.optional(),
}).strict();
export const MemorySetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  note: z.string().max(1000).default(""),
  facts: z.array(FactSchema).min(1).max(200),
  questions: z.array(z.object({
    ask: z.string().trim().min(1).max(300),
    expect: z.array(z.string().min(1).max(200)).min(1).max(10),
  }).strict()).min(1).max(200),
}).strict();
export type MemorySet = z.infer<typeof MemorySetSchema>;

export interface QuestionResult { ask: string; found: boolean; rank: number | null; foundAfter: boolean }
export interface MemoryEvaluation {
  name: string;
  questions: number;
  /** How many questions the right fact came back for, before the nightly pass and after it. */
  hitRateBefore: number;
  hitRateAfter: number;
  /** Where the right fact sat on average when it was found; 1 means it was first. */
  meanRank: number | null;
  /** Empty when comparing by meaning was available; otherwise why it was not. */
  meaningSearch: string;
  results: QuestionResult[];
}

/** Where the set lives: next to the built program when packaged, else the project's own folder. */
export function memorySetPaths(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [join(here, "memory-retrieval.json"), join(here, "..", "data", "memory-retrieval.json")];
}
/** The owner's set if they have replaced it, otherwise the one that ships. */
export function loadMemorySet(paths: string[] = memorySetPaths()): MemorySet {
  for (const path of paths) {
    let contents: unknown;
    try { contents = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const parsed = MemorySetSchema.safeParse(contents);
    if (!parsed.success) throw new Error(`${path} is not a valid memory set: ${parsed.error.issues[0]?.message ?? "unknown problem"}`);
    return parsed.data;
  }
  throw new Error("No memory set was found. Put one at data/memory-retrieval.json.");
}

const hitRate = (hits: number, total: number): number => Number((total ? hits / total : 0).toFixed(4));

/**
 * One pass over the set. `topK` is how far down the answers a fact still counts as found, which is
 * the same question the assistant faces: a fact that comes back tenth is no use to it.
 */
export async function runMemoryEvaluation(
  store: Store, retrieval: MemoryRetrieval, consolidation: MemoryConsolidation,
  set: MemorySet = loadMemorySet(), topK = 3,
): Promise<MemoryEvaluation> {
  clearEvaluationScope(store);
  try {
    for (const fact of set.facts)
      store.save("memory", evaluationOwner, fact.id, {
        text: fact.text, source: "Memory evaluation set", ...(fact.kind ? { kind: fact.kind } : {}),
      });
    const before = await ask(retrieval, set, topK);
    await consolidation.embedNew(evaluationOwner).catch(() => undefined);
    const after = await ask(retrieval, set, topK);
    const ranks = before.filter((row) => row.rank !== null).map((row) => row.rank!);
    return {
      name: set.name, questions: set.questions.length,
      hitRateBefore: hitRate(before.filter((row) => row.found).length, set.questions.length),
      hitRateAfter: hitRate(after.filter((row) => row.found).length, set.questions.length),
      meanRank: ranks.length ? Number((ranks.reduce((total, rank) => total + rank, 0) / ranks.length).toFixed(2)) : null,
      meaningSearch: retrieval.meaningSearchReady(evaluationOwner) ? "" : "Facts were matched by their words only: no connected model can compare them by meaning.",
      results: before.map((row, at) => ({ ...row, foundAfter: after[at]?.found ?? false })),
    };
  } finally { clearEvaluationScope(store); }
}
async function ask(retrieval: MemoryRetrieval, set: MemorySet, topK: number): Promise<QuestionResult[]> {
  const results: QuestionResult[] = [];
  for (const question of set.questions) {
    const hits = await retrieval.search(evaluationOwner, question.ask, undefined, topK).catch(() => []);
    const at = hits.findIndex((hit) => question.expect.includes(hit.record.id));
    results.push({ ask: question.ask, found: at >= 0, rank: at >= 0 ? at + 1 : null, foundAfter: false });
  }
  return results;
}
/** Empties the scope the set uses, before and after, so a run never leaves anything behind. */
export function clearEvaluationScope(store: Store): void {
  for (const record of store.list("memory", evaluationOwner)) store.delete("memory", evaluationOwner, record.id);
}

import { z } from "zod";
import { errorText } from "./contracts.js";
import type { DocumentLibrary } from "./documents.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import type { ModelRouter } from "./models.js";
import type { Store } from "./store.js";

/**
 * One way of finding passages, whatever they are made of. The document library and the saved facts
 * both answer the same question — "which passages fit this?" — so they are both put behind the same
 * small interface, and anything that wants passages asks a retriever rather than one library.
 *
 * On top of that sits a second pass that puts the best answer first. By default that is done here
 * on this computer by counting words, which costs nothing and always gives the same order. The
 * owner can instead have the model read the top twenty and pick the best five; that is one extra
 * request per search, so it stays off until they turn it on.
 */
export interface RetrievedPassage {
  /** Unique within one search, so two retrievers' answers can be merged. */
  key: string;
  /** Where it came from, in words: a document's name or "your saved notes". */
  source: string;
  text: string;
  score: number;
  /** Which retriever found it. */
  from: string;
}
export interface Retriever {
  readonly id: string;
  readonly label: string;
  retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]>;
}

export const RerankSettingsSchema = z.object({
  /** "words" counts matching words here; "model" asks the model to choose. */
  mode: z.enum(["words", "model"]).default("words"),
  /** How many passages the second pass looks at. */
  candidates: z.number().int().min(2).max(50).default(20),
  /** How many it keeps. */
  keep: z.number().int().min(1).max(20).default(5),
}).strict();
export type RerankSettings = z.infer<typeof RerankSettingsSchema>;

const words = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * Puts the passages that use more of the question's words first. Ties keep the order they arrived
 * in, so the same passages always come back in the same order.
 */
export function lexicalRerank(query: string, passages: RetrievedPassage[], keep: number): RetrievedPassage[] {
  const wanted = [...new Set(words(query))];
  if (!wanted.length) return passages.slice(0, keep);
  const scored = passages.map((passage, at) => {
    const found = words(passage.text);
    const counts = new Map<string, number>();
    for (const word of found) counts.set(word, (counts.get(word) ?? 0) + 1);
    const covered = wanted.filter((word) => counts.has(word)).length;
    const density = wanted.reduce((sum, word) => sum + Math.log1p(counts.get(word) ?? 0), 0) / Math.log1p(found.length + 1);
    return { passage, at, score: Number((covered / wanted.length + density).toFixed(6)) };
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, keep).map((entry) => ({ ...entry.passage, score: entry.score }));
}

const rerankInstructions =
  "You are choosing which passages answer a question best. Reply with JSON only: {\"order\":[2,0,5]} listing the numbers of the most useful passages, best first, at most the number asked for. No prose.";

/** Asks the model once to pick the best passages. Anything unexpected falls back to the word order. */
export async function modelRerank(
  models: ModelRouter, owner: string, query: string, passages: RetrievedPassage[], keep: number,
  signal: AbortSignal = AbortSignal.timeout(20000),
): Promise<{ passages: RetrievedPassage[]; calls: number; note: string }> {
  const provider = models.plan(owner, "").candidates[0]?.provider;
  if (!provider) return { passages: lexicalRerank(query, passages, keep), calls: 0, note: "no model is connected" };
  const listed = passages.map((passage, at) => `${at}. ${passage.text.replace(/\s+/g, " ").slice(0, 600)}`).join("\n");
  try {
    const completion = await provider.complete({
      messages: [
        { role: "system", content: rerankInstructions },
        { role: "user", content: `Question: ${query.slice(0, 500)}\nKeep at most ${keep}.\nPassages:\n${listed}` },
      ],
      tools: [], maxTokens: 200, signal,
    });
    const order = readOrder(completion.content, passages.length).slice(0, keep);
    if (!order.length) return { passages: lexicalRerank(query, passages, keep), calls: 1, note: "the model gave no usable order" };
    return { passages: order.map((at, rank) => ({ ...passages[at]!, score: Number((1 / (rank + 1)).toFixed(6)) })), calls: 1, note: "" };
  } catch (error) {
    return { passages: lexicalRerank(query, passages, keep), calls: 1, note: errorText(error).slice(0, 200) };
  }
}
/** The numbers in the model's answer, kept only where they point at a real passage and appear once. */
function readOrder(content: string, count: number): number[] {
  const body = /\{[\s\S]*\}/.exec(content)?.[0] ?? "";
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  const raw = (parsed as { order?: unknown })?.order;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  return raw.map(Number).filter((at) => Number.isInteger(at) && at >= 0 && at < count && !seen.has(at) && seen.add(at) !== undefined);
}

/** The document library behind the common interface. */
export class DocumentRetriever implements Retriever {
  readonly id = "documents";
  readonly label = "Your documents";
  constructor(private readonly library: DocumentLibrary) {}
  async retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]> {
    const results = await this.library.search(owner, { query: query.slice(0, 500), limit: Math.min(limit, 10) },
      signal ?? AbortSignal.timeout(30000));
    return results.map((row) => ({
      key: `documents:${row.documentId}:${row.passage}`, source: row.source,
      text: row.text, score: row.score, from: this.id,
    }));
  }
}
/** The saved facts behind the common interface. */
export class MemoryRetriever implements Retriever {
  readonly id = "memory";
  readonly label = "Your saved notes";
  constructor(private readonly retrieval: MemoryRetrieval) {}
  async retrieve(owner: string, query: string, limit: number, signal?: AbortSignal): Promise<RetrievedPassage[]> {
    const hits = await this.retrieval.search(owner, query, undefined, limit, signal ?? AbortSignal.timeout(20000));
    return hits.map((hit) => ({
      key: `memory:${hit.record.id}`, source: "your saved notes",
      text: String((hit.record.data as { text?: unknown }).text ?? ""), score: hit.score, from: this.id,
    }));
  }
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** How the second pass ordered them, and how many model requests it took (0 or 1). */
  reranked: RerankSettings["mode"];
  rerankCalls: number;
  note: string;
}

/** Every retriever together, with the second pass applied once over their combined answers. */
export class Retrieval {
  private readonly retrievers: Retriever[] = [];
  constructor(private readonly store: Store, private readonly owner: string, private readonly models?: ModelRouter) {}
  add(retriever: Retriever): void { this.retrievers.push(retriever); }
  list(): { id: string; label: string }[] { return this.retrievers.map((r) => ({ id: r.id, label: r.label })); }
  settings(owner: string): RerankSettings {
    const saved = RerankSettingsSchema.safeParse(this.store.get("settings", owner, "reranking")?.data ?? {});
    return saved.success ? saved.data : RerankSettingsSchema.parse({});
  }
  configure(owner: string, input: unknown): RerankSettings {
    const value = RerankSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "reranking", value);
    return value;
  }
  view(owner: string) {
    return { settings: this.settings(owner), retrievers: this.list(), modelRerankReady: Boolean(this.models) };
  }
  /** Asks every retriever, merges what they found, then puts the best first. */
  async search(owner: string, query: string, signal?: AbortSignal): Promise<RetrievalResult> {
    const settings = this.settings(owner);
    const found = await Promise.all(this.retrievers.map((retriever) =>
      retriever.retrieve(owner, query, settings.candidates, signal).catch(() => [] as RetrievedPassage[])));
    const merged = new Map<string, RetrievedPassage>();
    for (const passage of found.flat().sort((a, b) => b.score - a.score))
      if (!merged.has(passage.key)) merged.set(passage.key, passage);
    const candidates = [...merged.values()].slice(0, settings.candidates);
    if (!candidates.length) return { passages: [], reranked: settings.mode, rerankCalls: 0, note: "" };
    return this.rerank(owner, query, candidates, settings, signal);
  }
  private async rerank(owner: string, query: string, candidates: RetrievedPassage[], settings: RerankSettings, signal?: AbortSignal): Promise<RetrievalResult> {
    if (settings.mode === "model" && this.models) {
      const chosen = await modelRerank(this.models, owner, query, candidates, settings.keep, signal ?? AbortSignal.timeout(20000));
      return { passages: chosen.passages, reranked: "model", rerankCalls: chosen.calls, note: chosen.note };
    }
    return { passages: lexicalRerank(query, candidates, settings.keep), reranked: "words", rerankCalls: 0, note: "" };
  }
  /** Puts an already-found list in the best order, for the libraries that search on their own. */
  async order(owner: string, query: string, passages: RetrievedPassage[], signal?: AbortSignal): Promise<RetrievedPassage[]> {
    if (!passages.length) return passages;
    const settings = this.settings(owner);
    return (await this.rerank(owner, query, passages.slice(0, settings.candidates), settings, signal)).passages;
  }
  /** The owner this retrieval belongs to, for callers that hold only the façade. */
  get defaultOwner(): string { return this.owner; }
}

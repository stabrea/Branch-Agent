/**
 * Marking a search rather than an answer: given a question and the documents that were handed
 * back, in order, how good was that list. These are the four measures every published retrieval
 * set is reported with, worked out here with no library so a number from Branch can be put beside
 * a number in a paper.
 *
 * It also reads the BEIR layout — `corpus.jsonl`, `queries.jsonl` and `qrels/<split>.tsv` — from a
 * folder on this computer. Nothing is downloaded: the owner puts a set in a folder and points at
 * it, exactly as every other benchmark here works.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** How relevant each document is to one question. A document not named here counts as zero. */
export type Relevance = ReadonlyMap<string, number>;

const cut = <T>(ranked: readonly T[], k: number): readonly T[] => (k > 0 ? ranked.slice(0, k) : ranked);
const round = (value: number): number => Math.round(value * 10000) / 10000;

/** Of the first k handed back, the share that are relevant at all. */
export function precisionAt(ranked: readonly string[], relevance: Relevance, k: number): number {
  const top = cut(ranked, k);
  if (!top.length) return 0;
  return round(top.filter((id) => (relevance.get(id) ?? 0) > 0).length / top.length);
}

/** Of the documents that are relevant, the share that turned up in the first k. */
export function recallAt(ranked: readonly string[], relevance: Relevance, k: number): number {
  const wanted = [...relevance.values()].filter((grade) => grade > 0).length;
  if (!wanted) return 0;
  return round(cut(ranked, k).filter((id) => (relevance.get(id) ?? 0) > 0).length / wanted);
}

/** One over the place the first relevant document came in. Nothing relevant at all gives zero. */
export function reciprocalRank(ranked: readonly string[], relevance: Relevance): number {
  const place = ranked.findIndex((id) => (relevance.get(id) ?? 0) > 0);
  return place < 0 ? 0 : round(1 / (place + 1));
}

/** The mean of the above over several questions. */
export function meanReciprocalRank(questions: readonly { ranked: readonly string[]; relevance: Relevance }[]): number {
  if (!questions.length) return 0;
  return round(questions.reduce((total, one) => total + reciprocalRank(one.ranked, one.relevance), 0) / questions.length);
}

/** Precision measured at every place a relevant document turned up, averaged. */
export function averagePrecision(ranked: readonly string[], relevance: Relevance, k = 0): number {
  const wanted = [...relevance.values()].filter((grade) => grade > 0).length;
  if (!wanted) return 0;
  let found = 0, total = 0;
  cut(ranked, k).forEach((id, index) => {
    if ((relevance.get(id) ?? 0) > 0) { found += 1; total += found / (index + 1); }
  });
  return round(total / Math.min(wanted, k > 0 ? k : wanted));
}

const discounted = (grades: readonly number[]): number =>
  grades.reduce((total, grade, index) => total + grade / Math.log2(index + 2), 0);

/**
 * Normalised discounted cumulative gain: the usual measure, because it rewards putting the most
 * relevant document first rather than merely somewhere in the list. A question with nothing
 * relevant scores zero rather than dividing by nothing.
 */
export function ndcgAt(ranked: readonly string[], relevance: Relevance, k: number): number {
  const got = cut(ranked, k).map((id) => relevance.get(id) ?? 0);
  const best = [...relevance.values()].filter((grade) => grade > 0).sort((a, b) => b - a);
  const ideal = discounted(cut(best, k));
  return ideal === 0 ? 0 : round(discounted(got) / ideal);
}

export interface RetrievalScore {
  questions: number;
  k: number;
  ndcg: number; recall: number; precision: number; mrr: number; map: number;
}

/** Every measure over a whole set of questions, which is how a retrieval set is reported. */
export function scoreRetrieval(
  questions: readonly { ranked: readonly string[]; relevance: Relevance }[], k = 10,
): RetrievalScore {
  const mean = (of: (one: { ranked: readonly string[]; relevance: Relevance }) => number): number =>
    questions.length ? round(questions.reduce((total, one) => total + of(one), 0) / questions.length) : 0;
  return {
    questions: questions.length, k,
    ndcg: mean((one) => ndcgAt(one.ranked, one.relevance, k)),
    recall: mean((one) => recallAt(one.ranked, one.relevance, k)),
    precision: mean((one) => precisionAt(one.ranked, one.relevance, k)),
    mrr: meanReciprocalRank(questions),
    map: mean((one) => averagePrecision(one.ranked, one.relevance, k)),
  };
}

/** The table a person reads. One row, because one set of questions gives one of each measure. */
export function retrievalTable(score: RetrievalScore, name = "This search"): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `| Search | Questions | nDCG@${score.k} | Recall@${score.k} | Precision@${score.k} | MRR | MAP |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${name} | ${score.questions} | ${percent(score.ndcg)} | ${percent(score.recall)} | ${percent(score.precision)} | ${percent(score.mrr)} | ${percent(score.map)} |`,
  ].join("\n");
}

/* ------------------------------------------------------------------- reading a set */

export interface BeirSet {
  /** Every document, by its id, with its title and its text. */
  documents: Map<string, { title: string; text: string }>;
  queries: Map<string, string>;
  /** For each question, how relevant each named document is. */
  relevance: Map<string, Map<string, number>>;
}

/** One JSON Lines file as records. A damaged line is named by its number rather than swallowed. */
async function jsonl(path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let line = 0;
  for (const raw of (await readFile(path, "utf8")).split(/\r?\n/)) {
    line += 1;
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw) as Record<string, unknown>); }
    catch { throw new Error(`${path} line ${line} is not readable JSON`); }
  }
  return out;
}

const text = (raw: Record<string, unknown>, ...names: string[]): string => {
  for (const name of names) if (typeof raw[name] === "string") return raw[name];
  return "";
};

/**
 * A BEIR-shaped set read from a folder already on this computer: `corpus.jsonl` with `_id`, `title`
 * and `text`; `queries.jsonl` with `_id` and `text`; and `qrels/<split>.tsv`, which is the
 * benchmark's own tab-separated file with a header line and then question, document, grade.
 */
export async function readBeirSet(directory: string, split = "test"): Promise<BeirSet> {
  const documents = new Map<string, { title: string; text: string }>();
  for (const raw of await jsonl(join(directory, "corpus.jsonl"))) {
    const id = text(raw, "_id", "id", "doc_id");
    if (id) documents.set(id, { title: text(raw, "title"), text: text(raw, "text", "contents") });
  }
  const queries = new Map<string, string>();
  for (const raw of await jsonl(join(directory, "queries.jsonl"))) {
    const id = text(raw, "_id", "id", "query_id");
    if (id) queries.set(id, text(raw, "text", "query"));
  }
  return { documents, queries, relevance: await readQrels(join(directory, "qrels", `${split}.tsv`)) };
}

/** The grades file. The first line is a header when it is not three fields of the right shape. */
export async function readQrels(path: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const raw of (await readFile(path, "utf8")).split(/\r?\n/)) {
    const parts = raw.split(/\t|\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const grade = Number(parts[2]);
    if (!Number.isFinite(grade)) continue;
    const forQuery = out.get(parts[0]!) ?? new Map<string, number>();
    forQuery.set(parts[1]!, grade);
    out.set(parts[0]!, forQuery);
  }
  return out;
}

/**
 * The set scored against whatever handed back a ranked list of document ids. The search is passed
 * in, so this never decides how searching is done and can mark any of them.
 */
export async function scoreBeirSet(
  set: BeirSet, search: (query: string, id: string) => Promise<readonly string[]>, k = 10,
): Promise<RetrievalScore> {
  const questions: { ranked: readonly string[]; relevance: Relevance }[] = [];
  for (const [id, query] of set.queries) {
    const relevance = set.relevance.get(id);
    if (!relevance) continue;
    questions.push({ ranked: await search(query, id), relevance });
  }
  return scoreRetrieval(questions, k);
}

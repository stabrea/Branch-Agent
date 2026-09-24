import { z } from "zod";
import { cosine } from "./document-embeddings.js";
import { visibleTo, writableTo, type MemoryRecord } from "./memory.js";
import type { MemoryRetrieval } from "./memory-retrieval.js";
import { importanceOf } from "./memory-retrieval.js";
import type { Proposal } from "./memory-review.js";
import type { Store } from "./store.js";

/**
 * Keeping saved facts tidy. Three things go wrong on their own over time: the same thing gets
 * saved twice in slightly different words, a fact is contradicted by a newer one, and the store
 * fills up with things that were never useful. This looks for all three and writes each one into
 * the review queue as a suggestion. Nothing is ever removed here; the owner decides, and an
 * accepted suggestion sets the fact aside in the archive where it can be brought back.
 */
export interface DuplicateGroup { keep: string; drop: string[]; texts: string[]; similarity: number; by: "words" | "meaning" }
export interface ContradictionPair { subject: string; newer: { id: string; text: string }; older: { id: string; text: string } }
export interface ForgetCandidate { id: string; text: string; importance: number; uses: number }
export interface HygieneReview {
  duplicates: DuplicateGroup[];
  contradictions: ContradictionPair[];
  leastUseful: ForgetCandidate[];
  capacity: { count: number; maxFacts: number; nearlyFull: boolean };
}
export const nearDuplicateWords = 0.8;
export const nearDuplicateMeaning = 0.92;
/** The store counts as nearly full at this share of the configured limit. */
export const nearlyFullAt = 0.9;

const factText = (record: MemoryRecord): string => String(record.data.text ?? "");
/**
 * Whose a fact is. Tidying never groups facts that belong to different people: a merge writes the longest wording onto
 * the fact it keeps, so the owner's private words landed in a Trunk's fact, where the Trunk could read them, and a
 * newer fact of one person's set another's aside (Mac mini 5c2e4f6).
 */
const scopeOf = (record: MemoryRecord): string => String(record.data.scope ?? "private");
/** Same words, ignoring case, accents, punctuation and filler spacing. */
export function normaliseFact(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
/** How alike two pieces of text are, from the words they share (1 means the same words). */
export function wordSimilarity(a: string, b: string): number {
  const left = new Set(normaliseFact(a).split(" ").filter(Boolean));
  const right = new Set(normaliseFact(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return Number(((2 * shared) / (left.size + right.size)).toFixed(4));
}
/** Labels that head a list rather than name a subject; two notes do not disagree with each other. */
export const listLabels = ["note", "notes", "todo", "task", "reminder", "idea", "tip", "question", "fyi"];
/**
 * Who or what a fact is about: its entity and detail, or the label before the colon in its text.
 * A one-word label ("Address:") is too loose to tell a changed fact from an unrelated one, so only
 * a label of two or more words counts, and never one that heads a list.
 */
export function subjectOf(record: MemoryRecord): string | null {
  const data = record.data as { entity?: string; attribute?: string; text?: string };
  if (data.entity) return normaliseFact(`${data.entity} ${data.attribute ?? ""}`);
  const text = String(data.text ?? ""), label = text.split(":")[0] ?? "";
  if (!label || label.length > 80 || label.length >= text.length) return null;
  const words = normaliseFact(label).split(" ").filter(Boolean);
  if (words.length < 2 || listLabels.includes(words[0]!)) return null;
  return words.join(" ");
}
/** What a fact claims about its subject: the part after the colon, or the whole text. */
export function claimOf(record: MemoryRecord): string {
  const text = factText(record), at = text.indexOf(":");
  const data = record.data as { entity?: string };
  return normaliseFact(data.entity !== undefined || at < 0 ? text : text.slice(at + 1));
}
const current = (record: MemoryRecord): boolean => (record.data as { validTo?: string | null }).validTo == null;
const startedAt = (record: MemoryRecord): string => String((record.data as { validFrom?: string }).validFrom ?? record.createdAt);

export class MemoryHygiene {
  constructor(private readonly store: Store, private readonly retrieval?: MemoryRetrieval) {}
  private facts(owner: string): MemoryRecord[] { return this.store.list("memory", owner) as MemoryRecord[]; }

  /**
   * What looks wrong right now. Reading only: nothing is changed and nothing is staged.
   * FQ-routing.isolated-agents: with `agent` set (a Trunk or delegated specialist) it looks only at
   * the facts that agent may read, exactly as memory.search does; the owner's own turn sees them all.
   */
  review(owner: string, agent?: string): HygieneReview {
    return this.reviewOf(owner, this.facts(owner).filter((record) => visibleTo(record, agent)));
  }
  private reviewOf(owner: string, records: MemoryRecord[]): HygieneReview {
    const capacity = this.store.memoryCapacity(owner);
    const nearlyFull = capacity.count >= Math.floor(capacity.maxFacts * nearlyFullAt);
    return {
      duplicates: this.duplicates(owner, records), contradictions: this.contradictions(records),
      leastUseful: nearlyFull ? this.leastUseful(owner, records) : [],
      capacity: { ...capacity, nearlyFull },
    };
  }
  /** Facts that say the same thing twice, by their words or (where vectors exist) by meaning. */
  duplicates(owner: string, records = this.facts(owner)): DuplicateGroup[] {
    const vectors = this.retrieval?.vectors(owner) ?? new Map();
    const groups: DuplicateGroup[] = [], taken = new Set<string>();
    for (let i = 0; i < records.length; i++) {
      const left = records[i]!;
      if (taken.has(left.id)) continue;
      const drop: string[] = [], texts = [factText(left)];
      let similarity = 0, by: DuplicateGroup["by"] = "words";
      for (let j = i + 1; j < records.length; j++) {
        const right = records[j]!;
        if (taken.has(right.id) || scopeOf(right) !== scopeOf(left)) continue;
        const alike = this.alike(left, right, vectors);
        if (!alike) continue;
        drop.push(right.id); texts.push(factText(right)); taken.add(right.id);
        if (alike.score > similarity) { similarity = alike.score; by = alike.by; }
      }
      if (drop.length) { taken.add(left.id); groups.push({ keep: left.id, drop, texts, similarity, by }); }
    }
    return groups.slice(0, 20);
  }
  private alike(left: MemoryRecord, right: MemoryRecord, vectors: Map<string, Float32Array>): { score: number; by: DuplicateGroup["by"] } | null {
    const words = wordSimilarity(factText(left), factText(right));
    if (words >= nearDuplicateWords) return { score: words, by: "words" };
    const a = vectors.get(left.id), b = vectors.get(right.id);
    if (!a || !b) return null;
    const meaning = cosine(a, b);
    return meaning >= nearDuplicateMeaning ? { score: Number(meaning.toFixed(4)), by: "meaning" } : null;
  }
  /** Two facts still described as true that say different things about the same subject. */
  contradictions(records: MemoryRecord[]): ContradictionPair[] {
    const bySubject = new Map<string, MemoryRecord[]>();
    for (const record of records.filter(current)) {
      const subject = subjectOf(record);
      if (!subject) continue;
      const key = `${scopeOf(record)}\u0000${subject}`;
      bySubject.set(key, [...(bySubject.get(key) ?? []), record]);
    }
    const pairs: ContradictionPair[] = [];
    for (const [key, group] of bySubject) {
      const subject = key.slice(key.indexOf("\u0000") + 1);
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) => startedAt(a).localeCompare(startedAt(b)) || a.updatedAt.localeCompare(b.updatedAt));
      const newest = ordered.at(-1)!;
      for (const older of ordered.slice(0, -1)) {
        if (claimOf(older) === claimOf(newest) || wordSimilarity(factText(older), factText(newest)) >= nearDuplicateWords) continue;
        pairs.push({ subject, newer: { id: newest.id, text: factText(newest) }, older: { id: older.id, text: factText(older) } });
      }
    }
    return pairs.slice(0, 20);
  }
  /** The facts that have earned their place least, for when the store is nearly full. */
  leastUseful(owner: string, records = this.facts(owner), count = 3): ForgetCandidate[] {
    const uses = this.retrieval?.useCounts(owner) ?? new Map<string, number>();
    return records
      .map((record) => ({ id: record.id, text: factText(record), uses: uses.get(record.id) ?? 0, importance: importanceOf(record, uses.get(record.id) ?? 0) }))
      .sort((a, b) => a.importance - b.importance).slice(0, count);
  }

  /** Writes what it found into the review queue. Facts are only ever changed once the owner accepts. */
  /** With `agent` set, only facts that agent may change are suggested (`writableTo`, like memory.update). */
  suggest(owner: string, agent?: string): { staged: Proposal[]; review: HygieneReview } {
    const review = this.reviewOf(owner, this.facts(owner).filter((record) => writableTo(record, agent))), staged: Proposal[] = [];
    const pending = this.store.review.proposals(owner, "pending");
    const covered = new Set(pending.flatMap((p) => [p.memoryId, ...p.memoryIds].filter(Boolean) as string[]));
    for (const group of review.duplicates) {
      if (group.drop.some((id) => covered.has(id)) || covered.has(group.keep)) continue;
      staged.push(this.store.review.propose(owner, { kind: "merge", memoryId: group.keep, memoryIds: group.drop,
        text: mergedText(group.texts), source: "Suggested while tidying memory",
        note: `These ${group.texts.length} facts say the same thing (${group.by === "meaning" ? "same meaning" : "same words"}). Keeping one and setting the rest aside.` }));
    }
    for (const pair of review.contradictions) {
      if (covered.has(pair.older.id)) continue;
      staged.push(this.store.review.propose(owner, { kind: "archive", memoryIds: [pair.older.id],
        source: "Suggested while tidying memory", note: `A newer fact says “${pair.newer.text.slice(0, 120)}”, so this older one is out of date.` }));
    }
    for (const candidate of review.leastUseful) {
      if (covered.has(candidate.id)) continue;
      staged.push(this.store.review.propose(owner, { kind: "forget", memoryIds: [candidate.id],
        source: "Suggested while tidying memory", note: `Memory is nearly full and this has been used ${candidate.uses} time(s) since it was saved.` }));
    }
    return { staged, review };
  }
}
/** The longest wording is kept, because it usually carries the most detail. */
export function mergedText(texts: string[]): string {
  return [...texts].sort((a, b) => b.length - a.length)[0]!.slice(0, 4000);
}
export const HygieneRequestSchema = z.object({ stage: z.boolean().default(false) }).strict();

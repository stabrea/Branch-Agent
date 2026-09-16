/**
 * Ranking by words, worked out here rather than by the database. SQLite's own full-text search is
 * still used first, to narrow a large collection down to the passages worth looking at, but the
 * ranking itself is done in plain TypeScript so it works the same on every build of SQLite — some
 * builds ship without full-text search at all — and so a rare word counts for far more than a
 * common one, which is the whole point of BM25.
 */
export interface Ranked { id: string; score: number }
const k1 = 1.2, b = 0.75;

/** The words of a piece of text, lower-cased, with anything that is not a letter or digit dropped. */
export const bm25Terms = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export class Bm25 {
  private readonly documents: { id: string; counts: Map<string, number>; length: number }[] = [];
  private readonly containing = new Map<string, number>();
  private total = 0;
  constructor(entries: { id: string; text: string }[] = []) {
    for (const entry of entries) this.add(entry.id, entry.text);
  }
  add(id: string, text: string): void {
    const words = bm25Terms(text);
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys()) this.containing.set(word, (this.containing.get(word) ?? 0) + 1);
    this.documents.push({ id, counts, length: words.length });
    this.total += words.length;
  }
  get size(): number { return this.documents.length; }
  private get averageLength(): number { return this.documents.length ? this.total / this.documents.length : 0; }
  /** How much one word says about a passage: a word in every passage says nothing. */
  private inverseFrequency(word: string): number {
    const seen = this.containing.get(word) ?? 0;
    if (!seen) return 0;
    return Math.log(1 + (this.documents.length - seen + 0.5) / (seen + 0.5));
  }
  /** The passages that best match a question, best first, ties broken by name so it never varies. */
  rank(query: string, limit = 20): Ranked[] {
    const wanted = [...new Set(bm25Terms(query))].slice(0, 32);
    if (!wanted.length || !this.documents.length) return [];
    const average = this.averageLength;
    return this.documents
      .map((document) => ({ id: document.id, score: Number(this.score(document, wanted, average).toFixed(6)) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));
  }
  private score(document: { counts: Map<string, number>; length: number }, wanted: string[], average: number): number {
    let total = 0;
    for (const word of wanted) {
      const count = document.counts.get(word) ?? 0;
      if (!count) continue;
      const norm = average ? 1 - b + (b * document.length) / average : 1;
      total += this.inverseFrequency(word) * ((count * (k1 + 1)) / (count + k1 * norm));
    }
    return total;
  }
}

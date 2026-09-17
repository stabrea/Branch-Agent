import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { cosine, EmbeddingClient, packVector, unpackVector, type Embedder } from "../document-embeddings.js";
import { embeddingFetch } from "../embeddings.js";
import { redactLeaks } from "../leak-guard.js";
import { localEmbedder } from "../local-models.js";
import type { ModelRouter } from "../models.js";
import { providerEmbeddings } from "../providers.js";
import type { Store } from "../store.js";

/**
 * R17-055: finding earlier conversations by what was meant, not only by the words used, with role
 * and date filters. Branch's own search (src/history.ts) matches words; this adds a comparison by
 * meaning over the person's and the assistant's messages, using the same embeddings route memory
 * search already uses (the connected provider's, or a model on this computer). Without one, it
 * falls back to word search and says so. Key-like values are hidden before any text is sent.
 *
 * The date filter is the date the conversation started: messages carry no time of their own.
 * The idea follows Letta Code's message search (Apache-2.0); the code is Branch's own.
 */
export const MeaningSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  role: z.enum(["user", "assistant"]).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();
export interface MeaningHit {
  messageId: number; sessionId: string; role: string; sessionCreatedAt: string;
  excerpt: string; score: number; matched: "meaning" | "words";
}
const batch = 32;
const perPass = 256;
const fingerprint = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The embeddings route memory search uses, built the same way (src/memory-retrieval.ts). */
export function conversationEmbedder(models: ModelRouter, call: () => typeof fetch, model = "text-embedding-3-small"): (owner: string) => Embedder | null {
  return (owner) => {
    const route = providerEmbeddings(models.plan(owner, "").candidates[0]!.provider);
    if (!route) return null;
    const here = localEmbedder(route, model);
    if (here) return here;
    try { return new EmbeddingClient(route.endpoint, route.apiKey, model, embeddingFetch(route.endpoint, call())); }
    catch { return null; }
  };
}

export class ConversationMeaning {
  constructor(private readonly store: Store, private readonly embedder: (owner: string) => Embedder | null,
    private readonly db: DatabaseSync = store.sqlite) {
    db.exec(`CREATE TABLE IF NOT EXISTS lm_message_vectors(owner TEXT NOT NULL, message_id INTEGER NOT NULL, model TEXT NOT NULL,
      fingerprint TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(owner, message_id, model))`);
  }

  ready(owner: string): boolean { return this.embedder(owner) !== null; }

  /** Gives up to `perPass` unread messages their comparison; removed or edited messages are redone. */
  async index(owner: string, signal: AbortSignal = AbortSignal.timeout(60000)): Promise<{ embedded: number; ready: boolean }> {
    const client = this.embedder(owner);
    if (!client) return { embedded: 0, ready: false };
    this.db.prepare("DELETE FROM lm_message_vectors WHERE owner=? AND message_id NOT IN (SELECT m.id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.owner=? AND s.temporary=0)").run(owner, owner);
    const rows = this.db.prepare(`SELECT m.id, json_extract(m.body,'$.content') AS content, v.fingerprint FROM messages m
      JOIN sessions s ON s.id=m.session_id LEFT JOIN lm_message_vectors v ON v.owner=? AND v.message_id=m.id AND v.model=?
      WHERE s.owner=? AND s.temporary=0 AND json_extract(m.body,'$.role') IN ('user','assistant') ORDER BY m.id DESC`).all(owner, client.model, owner)
      .map((row) => ({ id: Number(row.id), text: redactLeaks(String(row.content ?? "").slice(0, 2000)).text, saved: row.fingerprint }))
      .filter((row) => row.text.trim() && row.saved !== fingerprint(row.text)).slice(0, perPass);
    const save = this.db.prepare("INSERT OR REPLACE INTO lm_message_vectors VALUES(?,?,?,?,?)");
    for (let at = 0; at < rows.length; at += batch) {
      const part = rows.slice(at, at + batch);
      const vectors = await client.embed(part.map((row) => row.text), signal);
      part.forEach((row, i) => { if (vectors[i]) save.run(owner, row.id, client.model, fingerprint(row.text), packVector(vectors[i]!)); });
    }
    return { embedded: rows.length, ready: true };
  }

  async search(owner: string, input: unknown, excludeSessionId = "", signal: AbortSignal = AbortSignal.timeout(20000)): Promise<{ results: MeaningHit[]; matched: "meaning" | "words" }> {
    const query = MeaningSearchSchema.parse(input);
    const client = this.embedder(owner);
    if (!client) return { results: this.words(owner, query, excludeSessionId), matched: "words" };
    await this.index(owner, signal);
    const [target] = await client.embed([redactLeaks(query.query).text], signal);
    if (!target) return { results: this.words(owner, query, excludeSessionId), matched: "words" };
    const rows = this.db.prepare(`SELECT m.source_id, m.session_id, s.created_at, json_extract(m.body,'$.role') AS role,
      json_extract(m.body,'$.content') AS content, v.vector FROM lm_message_vectors v JOIN messages m ON m.id=v.message_id
      JOIN sessions s ON s.id=m.session_id WHERE v.owner=? AND v.model=? AND s.owner=? AND s.id<>? AND s.temporary=0`)
      .all(owner, client.model, owner, excludeSessionId);
    const results = rows.filter((row) => inRange(query, String(row.role), String(row.created_at)))
      .map((row) => ({ messageId: Number(row.source_id), sessionId: String(row.session_id), role: String(row.role),
        sessionCreatedAt: String(row.created_at), excerpt: String(row.content ?? "").slice(0, 400),
        score: Math.round(cosine(target, unpackVector(row.vector as Uint8Array)) * 1000) / 1000, matched: "meaning" as const }))
      .sort((a, b) => b.score - a.score).slice(0, query.limit);
    return { results, matched: "meaning" };
  }

  forget(owner: string): number {
    return Number(this.db.prepare("DELETE FROM lm_message_vectors WHERE owner=?").run(owner).changes);
  }

  private words(owner: string, query: z.infer<typeof MeaningSearchSchema>, excludeSessionId: string): MeaningHit[] {
    return this.store.searchHistory(owner, { query: query.query, match: "any", limit: 20 }, excludeSessionId)
      .filter((hit) => inRange(query, hit.role, hit.sessionCreatedAt)).slice(0, query.limit)
      .map((hit) => ({ messageId: hit.messageId, sessionId: hit.sessionId, role: hit.role, sessionCreatedAt: hit.sessionCreatedAt,
        excerpt: hit.excerpt.slice(0, 400), score: 0, matched: "words" as const }));
  }
}

function inRange(query: z.infer<typeof MeaningSearchSchema>, role: string, startedAt: string): boolean {
  if (query.role && role !== query.role) return false;
  return (!query.from || startedAt >= query.from) && (!query.to || startedAt <= query.to);
}

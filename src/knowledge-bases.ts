import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { Bm25 } from "./bm25.js";
import { chunkDocument, type Chunk } from "./chunking.js";
import { Citations, type Citation } from "./citations.js";
import { errorText } from "./contracts.js";
import { documentType, extractText } from "./document-text.js";
import { fuseRanks } from "./document-embeddings.js";
import { CachedEmbeddings, EmbeddingCache, embeddingConnection, embeddingsFor, noEmbeddingsMessage,
  textFingerprint, type EmbeddingLedger } from "./embeddings.js";
import type { WorkspaceFiles } from "./files.js";
import type { ModelRouter } from "./models.js";
import type { Store } from "./store.js";
import { SqliteVectors, type VectorBackend } from "./vector-store.js";
import type { RerankablePassage } from "./documents.js";

/**
 * A knowledge base is a name the owner gives to a set of folders and files they want the assistant
 * to be able to quote. Reading one means cutting every file into passages, keeping them for word
 * search, and — where a connected model can do it — also as lists of numbers so a question finds
 * the right passage even when it uses none of the same words. A search asks both ways at once and
 * merges the two orders, and every answer says which file, heading and page it came from.
 */
export const maximumSources = 20;
export const maximumFiles = 400;
export const maximumFileBytes = 5 * 1024 * 1024;
const passageChars = 900;
const candidates = 60;

export const SourceSchema = z.object({
  kind: z.enum(["folder", "file"]),
  path: z.string().trim().min(1).max(500),
}).strict();
export type CollectionSource = z.infer<typeof SourceSchema>;
export const CreateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sources: z.array(SourceSchema).max(maximumSources).default([]),
}).strict();
export const KnowledgeSearchSchema = z.object({
  collection: z.string().trim().min(1).max(120).optional(),
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

export interface CollectionInfo {
  id: string; name: string; sources: CollectionSource[]; model: string; attached: boolean;
  documents: number; chunks: number; embedded: number; lastIndexedAt: string | null; note: string;
}
export interface IndexProgress {
  event: "knowledge.index.progress";
  collection: string; name: string;
  files: number; filesDone: number; chunks: number; embedded: number;
  status: string; finished: boolean; error?: string;
}
export interface KnowledgeHit {
  collection: string; collectionName: string;
  documentId: string; documentName: string; heading: string; page: number | null;
  chunkId: string; text: string; score: number; matched: "words" | "meaning" | "both";
}

export class KnowledgeBases {
  private readonly db: DatabaseSync;
  readonly vectors: VectorBackend;
  readonly cache: EmbeddingCache;
  /** False only where this build of SQLite has no full-text search; every collection is then read whole. */
  readonly ranked: boolean;
  /** Set at start-up: puts the passages a search found into the best order. See src/retrieval.ts. */
  reranker: ((owner: string, query: string, passages: RerankablePassage[], signal?: AbortSignal) => Promise<RerankablePassage[]>) | undefined;
  private readonly latest = new Map<string, IndexProgress>();
  constructor(
    private readonly store: Store,
    private readonly files?: WorkspaceFiles,
    private readonly models?: ModelRouter,
    private readonly ledger?: EmbeddingLedger,
    backend?: VectorBackend,
  ) {
    this.db = store.sqlite;
    this.cache = new EmbeddingCache(this.db);
    this.vectors = backend ?? new SqliteVectors(this.db);
    this.createTables();
    this.ranked = this.createIndex();
  }
  private createTables(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS kb_collections(id TEXT NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
        sources TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', attached INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '', last_indexed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(id,owner));
      CREATE TABLE IF NOT EXISTS kb_chunks(row_id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL,
        collection TEXT NOT NULL, chunk_id TEXT NOT NULL, doc_id TEXT NOT NULL, doc_name TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, heading TEXT NOT NULL DEFAULT '', page INTEGER, chunk_text TEXT NOT NULL,
        text_hash TEXT NOT NULL, UNIQUE(owner,collection,chunk_id));
      CREATE INDEX IF NOT EXISTS kb_chunks_collection ON kb_chunks(owner,collection);
      CREATE INDEX IF NOT EXISTS kb_chunks_document ON kb_chunks(owner,collection,doc_id);`);
  }
  private createIndex(): boolean {
    const available = this.db.prepare("PRAGMA compile_options").all()
      .some((row) => String(row.compile_options).toUpperCase() === "ENABLE_FTS5");
    if (!available) return false;
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS kb_search USING fts5(chunk_text, tokenize='unicode61 remove_diacritics 2')");
      return true;
    } catch { return false; }
  }

  /** The reader for this owner's passages, or nothing when no connected model can read them. */
  embeddings(owner: string): CachedEmbeddings | null {
    const connection = embeddingConnection(this.models, owner);
    if (!connection) return null;
    const adapter = embeddingsFor(connection);
    return adapter ? new CachedEmbeddings(adapter, this.cache, this.ledger) : null;
  }
  meaningSearchReady(owner: string): boolean { return this.embeddings(owner) !== null; }

  list(owner: string): CollectionInfo[] {
    return this.db.prepare("SELECT * FROM kb_collections WHERE owner=? ORDER BY name LIMIT 100").all(owner)
      .map((row) => this.describe(owner, row));
  }
  private describe(owner: string, row: Record<string, unknown>): CollectionInfo {
    const id = String(row.id);
    const counts = this.db.prepare(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT doc_id) AS documents
      FROM kb_chunks WHERE owner=? AND collection=?`).get(owner, id);
    // The shipped backend keeps its vectors here; another backend simply reports none from this view.
    let embedded = 0;
    try { embedded = Number(this.db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE owner=? AND collection=?").get(owner, id)?.n ?? 0); }
    catch { embedded = 0; }
    return {
      id, name: String(row.name), sources: JSON.parse(String(row.sources)) as CollectionSource[],
      model: String(row.model ?? ""), attached: Number(row.attached) === 1,
      documents: Number(counts?.documents ?? 0), chunks: Number(counts?.chunks ?? 0),
      embedded, note: String(row.note ?? ""),
      lastIndexedAt: row.last_indexed_at === null ? null : String(row.last_indexed_at),
    };
  }
  one(owner: string, id: string): CollectionInfo {
    const row = this.db.prepare("SELECT * FROM kb_collections WHERE owner=? AND (id=? OR name=?)").get(owner, id, id);
    if (!row) throw new Error("There is no knowledge base by that name");
    return this.describe(owner, row);
  }
  view(owner: string) {
    return {
      collections: this.list(owner), meaningSearch: this.meaningSearchReady(owner),
      model: embeddingConnection(this.models, owner)?.model ?? "",
      onThisComputer: embeddingConnection(this.models, owner)?.local ?? false,
      ranked: this.ranked, backend: this.vectors.name, readingNow: [...this.latest.values()].filter((entry) => !entry.finished),
    };
  }
  /** How far the last read of a collection got, for the panel's progress line. */
  progress(id: string): IndexProgress | null { return this.latest.get(id) ?? null; }

  create(owner: string, input: unknown): CollectionInfo {
    const value = CreateCollectionSchema.parse(input);
    if (this.db.prepare("SELECT id FROM kb_collections WHERE owner=? AND name=?").get(owner, value.name))
      throw new Error("You already have a knowledge base with that name");
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO kb_collections(id,owner,name,sources,model,attached,note,last_indexed_at,created_at,updated_at) VALUES(?,?,?,?,'',0,'',NULL,?,?)")
      .run(id, owner, value.name, JSON.stringify(value.sources), now, now);
    return this.one(owner, id);
  }
  /** Adds a folder or a file to a collection. It is read the next time the collection is read. */
  addSource(owner: string, id: string, input: unknown): CollectionInfo {
    const source = SourceSchema.parse(input), current = this.one(owner, id);
    if (current.sources.some((entry) => entry.kind === source.kind && entry.path === source.path)) return current;
    if (current.sources.length >= maximumSources) throw new Error(`A knowledge base holds up to ${maximumSources} folders or files`);
    return this.saveSources(owner, current.id, [...current.sources, source]);
  }
  removeSource(owner: string, id: string, path: string): CollectionInfo {
    const current = this.one(owner, id);
    const kept = current.sources.filter((entry) => entry.path !== path);
    const info = this.saveSources(owner, current.id, kept);
    this.forgetDocument(owner, current.id, path);
    return info;
  }
  private saveSources(owner: string, id: string, sources: CollectionSource[]): CollectionInfo {
    this.db.prepare("UPDATE kb_collections SET sources=?, updated_at=? WHERE owner=? AND id=?")
      .run(JSON.stringify(sources), new Date().toISOString(), owner, id);
    return this.one(owner, id);
  }
  /** Puts a collection in front of every task, the way the document library already can be. */
  attach(owner: string, id: string, on: boolean): CollectionInfo {
    const current = this.one(owner, id);
    this.db.prepare("UPDATE kb_collections SET attached=?, updated_at=? WHERE owner=? AND id=?")
      .run(on ? 1 : 0, new Date().toISOString(), owner, current.id);
    return this.one(owner, current.id);
  }
  remove(owner: string, id: string): { removed: string } {
    const current = this.one(owner, id);
    this.clearChunks(owner, current.id);
    void this.vectors.removeCollection(owner, current.id);
    this.db.prepare("DELETE FROM kb_collections WHERE owner=? AND id=?").run(owner, current.id);
    this.latest.delete(current.id);
    return { removed: current.id };
  }
  private clearChunks(owner: string, collection: string): void {
    if (this.ranked) this.db.prepare("DELETE FROM kb_search WHERE rowid IN (SELECT row_id FROM kb_chunks WHERE owner=? AND collection=?)")
      .run(owner, collection);
    this.db.prepare("DELETE FROM kb_chunks WHERE owner=? AND collection=?").run(owner, collection);
  }
  private forgetDocument(owner: string, collection: string, docId: string): void {
    if (this.ranked) this.db.prepare(`DELETE FROM kb_search WHERE rowid IN
      (SELECT row_id FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?)`).run(owner, collection, docId);
    this.db.prepare("DELETE FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?").run(owner, collection, docId);
    void this.vectors.removeDocument(owner, collection, docId);
  }

  /** Every file a collection's folders and files come to, as workspace-relative paths. */
  async filesIn(owner: string, id: string): Promise<string[]> {
    const current = this.one(owner, id);
    if (!this.files) return [];
    const found: string[] = [];
    for (const source of current.sources) {
      if (source.kind === "file") { found.push(source.path.replace(/^\.\//, "")); continue; }
      await this.walk(source.path.replace(/\/$/, ""), found, 0);
    }
    return [...new Set(found)].slice(0, maximumFiles);
  }
  private async walk(folder: string, found: string[], depth: number): Promise<void> {
    if (depth > 4 || found.length >= maximumFiles || !this.files) return;
    const listing = await this.files.list(folder || ".").catch(() => ({ entries: [] as { name: string; type: string }[] }));
    for (const entry of listing.entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.type === "directory") await this.walk(path, found, depth + 1);
      else if (readableFile(path)) found.push(path);
    }
  }

  /**
   * Reads a collection from scratch: every file cut into passages, then the passages a connected
   * model has not already read turned into lists of numbers. Progress is reported after each file,
   * so a large folder shows movement rather than a frozen button.
   */
  async reindex(
    owner: string, id: string,
    onProgress: (progress: IndexProgress) => void = () => undefined,
    signal: AbortSignal = AbortSignal.timeout(600000), runId?: string,
  ): Promise<IndexProgress> {
    const current = this.one(owner, id);
    const paths = await this.filesIn(owner, current.id);
    let progress: IndexProgress = { event: "knowledge.index.progress", collection: current.id, name: current.name,
      files: paths.length, filesDone: 0, chunks: 0, embedded: 0, status: "Reading your files", finished: false };
    const report = (next: Partial<IndexProgress>) => { progress = { ...progress, ...next }; this.latest.set(current.id, progress); onProgress(progress); };
    report({});
    this.clearChunks(owner, current.id);
    await this.vectors.removeCollection(owner, current.id);
    for (const path of paths) {
      signal.throwIfAborted();
      const chunks = await this.readFileChunks(path).catch(() => [] as Chunk[]);
      this.writeChunks(owner, current.id, path, chunks);
      report({ filesDone: progress.filesDone + 1, chunks: progress.chunks + chunks.length });
    }
    const meaning = await this.embedCollection(owner, current.id, signal, runId);
    report({ embedded: meaning.embedded, status: meaning.note || "Ready", finished: true, ...(meaning.error ? { error: meaning.error } : {}) });
    this.db.prepare("UPDATE kb_collections SET last_indexed_at=?, model=?, note=?, updated_at=? WHERE owner=? AND id=?")
      .run(new Date().toISOString(), meaning.model, meaning.note, new Date().toISOString(), owner, current.id);
    return progress;
  }
  private async readFileChunks(path: string): Promise<Chunk[]> {
    if (!this.files) return [];
    const full = await this.files.checked(path);
    const info = await stat(full);
    if (!info.isFile() || info.size > maximumFileBytes) return [];
    const type = documentType(path);
    const text = extractText(await readFile(full), type);
    if (text === null) return [];
    const title = path.split("/").pop() ?? path;
    return chunkDocument({ key: path, title, text, markdown: type === "md" });
  }
  private writeChunks(owner: string, collection: string, docId: string, chunks: Chunk[]): void {
    for (const chunk of chunks) {
      const row = this.db.prepare(`INSERT OR REPLACE INTO kb_chunks(owner,collection,chunk_id,doc_id,doc_name,chunk_index,heading,page,chunk_text,text_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?) RETURNING row_id`)
        .get(owner, collection, chunk.id, docId, chunk.title, chunk.index, chunk.headingPath.join(" › "),
          chunk.page, chunk.text, textFingerprint(chunk.text, "chunk"));
      if (this.ranked) this.db.prepare("INSERT INTO kb_search(rowid,chunk_text) VALUES(?,?)").run(Number(row?.row_id), chunk.text);
    }
  }
  /** Turns the passages that have no current list of numbers into one; the cache makes repeats free. */
  private async embedCollection(owner: string, collection: string, signal: AbortSignal, runId?: string) {
    const reader = this.embeddings(owner);
    if (!reader) return { embedded: 0, model: "", note: noEmbeddingsMessage, error: "" };
    const rows = this.db.prepare("SELECT chunk_id, doc_id, chunk_text, text_hash FROM kb_chunks WHERE owner=? AND collection=? LIMIT 50000")
      .all(owner, collection);
    if (!rows.length) return { embedded: 0, model: reader.model, note: "Nothing readable was found in those files", error: "" };
    try {
      const texts = rows.map((row) => String(row.chunk_text));
      const vectors = await reader.embedFor(runId, texts, signal);
      const written = await this.vectors.upsert(owner, rows.map((row, at) => ({
        collection, docId: String(row.doc_id), chunkId: String(row.chunk_id), model: reader.model,
        vector: vectors[at] ?? new Float32Array(), textHash: String(row.text_hash),
      })));
      return { embedded: written, model: reader.model, note: "", error: "" };
    } catch (error) {
      const message = errorText(error).slice(0, 200);
      return { embedded: 0, model: reader.model, note: `Word search works. Comparing by meaning failed: ${message}`, error: message };
    }
  }

  /** Word ranking and meaning ranking merged, then the second pass, with a citation on every answer. */
  async search(owner: string, input: unknown, signal = AbortSignal.timeout(30000)): Promise<KnowledgeHit[]> {
    const { collection, query, limit } = KnowledgeSearchSchema.parse(input);
    const target = collection ? this.one(owner, collection) : null;
    const rows = this.candidateRows(owner, target?.id, query);
    if (!rows.length) return [];
    const byId = new Map(rows.map((row) => [String(row.chunk_id), row]));
    const words = new Bm25(rows.map((row) => ({ id: String(row.chunk_id), text: String(row.chunk_text) })))
      .rank(query, candidates).map((entry) => entry.id);
    const meaning = (await this.meaningMatches(owner, target?.id, query, signal)).filter((id) => byId.has(id));
    if (!words.length && !meaning.length) return [];
    const fused = fuseRanks([words, meaning].filter((list) => list.length));
    const names = new Map(this.list(owner).map((entry) => [entry.id, entry.name]));
    const ordered = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, candidates)
      .map(([id, score]) => toHit(byId.get(id)!, names, score,
        words.includes(id) && meaning.includes(id) ? "both" : meaning.includes(id) ? "meaning" : "words"));
    return this.bestFirst(owner, query, ordered, limit, signal);
  }
  /** The passages worth ranking: narrowed by full-text search where the database offers it. */
  private candidateRows(owner: string, collection: string | undefined, query: string): Record<string, unknown>[] {
    const where = collection ? "AND c.collection=?" : "";
    const scope = collection ? [owner, collection] : [owner];
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
    if (this.ranked && words.length) {
      const expression = words.map((word) => `"${word.replace(/"/g, "")}"`).join(" OR ");
      const hits = this.db.prepare(`SELECT c.* FROM kb_search JOIN kb_chunks c ON c.row_id=kb_search.rowid
        WHERE kb_search MATCH ? AND c.owner=? ${where} ORDER BY bm25(kb_search) LIMIT ?`)
        .all(expression, ...scope, candidates * 4);
      if (hits.length) return hits;
    }
    return this.db.prepare(`SELECT c.* FROM kb_chunks c WHERE c.owner=? ${where} LIMIT ?`).all(...scope, 2000);
  }
  private async meaningMatches(owner: string, collection: string | undefined, query: string, signal: AbortSignal): Promise<string[]> {
    const reader = this.embeddings(owner);
    if (!reader) return [];
    const asked = await reader.embed([query], signal).catch(() => null);
    if (!asked?.[0]?.length) return [];
    const collections = collection ? [collection] : this.list(owner).map((entry) => entry.id);
    const found = await Promise.all(collections.map((id) => this.vectors.search(owner, id, asked[0]!, candidates)));
    return found.flat().filter((match) => match.score > 0.15).sort((a, b) => b.score - a.score)
      .slice(0, candidates).map((match) => match.chunkId);
  }
  /** The second pass from wave 6, when one is set, then as many answers as the caller asked for. */
  private async bestFirst(owner: string, query: string, hits: KnowledgeHit[], limit: number, signal?: AbortSignal): Promise<KnowledgeHit[]> {
    if (!this.reranker || hits.length < 2) return hits.slice(0, limit);
    const keyed = new Map(hits.map((hit) => [`knowledge:${hit.collection}:${hit.chunkId}`, hit]));
    const ordered = await this.reranker(owner, query,
      [...keyed].map(([key, hit]) => ({ key, source: hit.documentName, text: hit.text, score: hit.score, from: "knowledge" })), signal)
      .catch(() => null);
    if (!ordered?.length) return hits.slice(0, limit);
    return ordered.flatMap((passage) => { const hit = keyed.get(passage.key); return hit ? [hit] : []; }).slice(0, limit);
  }

  /** The attached collections' best passages, numbered for citation, to put in front of a task. */
  async contextFor(owner: string, prompt: string, signal?: AbortSignal): Promise<{ text: string; sources: string[]; citations: Citation[] } | null> {
    const attached = this.list(owner).filter((entry) => entry.attached && entry.chunks > 0);
    if (!attached.length) return null;
    const query = prompt.slice(0, 500);
    const found: KnowledgeHit[] = [];
    for (const collection of attached)
      found.push(...await this.search(owner, { collection: collection.id, query, limit: 3 }, signal).catch(() => []));
    if (!found.length) return null;
    const chosen = found.sort((a, b) => b.score - a.score).slice(0, 3);
    const citations = new Citations();
    const blocks = chosen.map((hit) => {
      const citation = citations.add({ url: `document:${hit.collection}/${hit.documentId}`, title: citationTitle(hit), quote: hit.text });
      return `[${citation.number}] From "${citationTitle(hit)}":\n${hit.text}`;
    });
    return {
      text: `${blocks.join("\n\n")}\n\n${citations.markdown("Sources in your knowledge bases")}`,
      sources: [...new Set(chosen.map((hit) => citationTitle(hit)))], citations: citations.list(),
    };
  }
}

/** The one line that tells the person where a passage came from: file, heading and page. */
export function citationTitle(hit: KnowledgeHit): string {
  const parts = [hit.documentName, hit.heading, hit.page === null ? "" : `page ${hit.page}`].filter(Boolean);
  return parts.join(" › ");
}
function toHit(row: Record<string, unknown>, names: Map<string, string>, score: number, matched: KnowledgeHit["matched"]): KnowledgeHit {
  const collection = String(row.collection);
  return {
    collection, collectionName: names.get(collection) ?? collection,
    documentId: String(row.doc_id), documentName: String(row.doc_name), heading: String(row.heading ?? ""),
    page: row.page === null || row.page === undefined ? null : Number(row.page),
    chunkId: String(row.chunk_id), text: String(row.chunk_text).slice(0, passageChars),
    score: Number(score.toFixed(6)), matched,
  };
}
const readableExtensions = new Set(["txt", "text", "log", "md", "markdown", "html", "htm", "csv", "tsv", "json", "docx", "docm", "xlsx", "xlsm"]);
/** Whether a file is one the existing readers can turn into text; nothing new is parsed here. */
export const readableFile = (path: string): boolean =>
  readableExtensions.has(path.toLowerCase().split(".").pop() ?? "");

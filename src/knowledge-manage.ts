import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { packZip, unpackRaw, entryText } from "./document-package.js";
import type { KnowledgeBases } from "./knowledge-bases.js";
import type { KnowledgeSummaries } from "./knowledge-summary.js";
import type { Proposal } from "./memory-review.js";
import type { Store } from "./store.js";

/**
 * Looking after a knowledge base once it exists: renaming it, putting two together, splitting a
 * large one up by folder, saving the whole of it as a plain zip of Markdown, bringing one back, and
 * seeing what it costs to keep. None of this asks a model anything; it is all work on what is
 * already stored here, which is why it is quick and why it works with nothing connected.
 *
 * Everything that removes something proposes it first. A collection built over months is exactly
 * the sort of thing that should never quietly shrink because a limit was crossed while nobody was
 * looking, so an age or size limit writes a suggestion into the Memory screen and waits.
 */
export const maximumExportBytes = 32 * 1024 * 1024;
export const maximumImportDocuments = 400;

export const RenameSchema = z.object({
  collection: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120),
}).strict();
export const MergeSchema = z.object({
  from: z.string().trim().min(1).max(120), into: z.string().trim().min(1).max(120),
  /** Leave the collection the passages came from in place rather than removing it. */
  keepSource: z.boolean().default(false),
}).strict();
export const SplitSchema = z.object({
  collection: z.string().trim().min(1).max(120),
  /** The folder whose files move out, as it is written in the collection's own paths. */
  folder: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(120),
}).strict();
/**
 * How long, and how much, one collection may keep. Zero means no limit. This is deliberately the
 * same pair of numbers the conversation-retention setting uses, so there is one idea in the product
 * rather than two: when that setting lands, this reads from it instead of keeping its own copy.
 */
export const RetentionSchema = z.object({
  keepDays: z.number().int().min(0).max(3650).default(0),
  maximumDocuments: z.number().int().min(0).max(10000).default(0),
  maximumChunks: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
export type Retention = z.infer<typeof RetentionSchema>;

export interface CollectionSize {
  collection: string; name: string; documents: number; chunks: number; embedded: number;
  /** Roughly how much room the passages take, and what reading them has been charged for so far. */
  characters: number; indexTokens: number; oldestAt: string | null;
}

export class KnowledgeManagement {
  private readonly db: DatabaseSync;
  constructor(
    private readonly store: Store, private readonly bases: KnowledgeBases,
    private readonly summaries?: KnowledgeSummaries,
  ) {
    this.db = store.sqlite;
  }

  rename(owner: string, input: unknown) {
    const { collection, name } = RenameSchema.parse(input);
    const current = this.bases.one(owner, collection);
    if (this.db.prepare("SELECT id FROM kb_collections WHERE owner=? AND name=? AND id<>?").get(owner, name, current.id))
      throw new Error("You already have a knowledge base with that name");
    this.db.prepare("UPDATE kb_collections SET name=?, updated_at=? WHERE owner=? AND id=?")
      .run(name, new Date().toISOString(), owner, current.id);
    return this.bases.one(owner, current.id);
  }

  /** Two collections into one. The passages move; nothing is read again and nothing costs anything. */
  async merge(owner: string, input: unknown) {
    const { from, into, keepSource } = MergeSchema.parse(input);
    const source = this.bases.one(owner, from), target = this.bases.one(owner, into);
    if (source.id === target.id) throw new Error("A knowledge base cannot be merged into itself");
    const moved = this.moveChunks(owner, source.id, target.id, () => true);
    this.mergeSources(owner, source, target);
    this.summaries?.forget(owner, target.id);
    if (!keepSource) await this.bases.remove(owner, source.id);
    return { into: target.id, moved, removed: keepSource ? "" : source.id, collection: this.bases.one(owner, target.id) };
  }
  /** One folder's files out into a collection of their own; the rest of the passages stay put. */
  split(owner: string, input: unknown) {
    const { collection, folder, name } = SplitSchema.parse(input);
    const source = this.bases.one(owner, collection);
    const prefix = folder.replace(/^\.\//, "").replace(/\/$/, "");
    const created = this.bases.create(owner, { name, sources: [{ kind: "folder" as const, path: prefix }] });
    const moved = this.moveChunks(owner, source.id, created.id, (docId) => docId.startsWith(`${prefix}/`) || docId === prefix);
    if (!moved) { void this.bases.remove(owner, created.id); throw new Error(`Nothing in "${source.name}" comes from ${prefix}`); }
    this.saveSources(owner, source.id, source.sources.filter((entry) => entry.path.replace(/\/$/, "") !== prefix));
    this.summaries?.forget(owner, source.id);
    return { collection: created.id, name, moved, from: source.id };
  }
  /**
   * Passages, their record and their lists of numbers moved from one collection to another. The row
   * each passage lives in is kept, so the word index that points at it stays correct.
   */
  private moveChunks(owner: string, from: string, into: string, wanted: (docId: string) => boolean): number {
    const docIds = this.db.prepare("SELECT DISTINCT doc_id FROM kb_chunks WHERE owner=? AND collection=?")
      .all(owner, from).map((row) => String(row.doc_id)).filter(wanted);
    let moved = 0;
    for (const docId of docIds) {
      moved += Number(this.db.prepare("UPDATE OR IGNORE kb_chunks SET collection=? WHERE owner=? AND collection=? AND doc_id=?")
        .run(into, owner, from, docId).changes ?? 0);
      this.db.prepare("DELETE FROM kb_chunks WHERE owner=? AND collection=? AND doc_id=?").run(owner, from, docId);
      this.db.prepare("UPDATE OR IGNORE kb_documents SET collection=? WHERE owner=? AND collection=? AND doc_id=?")
        .run(into, owner, from, docId);
      try { this.db.prepare("UPDATE OR IGNORE vectors SET collection=? WHERE owner=? AND collection=? AND doc_id=?").run(into, owner, from, docId); }
      catch { /* another vector backend keeps them elsewhere */ }
    }
    return moved;
  }
  private mergeSources(owner: string, source: { id: string; sources: { kind: "folder" | "file"; path: string }[] }, target: { id: string; sources: { kind: "folder" | "file"; path: string }[] }): void {
    const seen = new Set(target.sources.map((entry) => `${entry.kind}:${entry.path}`));
    const kept = [...target.sources, ...source.sources.filter((entry) => !seen.has(`${entry.kind}:${entry.path}`))];
    this.saveSources(owner, target.id, kept.slice(0, 20));
  }
  private saveSources(owner: string, id: string, sources: { kind: "folder" | "file"; path: string }[]): void {
    this.db.prepare("UPDATE kb_collections SET sources=?, updated_at=? WHERE owner=? AND id=?")
      .run(JSON.stringify(sources), new Date().toISOString(), owner, id);
  }

  /** A collection saved out as a zip: one Markdown file per document, plus a small list of facts. */
  exportCollection(owner: string, collection: string): { bytes: Buffer; documents: number; name: string } {
    const current = this.bases.one(owner, collection);
    const rows = this.db.prepare(`SELECT doc_id, doc_name, chunk_index, heading, page, chunk_text FROM kb_chunks
      WHERE owner=? AND collection=? ORDER BY doc_id, chunk_index LIMIT 100000`).all(owner, current.id);
    const documents = new Map<string, { name: string; parts: string[] }>();
    for (const row of rows) {
      const docId = String(row.doc_id);
      const entry = documents.get(docId) ?? { name: String(row.doc_name), parts: [] };
      entry.parts.push(String(row.chunk_text));
      documents.set(docId, entry);
    }
    const entries = [...documents].map(([docId, entry], at) => ({
      name: `documents/${String(at + 1).padStart(4, "0")}-${safeName(entry.name)}.md`,
      body: `# ${entry.name}\n\nFrom: ${docId}\n\n${entry.parts.join("\n\n")}\n`,
    }));
    const manifest = { name: current.name, sources: current.sources, documents: [...documents].map(([docId, entry], at) =>
      ({ docId, name: entry.name, file: entries[at]!.name })), exportedAt: new Date().toISOString() };
    const bytes = packZip([{ name: "collection.json", body: JSON.stringify(manifest, null, 2) }, ...entries]);
    if (bytes.byteLength > maximumExportBytes) throw new Error("This knowledge base is larger than can be saved out in one file");
    return { bytes, documents: documents.size, name: current.name };
  }
  /** A saved copy brought back as a new collection. Nothing is read again and nothing is charged. */
  importCollection(owner: string, bytes: Buffer, name?: string) {
    const entries = unpackRaw(bytes);
    const manifest = entries.find((entry) => entry.name === "collection.json");
    if (!manifest) throw new Error("That file is not a saved knowledge base");
    const parsed = ManifestSchema.parse(JSON.parse(entryText(manifest)) as unknown);
    const created = this.bases.create(owner, { name: name || uniqueName(this.bases, owner, parsed.name), sources: parsed.sources });
    let documents = 0;
    for (const document of parsed.documents.slice(0, maximumImportDocuments)) {
      const part = entries.find((entry) => entry.name === document.file);
      if (!part) continue;
      this.bases.putDocument(owner, created.id, { docId: document.docId, title: document.name, text: entryText(part) });
      documents++;
    }
    return { collection: created.id, name: created.name, documents };
  }

  /** What each collection holds and what it has cost, for the panel and for the retention check. */
  sizes(owner: string): CollectionSize[] {
    return this.bases.list(owner).map((collection) => {
      const row = this.db.prepare(`SELECT COUNT(*) AS chunks, COUNT(DISTINCT doc_id) AS documents,
        SUM(LENGTH(chunk_text)) AS characters FROM kb_chunks WHERE owner=? AND collection=?`).get(owner, collection.id);
      const oldest = this.db.prepare("SELECT MIN(updated_at) AS at FROM kb_documents WHERE owner=? AND collection=?")
        .get(owner, collection.id);
      return { collection: collection.id, name: collection.name, documents: Number(row?.documents ?? 0),
        chunks: Number(row?.chunks ?? 0), embedded: collection.embedded, characters: Number(row?.characters ?? 0),
        indexTokens: collection.indexTokens, oldestAt: oldest?.at ? String(oldest.at) : null };
    });
  }

  settings(owner: string): Retention {
    const saved = RetentionSchema.safeParse(this.store.get("settings", owner, "knowledge-retention")?.data ?? {});
    return saved.success ? saved.data : RetentionSchema.parse({});
  }
  configure(owner: string, input: unknown): Retention {
    const value = RetentionSchema.parse({ ...this.settings(owner), ...(input as object) });
    this.store.save("settings", owner, "knowledge-retention", value);
    return value;
  }
  /**
   * What the limits say should go. Nothing is removed here: each collection over a limit becomes one
   * suggestion in the Memory screen, and the suggestion says to save the collection out first.
   */
  proposeRetention(owner: string): { proposals: Proposal[]; over: string[]; limits: Retention } {
    const limits = this.settings(owner);
    const proposals: Proposal[] = [], over: string[] = [];
    if (!limits.keepDays && !limits.maximumDocuments && !limits.maximumChunks) return { proposals, over, limits };
    const cutoff = limits.keepDays ? Date.now() - limits.keepDays * 86400000 : 0;
    for (const size of this.sizes(owner)) {
      const reasons = [
        limits.maximumDocuments && size.documents > limits.maximumDocuments ? `${size.documents} files, more than the ${limits.maximumDocuments} you allow` : "",
        limits.maximumChunks && size.chunks > limits.maximumChunks ? `${size.chunks} passages, more than the ${limits.maximumChunks} you allow` : "",
        cutoff && size.oldestAt && Date.parse(size.oldestAt) < cutoff ? `files last read before your ${limits.keepDays}-day limit` : "",
      ].filter(Boolean);
      if (!reasons.length) continue;
      over.push(size.collection);
      proposals.push(this.store.review.propose(owner, { kind: "archive", memoryIds: [`knowledge:${size.collection}`],
        source: "Knowledge base limits", note: retentionNote(size.name, reasons) }));
    }
    return { proposals, over, limits };
  }
}
const ManifestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sources: z.array(z.object({ kind: z.enum(["folder", "file"]), path: z.string().min(1).max(500) }).strict()).max(20).default([]),
  documents: z.array(z.object({
    docId: z.string().min(1).max(500), name: z.string().max(200).default(""), file: z.string().min(1).max(500),
  }).strict()).max(maximumImportDocuments).default([]),
}).passthrough();
const safeName = (name: string): string =>
  name.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";
const retentionNote = (name: string, reasons: string[]): string =>
  `"${name}" has ${reasons.join(", and ")}. Save it out first, then take the oldest files out of it.`.slice(0, 500);
function uniqueName(bases: KnowledgeBases, owner: string, wanted: string): string {
  const taken = new Set(bases.list(owner).map((collection) => collection.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let at = 2; at < 50; at++) if (!taken.has(`${wanted} (${at})`.toLowerCase())) return `${wanted} (${at})`;
  return `${wanted} (${Date.now()})`.slice(0, 120);
}

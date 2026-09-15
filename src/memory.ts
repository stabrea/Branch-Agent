import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { SavedRecord, Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

export const maximumMemoryArchiveBytes = 16 * 1024 * 1024;
export const MemoryDataSchema = z.object({
  text: z.string().min(1).max(4000),
  source: z.string().min(1).max(500).default("Saved by workspace owner"),
  sourceRunId: z.string().max(200).default(""),
  /** The run that first saved the fact; survives later edits so a conversation can be forgotten precisely. */
  originRunId: z.string().max(200).optional(),
}).strict();
const NewMemoryDataSchema = MemoryDataSchema.extend({
  text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(500).default("Saved by workspace owner"),
});
const MemoryIdSchema = z.string().min(1).max(200);
const RecordSchema = z.object({
  id: MemoryIdSchema, data: MemoryDataSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const ArchiveSchema = z.object({
  format: z.literal("branch-agent-memory"), version: z.literal(1),
  exportedAt: z.iso.datetime(), records: z.array(RecordSchema).max(500),
}).strict();
const CapacitySchema = z.object({ maxFacts: z.number().int().min(1).max(500) }).strict();
export const UpdateMemorySchema = z.object({
  id: MemoryIdSchema, text: z.string().trim().min(1).max(4000),
  source: z.string().trim().min(1).max(500), expectedRevision: z.number().int().positive(),
}).strict();
export interface MemoryRecord extends SavedRecord { revision: number }
type ArchiveRecord = z.infer<typeof RecordSchema>;

export function parseMemoryArchive(input: unknown) {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > maximumMemoryArchiveBytes)
    throw new Error("Memory archive exceeds 16 MiB");
  const archive = ArchiveSchema.parse(input), ids = new Set<string>();
  for (const record of archive.records) {
    if (ids.has(record.id)) throw new Error("Memory archive contains repeated identifiers");
    if (Date.parse(record.updatedAt) < Date.parse(record.createdAt))
      throw new Error("Memory update time precedes its creation time");
    ids.add(record.id);
  }
  return archive;
}

export class MemoryFacts {
  constructor(private readonly db: DatabaseSync) {
    if (!db.prepare("PRAGMA table_info(memory)").all().some(row => row.name === "revision"))
      db.exec("ALTER TABLE memory ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    db.exec("CREATE TABLE IF NOT EXISTS memory_limits(owner TEXT PRIMARY KEY,max_facts INTEGER NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS memory_suppressions(owner TEXT NOT NULL, session_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(owner,session_id))`);
  }
  /** Facts a conversation's runs saved by themselves, split into removable and kept (owner-edited) ones. */
  forgetPreview(owner: string, sessionId: string) {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner))
      throw new Error("Conversation not found");
    const runIds = new Set(this.db.prepare("SELECT id FROM tasks WHERE session_id=?").all(sessionId).map(row => String(row.id)));
    const remove: { id: string; text: string; source: string; createdAt: string }[] = [];
    const excluded: { id: string; text: string; reason: string }[] = [];
    for (const record of this.list(owner)) {
      if (!runIds.has(String(record.data.originRunId || record.data.sourceRunId))) continue;
      const text = String(record.data.text);
      if (record.revision > 1) excluded.push({ id: record.id, text, reason: `You edited this after it was saved (revision ${record.revision}), so it stays.` });
      else remove.push({ id: record.id, text, source: String(record.data.source), createdAt: record.createdAt });
    }
    return { sessionId, remove, excluded, suppressed: this.suppressed(owner, sessionId) };
  }
  /** Removes the previewed facts (or a chosen subset) and stops the conversation from saving memory again on its own. */
  forget(owner: string, input: unknown) {
    const { sessionId, ids } = z.object({ sessionId: z.string().uuid(), ids: z.array(MemoryIdSchema).max(500).optional() }).strict().parse(input);
    const preview = this.forgetPreview(owner, sessionId);
    const removable = new Set(preview.remove.map(entry => entry.id));
    const chosen = ids ?? [...removable];
    if (chosen.some(id => !removable.has(id))) throw new Error("Only facts listed in the preview can be forgotten");
    this.db.exec("BEGIN");
    try {
      const remove = this.db.prepare("DELETE FROM memory WHERE owner=? AND id=?");
      for (const id of chosen) remove.run(owner, id);
      this.db.prepare("INSERT OR IGNORE INTO memory_suppressions VALUES(?,?,?)").run(owner, sessionId, new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { sessionId, removed: chosen.length, excluded: preview.excluded, suppressed: true };
  }
  suppressed(owner: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 AS found FROM memory_suppressions WHERE owner=? AND session_id=?").get(owner, sessionId);
  }
  capacity(owner: string) {
    return { count: Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory WHERE owner=?").get(owner)!.count),
      maxFacts: Number(this.db.prepare("SELECT max_facts FROM memory_limits WHERE owner=?").get(owner)?.max_facts ?? 500) };
  }
  configure(owner: string, input: unknown) {
    const { maxFacts } = CapacitySchema.parse(input);
    if (this.capacity(owner).count > maxFacts) throw new Error("Remove memories before lowering capacity below the current count");
    this.db.prepare("INSERT INTO memory_limits VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET max_facts=excluded.max_facts")
      .run(owner, maxFacts);
    return this.capacity(owner);
  }
  get(owner: string, id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memory WHERE owner=? AND id=?").get(owner, id);
    return row ? this.record(row) : undefined;
  }
  list(owner: string): MemoryRecord[] {
    return this.db.prepare("SELECT * FROM memory WHERE owner=? ORDER BY updated_at DESC,id LIMIT 501")
      .all(owner).map(row => this.record(row));
  }
  save(owner: string, id: string, input: unknown): MemoryRecord {
    MemoryIdSchema.parse(id);
    const parsed = NewMemoryDataSchema.parse(input), previous = this.get(owner, id);
    const origin = previous ? (previous.data.originRunId || previous.data.sourceRunId) : (parsed.originRunId || parsed.sourceRunId);
    const data = { ...parsed, ...(origin ? { originRunId: origin } : {}) };
    if (!previous) this.requireRoom(owner, 1);
    if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new Error("Memory revision limit reached");
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    this.db.prepare(`INSERT INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,1)
      ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,revision=memory.revision+1`)
      .run(id, owner, JSON.stringify(data), now, now);
    return this.get(owner, id)!;
  }
  update(owner: string, input: unknown, sourceRunId: string) {
    const value = UpdateMemorySchema.parse(input), previous = this.get(owner, value.id);
    if (!previous) throw new Error("Memory not found");
    if (previous.revision !== value.expectedRevision) throw new Error("Memory changed since you opened it. Reload it before saving.");
    return this.save(owner, value.id, { text: value.text, source: value.source, sourceRunId });
  }
  export(owner: string) {
    if (this.capacity(owner).count > 500) throw new Error("Memory archive exceeds 500 records; reduce legacy memory count before exporting");
    return parseMemoryArchive({ format: "branch-agent-memory", version: 1, exportedAt: new Date().toISOString(),
      records: this.list(owner).map(({ owner: _owner, ...record }) => record) });
  }
  import(owner: string, input: unknown) {
    const archive = parseMemoryArchive(input), additions: ArchiveRecord[] = [];
    for (const record of archive.records) {
      const previous = this.get(owner, record.id);
      if (!previous) additions.push(record);
      else {
        const { owner: _owner, ...saved } = previous;
        if (!isDeepStrictEqual(saved, record)) throw new Error("Memory archive conflicts with an existing identifier; nothing was imported");
      }
    }
    this.requireRoom(owner, additions.length);
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare("INSERT INTO memory(id,owner,data,created_at,updated_at,revision) VALUES(?,?,?,?,?,?)");
      for (const record of additions)
        insert.run(record.id, owner, JSON.stringify(record.data), record.createdAt, record.updatedAt, record.revision);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { imported: additions.length, unchanged: archive.records.length - additions.length };
  }
  search(owner: string, query: string) {
    const normalized = query.normalize("NFC").toLowerCase();
    const results: MemoryRecord[] = [];
    let bytes = 2;
    for (const record of this.list(owner)) {
      if (!String(record.data.text).normalize("NFC").toLowerCase().includes(normalized)) continue;
      const size = Buffer.byteLength(JSON.stringify(record)) + 1;
      if (bytes + size > 48000 || results.length === 20) break;
      results.push(record); bytes += size;
    }
    return results;
  }
  private requireRoom(owner: string, additions: number) {
    const { count, maxFacts } = this.capacity(owner);
    if (additions > 0 && count + additions > maxFacts)
      throw new Error(`Memory capacity reached (${count}/${maxFacts}). Edit or delete a fact, or increase the configured limit.`);
  }
  private record(row: Record<string, unknown>): MemoryRecord {
    return { id: String(row.id), owner: String(row.owner), data: MemoryDataSchema.parse(JSON.parse(String(row.data))),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), revision: Number(row.revision) };
  }
}

export function registerMemory(registry: ToolRegistry, store: Store): void {
  registry.register({ name: "memory.put", description: "Save an explicit bounded fact with source and timestamp.",
    permission: "memory.write", parameters: UpdateMemorySchema.pick({ text: true, source: true }),
    execute: async (value, context) => {
      const sessionId = store.run(context.runId)?.sessionId;
      if (sessionId && store.memorySuppressed(context.owner, sessionId))
        throw new Error("Memory from this conversation was forgotten, so it is not saved again automatically. The owner can save it from the Memory view.");
      return store.save("memory", context.owner, randomUUID(), { ...value, sourceRunId: context.runId });
    } });
  registry.register({ name: "memory.update", description: "Correct an existing fact using its current revision. Stale edits are rejected.",
    permission: "memory.write", parameters: UpdateMemorySchema,
    execute: async (value, context) => store.updateMemory(context.owner, value, context.runId) });
  registry.register({ name: "memory.search", description: "Search this owner's facts by literal text, returning bounded matches and their edit revisions.",
    permission: "memory.read", parameters: z.object({ query: z.string().max(200) }).strict(),
    execute: async (value, context) => store.searchMemory(context.owner, value.query) });
  registry.register({ name: "memory.delete", description: "Delete an owner-scoped memory.", permission: "memory.write",
    parameters: z.object({ id: MemoryIdSchema }).strict(),
    execute: async (value, context) => store.delete("memory", context.owner, value.id) });
}

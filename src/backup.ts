import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensureFlyTables, flyTables } from "./fly-core/state.js";
import { dropIndex } from "./fly-core/fast-index.js";
import { ensureContractTable } from "./self-development-contract.js";
import { ensureWikiTables, wikiTables } from "./wiki.js";

/**
 * Whole-application backup: every table that holds the person's state, as plain rows, so it can be
 * restored into a fresh install. Secrets are left out on purpose: they are encrypted with a key that
 * never leaves the device, so a copy would be unreadable elsewhere.
 */
export const maximumBackupBytes = 64 * 1024 * 1024;
const requiredTables = [
  "sessions", "tasks", "messages", "events", "usage", "compactions",
  "memory", "memory_limits", "memory_suppressions", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints",
  "specialists", "procedures", "schedules", "settings", "deliveries",
  "installed_skills", "skill_versions", "session_branches", "session_origins",
  "file_versions", "workspace_snapshots",
  // Wave 6 (collaboration and workflows): labels, project notes, workflows and their per-step state.
  "labels", "project_notes", "workflows", "workflow_state",
  // Wave 7 (tool loading): what this computer has learned about which tools a request needs.
  "tool_usage", "tool_notes",
  // Wave 7: the knowledge bases themselves — their names, the folders they point at and whether they
  // are in use. Their passages, vectors and cached readings are left out on purpose: those are worked
  // out again from the person's own files by pressing "Read it again", and they would multiply the
  // size of a backup for nothing.
  "kb_collections",
] as const;
/**
 * mac2/fly-core-2: what the learning core has learned, with the wiring seed its weights depend on.
 * These tables only exist once the core has been switched on, so an archive may leave them out.
 */
/**
 * Q12: rows written once and never changed or removed (the self-development contracts, see
 * src/self-development-contract.ts). An archive from before them may leave them out. A restore adds
 * the revisions this install does not have and never replaces or removes one, so each row keeps the
 * hash it was written with.
 */
const appendOnlyTables = ["self_development_contracts"] as const;
const appendOnly = (table: string): boolean => (appendOnlyTables as readonly string[]).includes(table);
export const backupTables = [...requiredTables, ...flyTables, ...appendOnlyTables, ...wikiTables] as const;
const RowSchema = z.record(z.string().regex(/^[a-z_]+$/), z.union([z.string(), z.number(), z.null()]));
const TablesSchema = z.object({
  ...Object.fromEntries(requiredTables.map((table) => [table, z.array(RowSchema)])) as Record<(typeof requiredTables)[number], z.ZodArray<typeof RowSchema>>,
  ...Object.fromEntries(flyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof flyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  ...Object.fromEntries(appendOnlyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof appendOnlyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  // The wiki's pages and their history (src/wiki.ts). A backup from before the wiki has none.
  ...Object.fromEntries(wikiTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof wikiTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
}).strict();
export const BackupArchiveSchema = z.object({
  format: z.literal("branch-agent-backup"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  appVersion: z.string().max(40),
  tables: TablesSchema,
}).strict();
export type BackupArchive = z.infer<typeof BackupArchiveSchema>;

export function parseBackupArchive(input: unknown): BackupArchive {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > maximumBackupBytes) throw new Error("Backup exceeds 64 MiB");
  return BackupArchiveSchema.parse(input);
}

/** Reads every backed-up table in insertion order. */
export function exportBackup(db: DatabaseSync, appVersion: string): BackupArchive {
  const tables: Record<string, Record<string, string | number | null>[]> = {};
  for (const table of backupTables) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => {
      const out: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(row)) out[key] = typeof value === "bigint" ? Number(value) : (value as string | number | null);
      return out;
    });
  }
  return { format: "branch-agent-backup", version: 1, exportedAt: new Date().toISOString(), appVersion, tables: tables as BackupArchive["tables"] };
}

/** Whether this install already holds someone's state; restoring over it is refused. */
export function hasState(db: DatabaseSync): boolean {
  const count = (table: string) => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint }).n);
  // NAS review of #194: a Branch holding only wiki pages has work in it too, so a restore does not merge over them.
  const wiki = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'").get() ? count("wiki_pages") : 0;
  return count("sessions") > 0 || count("memory") > 0 || count("installed_skills") > 0 || wiki > 0;
}

export interface RestoreOptions {
  /**
   * Empties the backed-up tables first, so a safety copy can be put back over work that is already
   * there. Only the update screen uses it, and only after a new version failed its first health check.
   */
  replaceExisting?: boolean;
}

/** Inserts every row of the archive into a fresh install, in one transaction; unknown columns are refused. */
export function importBackup(db: DatabaseSync, input: unknown, options: RestoreOptions = {}): { tables: number; rows: number } {
  const archive = parseBackupArchive(input);
  if (!options.replaceExisting && hasState(db)) throw new Error("This copy already has conversations, memory or skills. Restore into a fresh install (empty data folder) instead.");
  let tables = 0, rows = 0;
  db.exec("BEGIN");
  try {
    if (options.replaceExisting)
      for (const table of [...backupTables].reverse())
        if (!appendOnly(table) && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
    prepareFlyRestore(db, archive);
    if (archive.tables.self_development_contracts?.length) ensureContractTable(db);
    if (wikiTables.some((table) => archive.tables[table]?.length)) ensureWikiTables(db);
    for (const table of backupTables) {
      const list = archive.tables[table];
      if (!list?.length) continue;
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      tables++;
      for (const row of list) {
        const keys = Object.keys(row).filter((k) => columns.has(k));
        if (keys.length !== Object.keys(row).length) throw new Error(`Backup row for ${table} has a column this version does not know`);
        // An append-only row gets a fresh id and is skipped when this install already has that revision.
        const kept = appendOnly(table) ? keys.filter((k) => k !== "id") : keys;
        db.prepare(`INSERT OR ${appendOnly(table) ? "IGNORE" : "REPLACE"} INTO ${table}(${kept.join(",")}) VALUES(${kept.map(() => "?").join(",")})`).run(...kept.map((k) => row[k] ?? null));
        rows++;
      }
    }
    settleFlyRestore(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  dropIndex(db);
  return { tables, rows };
}

/**
 * mac2/fly-core-2. The core's weights only mean something under the wiring seed they were learned
 * with, so an owner's learning is restored whole or not at all: whatever this install already holds
 * for an owner named in the archive's `fly_*` rows is cleared first. The tables are made if this
 * install never switched the core on.
 */
function prepareFlyRestore(db: DatabaseSync, archive: BackupArchive): void {
  const owners = new Set(flyTables.flatMap((table) => (archive.tables[table] ?? []).map((row) => String(row.owner ?? ""))));
  if (!owners.size) return;
  ensureFlyTables(db);
  for (const owner of owners)
    for (const table of flyTables) db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner);
}
/**
 * No trace may point at a task that is not there or that is someone else's (same owner and same
 * conversation), and no weight may outlive its wiring seed.
 */
function settleFlyRestore(db: DatabaseSync): void {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fly_traces'").get()) return;
  db.exec(`DELETE FROM fly_traces WHERE NOT EXISTS (SELECT 1 FROM tasks
      WHERE tasks.id = fly_traces.run_id AND tasks.owner = fly_traces.owner AND tasks.session_id = fly_traces.session_id);
    DELETE FROM fly_traces WHERE owner NOT IN (SELECT owner FROM fly_wiring);
    DELETE FROM fly_synapses WHERE owner NOT IN (SELECT owner FROM fly_wiring);`);
}

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Whole-application backup: every table that holds the person's state, as plain rows, so it can be
 * restored into a fresh install. Secrets are left out on purpose: they are encrypted with a key that
 * never leaves the device, so a copy would be unreadable elsewhere.
 */
export const maximumBackupBytes = 64 * 1024 * 1024;
export const backupTables = [
  "sessions", "tasks", "messages", "events", "usage", "compactions",
  "memory", "memory_limits", "memory_suppressions", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints",
  "specialists", "procedures", "schedules", "settings", "deliveries",
  "installed_skills", "skill_versions", "session_branches", "session_origins",
  "file_versions", "workspace_snapshots",
  // Wave 6 (collaboration and workflows): labels, project notes, workflows and their per-step state.
  "labels", "project_notes", "workflows", "workflow_state",
  // Wave 7 (tool loading): what this computer has learned about which tools a request needs.
  "tool_usage", "tool_notes",
] as const;
const RowSchema = z.record(z.string().regex(/^[a-z_]+$/), z.union([z.string(), z.number(), z.null()]));
export const BackupArchiveSchema = z.object({
  format: z.literal("branch-agent-backup"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  appVersion: z.string().max(40),
  tables: z.record(z.enum(backupTables), z.array(RowSchema)),
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
  return count("sessions") > 0 || count("memory") > 0 || count("installed_skills") > 0;
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
        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`);
    for (const table of backupTables) {
      const list = archive.tables[table];
      if (!list?.length) continue;
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      tables++;
      for (const row of list) {
        const keys = Object.keys(row).filter((k) => columns.has(k));
        if (keys.length !== Object.keys(row).length) throw new Error(`Backup row for ${table} has a column this version does not know`);
        db.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map((k) => row[k] ?? null));
        rows++;
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { tables, rows };
}

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ensureFlyTables, flyTables } from "./fly-core/state.js";
import { dropIndex } from "./fly-core/fast-index.js";
import { ensureContractTable } from "./self-development-contract.js";

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
export const backupTables = [...requiredTables, ...flyTables, ...appendOnlyTables] as const;
const RowSchema = z.record(z.string().regex(/^[a-z_]+$/), z.union([z.string(), z.number(), z.null()]));
const TablesSchema = z.object({
  ...Object.fromEntries(requiredTables.map((table) => [table, z.array(RowSchema)])) as Record<(typeof requiredTables)[number], z.ZodArray<typeof RowSchema>>,
  ...Object.fromEntries(flyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof flyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
  ...Object.fromEntries(appendOnlyTables.map((table) => [table, z.array(RowSchema).optional()])) as Record<(typeof appendOnlyTables)[number], z.ZodOptional<z.ZodArray<typeof RowSchema>>>,
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

/**
 * Sign-ins stay on this computer. A backup never carries these settings, and a restore neither writes nor removes them:
 * a passkey the owner took away came back with an older backup, and one planted in a changed file let its holder sign in
 * as a person here (Mac mini 6534228). The people's passkeys, whether they may sign in from elsewhere, OIDC sign-ins
 * waiting, which steps a phone must pass, and the paired devices' secret fingerprints.
 * Also everyone and everything else paired with this computer (NAS review of #186): the devices it lends itself to,
 * with their keys (`devices-book`), which chat senders may reach the assistant (`sender-allowlist`, each approved
 * `channel-pair:<chat>:<sender>`), and the other Branch installs it sends work to with their keys (`remote-agent:<id>`).
 * An older backup must not let a disconnected sender or a revoked device back in, nor a changed one plant them.
 */
export const signInSettings: readonly string[] = ["people-passkeys", "people-signin", "people-oidc-waiting", "remote-gateway-auth",
  "remote-devices", "devices-book", "sender-allowlist"];
/** Settings kept on this computer by the start of their id: one row per paired chat sender, or per other install. */
export const signInPrefixes: readonly string[] = ["channel-pair:", "remote-agent:"];
/**
 * What else is about this computer and whom it trusts, not about the owner's work (Q168 A), so it stays here
 * too: which workspaces' integration files are trusted to load, the outside assistants this Branch pairs with,
 * the SSH computers and the programs Branch may run on them, and the commands that fetch secrets. From a file,
 * each one could point Branch at a program, a machine or a person the owner never chose here.
 */
export const thisComputerSettings: readonly string[] = [
  "folder_trust", "folder_trust_mode", "folder-trust-real", "remote-agent-pairing", "remote-computers", "secret-commands",
];
/**
 * Whether a settings row stays on this computer: never in a backup, never taken from one, and kept by a replacing
 * restore. One test for all three, so what a backup leaves out and what a replace keeps can never drift apart.
 */
export const staysOnThisComputer = (id: string): boolean =>
  signInSettings.includes(id) || thisComputerSettings.includes(id) || signInPrefixes.some((start) => id.startsWith(start));
const staysHere = (table: string, row: Record<string, unknown>): boolean => table === "settings" && staysOnThisComputer(String(row.id));

/**
 * A restored schedule keeps its job but not its standing yes (Q168 C). Its check script waits for the
 * owner to approve it again (the scheduler pauses it and asks), and its webhook gets a token made on
 * this computer. Without this, a changed backup could bring a check program that approves itself, or a
 * webhook whose token the file's maker already holds.
 *
 * A schedule whose data is not a plain JSON object is left out of the restore (null): it cannot be disarmed, and
 * SQLite reads JSON5, so the next start would rewrite it into a job that still carries the file's yes (NAS 54d30f2).
 */
function disarmed<Row extends Record<string, unknown>>(table: string, row: Row): Row | null {
  if (table !== "schedules") return row;
  if (typeof row.data !== "string") return null;
  let job: unknown;
  try { job = JSON.parse(row.data); } catch { return null; }
  if (!job || typeof job !== "object" || Array.isArray(job)) return null;
  const kept: Record<string, unknown> = { ...job };
  if ("gateApproved" in kept) kept.gateApproved = null;
  // Only a job that has a webhook gets a new token; an empty one would otherwise switch a webhook on.
  if (typeof kept.hookToken === "string" && kept.hookToken) kept.hookToken = randomBytes(24).toString("hex");
  return { ...row, data: JSON.stringify(kept) } as Row;
}

/** Reads every backed-up table in insertion order. */
export function exportBackup(db: DatabaseSync, appVersion: string): BackupArchive {
  const tables: Record<string, Record<string, string | number | null>[]> = {};
  for (const table of backupTables) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    tables[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().filter((row) => !staysHere(table, row)).map((row) => {
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
        if (!appendOnly(table) && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
          if (table === "settings") {
            const kept = (db.prepare("SELECT DISTINCT id FROM settings").all() as { id: string }[]).map((row) => row.id).filter(staysOnThisComputer);
            db.prepare(`DELETE FROM settings WHERE id NOT IN (${kept.map(() => "?").join(",")})`).run(...kept);
          }
          else db.exec(`DELETE FROM ${table}`);
    prepareFlyRestore(db, archive);
    if (archive.tables.self_development_contracts?.length) ensureContractTable(db);
    for (const table of backupTables) {
      const list = archive.tables[table];
      if (!list?.length) continue;
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
      tables++;
      for (const given of list) {
        if (staysHere(table, given)) continue;
        const row = disarmed(table, given);
        if (!row) continue;
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

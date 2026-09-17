import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned changes to a database's shape. Each change has a way back, and says the oldest data
 * format that can still read the result, so an update can go back one release without losing the
 * owner's work. The rules, in docs/never-break.md:
 *
 * - a change adds; it never renames or drops what the previous release reads, so for most changes
 *   "the way back" is to leave the extra column alone, and `readableBy` stays the old number;
 * - a copy is taken before any change runs (`VACUUM INTO`), and the change runs in one transaction;
 * - a program that finds data newer than it can read stops with a sentence instead of touching it.
 */
export interface Migration {
  version: number;
  /** The oldest format that can still read data at this version. */
  readableBy: number;
  up(db: DatabaseSync): void;
  down(db: DatabaseSync): void;
}

export class DataTooNewError extends Error {
  constructor(readonly found: number, readonly readableBy: number, readonly understood: number) {
    super(`Your saved work was last opened by a newer version of Branch (data format ${found}), which this version (format ${understood}) cannot read safely. Nothing was changed. Install the newer version again, or go back to the copy taken before the update.`);
  }
}

const formatTable = "CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)";

export function formatOf(db: DatabaseSync): { version: number; readableBy: number } {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='branch_format'").get();
  const row = table ? db.prepare("SELECT readable_by FROM branch_format WHERE id=1").get() as { readable_by: number } | undefined : undefined;
  return { version, readableBy: row ? Number(row.readable_by) : version };
}

function stamp(db: DatabaseSync, version: number, readableBy: number): void {
  db.exec(formatTable);
  db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by, changed_at=excluded.changed_at")
    .run(version, readableBy, new Date().toISOString());
  db.exec(`PRAGMA user_version=${Math.trunc(version)}`);
}

export interface MigrateOptions {
  /** Where to write the copy taken first; null when the caller took one already or the data is disposable. */
  backupTo: string | null;
}
export interface MigrateReport { from: number; to: number; backup: string | null }

/** Brings a database up to the newest version this program knows, or refuses data it cannot read. */
export function migrate(db: DatabaseSync, list: Migration[], options: MigrateOptions): MigrateReport {
  const ordered = [...list].sort((a, b) => a.version - b.version);
  const newest = ordered.at(-1)?.version ?? 0;
  const found = formatOf(db);
  if (found.version > newest) {
    if (found.readableBy > newest) throw new DataTooNewError(found.version, found.readableBy, newest);
    return { from: found.version, to: found.version, backup: null };
  }
  const pending = ordered.filter((step) => step.version > found.version);
  if (!pending.length) return { from: found.version, to: found.version, backup: null };
  let backup: string | null = null;
  if (options.backupTo && found.version > 0) {
    if (existsSync(options.backupTo)) throw new Error(`A copy is already waiting at ${options.backupTo}; move it before trying again.`);
    db.exec(`VACUUM INTO '${options.backupTo.replace(/'/g, "''")}'`);
    backup = options.backupTo;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of pending) step.up(db);
    const last = pending.at(-1)!;
    stamp(db, last.version, last.readableBy);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { from: found.version, to: newest, backup };
}

/** Takes a database back to an earlier version, running each change's way back, newest first. */
export function migrateDown(db: DatabaseSync, list: Migration[], to: number): MigrateReport {
  const found = formatOf(db);
  const undo = [...list].filter((step) => step.version > to && step.version <= found.version).sort((a, b) => b.version - a.version);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of undo) step.down(db);
    const kept = [...list].filter((step) => step.version <= to).sort((a, b) => a.version - b.version).at(-1);
    stamp(db, to, kept?.readableBy ?? to);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { from: found.version, to, backup: null };
}

/**
 * The saved-work database's own format. Version 1 is everything Branch wrote before formats were
 * numbered: the store creates and extends its own tables, only ever adding, so there is nothing to
 * run in either direction. Later changes are added here with their way back.
 */
export const storeMigrations: Migration[] = [
  { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
];

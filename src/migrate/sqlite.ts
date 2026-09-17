import { DatabaseSync } from "node:sqlite";
import type { SourceTree } from "./source-tree.js";

/**
 * Another assistant's database, opened from a private copy so the original is never locked,
 * changed or checkpointed while that assistant may still be running. `close` shuts the copy and
 * removes it.
 */
export interface OpenedDatabase {
  db: DatabaseSync;
  /** The columns a table really has, so a reader can cope with an older or newer version of it. */
  columns(table: string): Set<string>;
  close(): Promise<void>;
}

export async function openCopy(tree: SourceTree, path: string): Promise<OpenedDatabase | null> {
  const copy = await tree.copyOut(path);
  if (!copy) return null;
  let db: DatabaseSync;
  try { db = new DatabaseSync(copy.path); }
  catch { await copy.discard(); return null; }
  const known = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name)));
  return {
    db,
    columns(table) {
      if (!known.has(table)) return new Set();
      return new Set(db.prepare(`PRAGMA table_info("${table.replace(/"/g, "")}")`).all().map((row) => String(row.name)));
    },
    async close() {
      try { db.close(); } catch { /* already closed */ }
      await copy.discard();
    },
  };
}

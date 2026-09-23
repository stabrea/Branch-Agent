import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createTables } from "../dist/store.js";

let tempDirs = [];

process.on("exit", async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

export function createDiskStore() {
  const root = tmpdir();
  const dbPath = join(root, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  createTables(db);

  return {
    db,
    get(table, id, key) {
      try {
        const row = db.prepare("SELECT data FROM ? WHERE id = ? AND key = ?").get(table, id, key);
        return row ? JSON.parse(row.data) : undefined;
      } catch {
        return undefined;
      }
    },
    save(table, id, key, data) {
      db.prepare(`INSERT OR REPLACE INTO ${table} (id, key, data, at) VALUES (?, ?, ?, ?)`).run(
        id, key, JSON.stringify(data), new Date().toISOString()
      );
    },
    event(id, kind, data) {
      // best-effort logging
    },
  };
}

export async function openFeatureDb() {
  const root = await mkdtemp(join(tmpdir(), "test-features-"));
  tempDirs.push(root);
  const dbPath = join(root, "features.db");
  const db = new Database(dbPath);
  createTables(db);
  return db;
}

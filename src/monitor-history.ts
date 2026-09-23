import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * The looks a watch has taken, kept instead of thrown away. `Monitors` itself remembers only the
 * latest snapshot, overwriting it on every check so it can tell whether the next look differs; that
 * is fine for noticing a change, but it means the very observation that proved a change happened
 * was gone the moment anyone asked to see it. Every look a watch takes is appended here instead,
 * newest first, and older ones already stored are never touched — only pruned once a watch has more
 * than `keepPerMonitor` of them, so a watch that runs for months does not grow without limit.
 */
const keepPerMonitor = 20;

export interface Observation {
  id: string;
  observedAt: string;
  hash: string;
  snapshot: string;
  /** Whether this look differed from the one before it. */
  changed: boolean;
}

export class MonitorObservations {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS monitor_observations(id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL,
      observed_at TEXT NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS monitor_observations_monitor ON monitor_observations(monitor_id, observed_at);`);
  }

  /** Appends one look; the earlier ones already stored for this watch are left exactly as they were. */
  record(monitorId: string, observedAt: string, hash: string, snapshot: string, changed: boolean): void {
    this.db.prepare(`INSERT INTO monitor_observations(id, monitor_id, observed_at, hash, snapshot, changed)
      VALUES(?,?,?,?,?,?)`).run(randomUUID(), monitorId, observedAt, hash, snapshot, changed ? 1 : 0);
    const ids = this.db.prepare("SELECT id FROM monitor_observations WHERE monitor_id=? ORDER BY observed_at DESC")
      .all(monitorId).map((row) => String((row as Record<string, unknown>).id));
    for (const stale of ids.slice(keepPerMonitor)) this.db.prepare("DELETE FROM monitor_observations WHERE id=?").run(stale);
  }

  /** Every look kept for one watch, newest first. */
  list(monitorId: string): Observation[] {
    return this.db.prepare("SELECT * FROM monitor_observations WHERE monitor_id=? ORDER BY observed_at DESC LIMIT ?")
      .all(monitorId, keepPerMonitor).map((value) => {
        const row = value as Record<string, unknown>;
        return {
          id: String(row.id), observedAt: String(row.observed_at), hash: String(row.hash),
          snapshot: String(row.snapshot), changed: Number(row.changed) === 1,
        };
      });
  }

  /** Drops everything kept for one watch, when the watch itself is removed. */
  forget(monitorId: string): void {
    this.db.prepare("DELETE FROM monitor_observations WHERE monitor_id=?").run(monitorId);
  }
}

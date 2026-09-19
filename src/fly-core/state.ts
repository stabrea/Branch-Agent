import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Circuit, actionKey, type ActionKind, type ActionState, type ActionUse, type Scored } from "./circuit.js";
import type { KenyonCode } from "./encode.js";
import { dropIndex, existingIndex, indexFor } from "./fast-index.js";

/**
 * Where the learning core keeps what it has learned: in the same SQLite database as everything
 * else, in its own tables. Weights are stored only where they differ from the starting strength,
 * as base64 text (so a row stays plain text), and the wiring seed is stored once per owner.
 *
 * Nothing here holds the words of a request: a trace keeps only the active cell numbers and the
 * names of the actions taken.
 */
export interface Trace { runId: string; sessionId: string; code: KenyonCode; uses: ActionUse[]; at: number }
export interface Pattern { fingerprint: string; successes: number; failures: number; proposedAt: string | null }

/** Most actions kept per owner; the ones changed longest ago go first. */
export const maximumActions = 5000;
/** Traces kept per owner, for a correction that arrives in the next task. */
export const maximumTraces = 200;
/** Step patterns counted per owner; the ones seen longest ago go first. */
export const maximumPatterns = 2000;

/** A sparse weight map as base64: 2 bytes of cell number and 4 of value per entry. */
export function packWeights(weights: Map<number, number>): string {
  const bytes = Buffer.alloc(weights.size * 6);
  let at = 0;
  for (const [cell, value] of weights) {
    bytes.writeUInt16LE(cell, at);
    bytes.writeFloatLE(value, at + 2);
    at += 6;
  }
  return bytes.toString("base64");
}
export function unpackWeights(text: string): Map<number, number> {
  const bytes = Buffer.from(text, "base64"), weights = new Map<number, number>();
  for (let at = 0; at + 6 <= bytes.length; at += 6) weights.set(bytes.readUInt16LE(at), bytes.readFloatLE(at + 2));
  return weights;
}

/** Every table the core keeps, in the order a restore fills them. */
export const flyTables = ["fly_wiring", "fly_synapses", "fly_traces", "fly_patterns"] as const;

/** Creates the core's tables when they are not there yet. Off never calls this. */
export function ensureFlyTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fly_wiring(owner TEXT PRIMARY KEY, seed TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fly_synapses(owner TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, approach TEXT NOT NULL, avoid TEXT NOT NULL, uses INTEGER NOT NULL, net REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, kind, action));
    CREATE TABLE IF NOT EXISTS fly_traces(run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, code TEXT NOT NULL, uses TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fly_patterns(owner TEXT NOT NULL, fingerprint TEXT NOT NULL, successes INTEGER NOT NULL, failures INTEGER NOT NULL, proposed_at TEXT, seen_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner, fingerprint));`);
}

/** What has been learned about one action, for the owner to read. */
export interface Habit { kind: ActionKind; action: string; uses: number; net: number; updatedAt: number }

export class FlyState {
  constructor(private readonly db: DatabaseSync) {
    ensureFlyTables(db);
  }
  /** The owner's wiring seed, chosen once and never changed afterwards. */
  seed(owner: string): string {
    const found = this.db.prepare("SELECT seed FROM fly_wiring WHERE owner=?").get(owner);
    if (found) return String(found.seed);
    const seed = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO fly_wiring(owner, seed, created_at) VALUES(?,?,?)").run(owner, seed, new Date().toISOString());
    return String(this.db.prepare("SELECT seed FROM fly_wiring WHERE owner=?").get(owner)!.seed);
  }
  load(owner: string): Circuit {
    return this.fill(new Circuit(), this.db.prepare("SELECT * FROM fly_synapses WHERE owner=?").all(owner));
  }
  /**
   * Every action ranked for a situation, from the index kept in memory (fast-index.ts). The first
   * call after a launch reads the table once; later calls read nothing.
   */
  rank(owner: string, code: KenyonCode, now: number, least = 0): Record<ActionKind, Scored[]> {
    return indexFor(this.db, owner, () => this.db.prepare("SELECT kind, action, approach, avoid, uses, updated_at FROM fly_synapses WHERE owner=?")
      .all(owner).map((row) => ({
        kind: String(row.kind) as ActionKind, action: String(row.action), approach: String(row.approach), avoid: String(row.avoid),
        uses: Number(row.uses), updatedAt: Number(row.updated_at),
      }))).rank(code, now, least);
  }
  /**
   * Only the named actions: what a finished task needs to learn from. It keeps the work done as a
   * task settles in proportion to that task, however much has been learned overall.
   */
  loadSome(owner: string, actions: readonly { kind: ActionKind; action: string }[]): Circuit {
    const get = this.db.prepare("SELECT * FROM fly_synapses WHERE owner=? AND kind=? AND action=?");
    return this.fill(new Circuit(), actions.flatMap((a) => { const row = get.get(owner, a.kind, a.action.slice(0, 200)); return row ? [row] : []; }));
  }
  private fill(circuit: Circuit, rows: readonly Record<string, unknown>[]): Circuit {
    for (const row of rows) {
      const kind = String(row.kind) as ActionKind, action = String(row.action);
      circuit.actions.set(`${kind}:${action}`, {
        action, kind, approach: unpackWeights(String(row.approach)), avoid: unpackWeights(String(row.avoid)),
        uses: Number(row.uses), net: Number(row.net), updatedAt: Number(row.updated_at),
      });
    }
    return circuit;
  }
  /**
   * Writes what was learned in one transaction. One row at a time, each its own commit, cost a
   * journal file and a flush to disk per row: 5,000 actions took ten minutes on Windows, where every
   * new journal file is also scanned, against seconds on a Mac.
   */
  save(owner: string, states: readonly ActionState[]): void {
    const put = this.db.prepare(`INSERT INTO fly_synapses(owner, kind, action, approach, avoid, uses, net, updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(owner, kind, action) DO UPDATE SET approach=excluded.approach, avoid=excluded.avoid, uses=excluded.uses, net=excluded.net, updated_at=excluded.updated_at`);
    const saved = states.map((s) => ({ ...s, action: s.action.slice(0, 200), updatedAt: Math.round(s.updatedAt) }));
    const drop = this.db.prepare("DELETE FROM fly_synapses WHERE owner=? AND kind=? AND action=?");
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    let dropped = 0;
    try {
      for (const s of saved)
        put.run(owner, s.kind, s.action, packWeights(s.approach), packWeights(s.avoid), s.uses, s.net, s.updatedAt);
      const over = this.db.prepare(`SELECT kind, action FROM fly_synapses WHERE owner=? ORDER BY updated_at DESC LIMIT -1 OFFSET ?`)
        .all(owner, maximumActions);
      for (const row of over) drop.run(owner, String(row.kind), String(row.action));
      dropped = over.length;
      if (own) this.db.exec("COMMIT");
    } catch (error) {
      if (own && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    const index = existingIndex(this.db, owner);
    index?.put(saved);
    if (!dropped) return;
    const kept = this.db.prepare("SELECT kind, action FROM fly_synapses WHERE owner=?").all(owner);
    index?.keep(new Set(kept.map((row) => actionKey(String(row.kind) as ActionKind, String(row.action)))));
  }
  /** What has been learned, most used first, without the weights. */
  habits(owner: string, limit = 200): Habit[] {
    return this.db.prepare("SELECT kind, action, uses, net, updated_at FROM fly_synapses WHERE owner=? ORDER BY uses DESC, updated_at DESC LIMIT ?")
      .all(owner, limit).map((row) => ({
        kind: String(row.kind) as ActionKind, action: String(row.action), uses: Number(row.uses), net: Number(row.net), updatedAt: Number(row.updated_at),
      }));
  }
  /** How much is kept for an owner, in rows. */
  counts(owner: string): { actions: number; traces: number; patterns: number } {
    const n = (table: string): number => Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner=?`).get(owner)?.n ?? 0);
    return { actions: n("fly_synapses"), traces: n("fly_traces"), patterns: n("fly_patterns") };
  }
  /**
   * Forgets everything learned for an owner, the wiring seed included, so what comes next starts
   * from nothing. Returns how many rows went.
   */
  forget(owner: string): number {
    let removed = 0;
    this.db.exec("BEGIN");
    try {
      for (const table of flyTables) removed += Number(this.db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner).changes);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    dropIndex(this.db, owner);
    return removed;
  }
  saveTrace(owner: string, trace: Trace): void {
    this.db.prepare("INSERT OR REPLACE INTO fly_traces(run_id, owner, session_id, code, uses, at) VALUES(?,?,?,?,?,?)")
      .run(trace.runId, owner, trace.sessionId, trace.code.join(","), JSON.stringify(trace.uses), Math.round(trace.at));
    this.db.prepare(`DELETE FROM fly_traces WHERE owner=? AND run_id IN (SELECT run_id FROM fly_traces WHERE owner=?
      ORDER BY at DESC LIMIT -1 OFFSET ?)`).run(owner, owner, maximumTraces);
  }
  /** The most recent trace in a conversation, taken out so a correction is only applied once. */
  takeLastTrace(owner: string, sessionId: string): Trace | undefined {
    const row = this.db.prepare("SELECT * FROM fly_traces WHERE owner=? AND session_id=? ORDER BY at DESC LIMIT 1").get(owner, sessionId);
    if (!row) return undefined;
    this.db.prepare("DELETE FROM fly_traces WHERE run_id=?").run(String(row.run_id));
    const code = String(row.code) ? String(row.code).split(",").map(Number) : [];
    return { runId: String(row.run_id), sessionId, code, uses: JSON.parse(String(row.uses)) as ActionUse[], at: Number(row.at) };
  }
  /** Counts one more success or failure of a pattern and returns where it stands. */
  countPattern(owner: string, fingerprint: string, ok: boolean, now = Date.now()): Pattern {
    this.db.prepare(`INSERT INTO fly_patterns(owner, fingerprint, successes, failures, seen_at) VALUES(?,?,?,?,?)
      ON CONFLICT(owner, fingerprint) DO UPDATE SET successes=successes+excluded.successes, failures=failures+excluded.failures, seen_at=excluded.seen_at`)
      .run(owner, fingerprint, ok ? 1 : 0, ok ? 0 : 1, Math.round(now));
    this.db.prepare(`DELETE FROM fly_patterns WHERE owner=? AND fingerprint IN (SELECT fingerprint FROM fly_patterns WHERE owner=?
      ORDER BY seen_at DESC LIMIT -1 OFFSET ?)`).run(owner, owner, maximumPatterns);
    const row = this.db.prepare("SELECT * FROM fly_patterns WHERE owner=? AND fingerprint=?").get(owner, fingerprint)!;
    return { fingerprint, successes: Number(row.successes), failures: Number(row.failures), proposedAt: row.proposed_at ? String(row.proposed_at) : null };
  }
  markProposed(owner: string, fingerprint: string): void {
    this.db.prepare("UPDATE fly_patterns SET proposed_at=? WHERE owner=? AND fingerprint=?").run(new Date().toISOString(), owner, fingerprint);
  }
}

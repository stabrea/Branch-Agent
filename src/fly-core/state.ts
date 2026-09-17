import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Circuit, type ActionKind, type ActionState, type ActionUse } from "./circuit.js";
import type { KenyonCode } from "./encode.js";

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

export class FlyState {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS fly_wiring(owner TEXT PRIMARY KEY, seed TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fly_synapses(owner TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL, approach TEXT NOT NULL, avoid TEXT NOT NULL, uses INTEGER NOT NULL, net REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner, kind, action));
      CREATE TABLE IF NOT EXISTS fly_traces(run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, code TEXT NOT NULL, uses TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fly_patterns(owner TEXT NOT NULL, fingerprint TEXT NOT NULL, successes INTEGER NOT NULL, failures INTEGER NOT NULL, proposed_at TEXT, PRIMARY KEY(owner, fingerprint));`);
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
    const circuit = new Circuit();
    for (const row of this.db.prepare("SELECT * FROM fly_synapses WHERE owner=?").all(owner)) {
      const kind = String(row.kind) as ActionKind, action = String(row.action);
      circuit.actions.set(`${kind}:${action}`, {
        action, kind, approach: unpackWeights(String(row.approach)), avoid: unpackWeights(String(row.avoid)),
        uses: Number(row.uses), net: Number(row.net), updatedAt: Number(row.updated_at),
      });
    }
    return circuit;
  }
  save(owner: string, states: readonly ActionState[]): void {
    const put = this.db.prepare(`INSERT INTO fly_synapses(owner, kind, action, approach, avoid, uses, net, updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(owner, kind, action) DO UPDATE SET approach=excluded.approach, avoid=excluded.avoid, uses=excluded.uses, net=excluded.net, updated_at=excluded.updated_at`);
    for (const s of states)
      put.run(owner, s.kind, s.action.slice(0, 200), packWeights(s.approach), packWeights(s.avoid), s.uses, s.net, Math.round(s.updatedAt));
    this.db.prepare(`DELETE FROM fly_synapses WHERE owner=? AND rowid IN (SELECT rowid FROM fly_synapses WHERE owner=?
      ORDER BY updated_at DESC LIMIT -1 OFFSET ?)`).run(owner, owner, maximumActions);
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
  countPattern(owner: string, fingerprint: string, ok: boolean): Pattern {
    this.db.prepare(`INSERT INTO fly_patterns(owner, fingerprint, successes, failures) VALUES(?,?,?,?)
      ON CONFLICT(owner, fingerprint) DO UPDATE SET successes=successes+excluded.successes, failures=failures+excluded.failures`)
      .run(owner, fingerprint, ok ? 1 : 0, ok ? 0 : 1);
    const row = this.db.prepare("SELECT * FROM fly_patterns WHERE owner=? AND fingerprint=?").get(owner, fingerprint)!;
    return { fingerprint, successes: Number(row.successes), failures: Number(row.failures), proposedAt: row.proposed_at ? String(row.proposed_at) : null };
  }
  markProposed(owner: string, fingerprint: string): void {
    this.db.prepare("UPDATE fly_patterns SET proposed_at=? WHERE owner=? AND fingerprint=?").run(new Date().toISOString(), owner, fingerprint);
  }
}

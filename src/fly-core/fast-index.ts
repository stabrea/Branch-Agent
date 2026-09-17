import type { DatabaseSync } from "node:sqlite";
import { actionKey, retention, type ActionKind, type ActionState, type Scored } from "./circuit.js";
import type { KenyonCode } from "./encode.js";
import { kenyonCells } from "./sizes.js";

/**
 * What a task needs at its start, kept ready in memory so ranking never reads the whole table.
 *
 * `scoreOf` in circuit.ts only ever reads, per active cell, approach minus avoid, whether either
 * side had changed there, and the action's age. This index keeps exactly that for every action as
 * a typed array of cells and one of differences (6 bytes a cell), so ranking marks the task's
 * active cells once and walks each action's cells against the mark. Nothing is decoded and almost
 * nothing is allocated while a task starts.
 *
 * The ranking is the one `Circuit.rank` gives for every action that shares a changed cell with the
 * situation (the test "F13" holds the two side by side); an action that shares none scores 0, and
 * a score of 0 is never suggested. Differences are kept as 32-bit floats, as the table stores them.
 *
 * The index belongs to one database connection and one owner. It is built once, on first use,
 * then updated by every save and dropped by "forget" and by a restore. A change written by another
 * connection shows up in SQLite's `data_version`, and the index is then built again.
 */
interface Entry { action: string; kind: ActionKind; uses: number; updatedAt: number; cells: Uint16Array; diffs: Float32Array }
export interface IndexRow { kind: ActionKind; action: string; approach: string; avoid: string; uses: number; updatedAt: number }

/** Scratch space shared by every build and every ranking; JavaScript runs one of them at a time. */
const sums = new Float64Array(kenyonCells);
const seen = new Uint32Array(kenyonCells);
const marked = new Uint8Array(kenyonCells);
let stamp = 0;

/** Adds one side, `sign` times, into the scratch sums, and notes each cell it touches. */
function gather(cells: number[], each: (visit: (cell: number, value: number) => void) => void, sign: number): void {
  each((cell, value) => {
    if (cell >= kenyonCells) return;
    if (seen[cell] !== stamp) { seen[cell] = stamp; sums[cell] = 0; cells.push(cell); }
    sums[cell] = sums[cell]! + sign * value;
  });
}
function finish(base: Omit<Entry, "cells" | "diffs">, cells: number[]): Entry {
  const diffs = new Float32Array(cells.length);
  cells.forEach((cell, at) => { diffs[at] = sums[cell]!; });
  return { ...base, cells: Uint16Array.from(cells), diffs };
}
const packed = (text: string) => (visit: (cell: number, value: number) => void): void => {
  const bytes = Buffer.from(text, "base64");
  for (let at = 0; at + 6 <= bytes.length; at += 6) visit(bytes.readUInt16LE(at), bytes.readFloatLE(at + 2));
};
const mapped = (side: Map<number, number>) => (visit: (cell: number, value: number) => void): void => {
  for (const [cell, value] of side) visit(cell, Math.fround(value));
};

/** One action, straight from its stored row, without building maps. */
export function entryOfRow(row: IndexRow): Entry {
  stamp += 1;
  const cells: number[] = [];
  gather(cells, packed(row.approach), 1);
  gather(cells, packed(row.avoid), -1);
  return finish({ action: row.action, kind: row.kind, uses: row.uses, updatedAt: row.updatedAt }, cells);
}
/** One action as it has just been learned, rounded as the table will store it. */
export function entryOf(state: ActionState): Entry {
  stamp += 1;
  const cells: number[] = [];
  gather(cells, mapped(state.approach), 1);
  gather(cells, mapped(state.avoid), -1);
  return finish({ action: state.action, kind: state.kind, uses: state.uses, updatedAt: state.updatedAt }, cells);
}

const order = (a: Scored, b: Scored): number => b.score - a.score || b.evidence - a.evidence || a.action.localeCompare(b.action);

export class RankIndex {
  private readonly entries = new Map<string, Entry>();
  constructor(readonly version: number) {}
  putRows(rows: readonly IndexRow[]): void {
    for (const row of rows) this.entries.set(actionKey(row.kind, row.action), entryOfRow(row));
  }
  put(states: readonly ActionState[]): void {
    for (const state of states) this.entries.set(actionKey(state.kind, state.action), entryOf(state));
  }
  keep(keys: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (!keys.has(key)) this.entries.delete(key);
  }
  get size(): number { return this.entries.size; }
  /**
   * Every action that shares a changed cell with this situation and scores at least `least` either
   * way, best first per kind, in the order `Circuit.rank` uses.
   */
  rank(code: KenyonCode, now: number, least = 0): Record<ActionKind, Scored[]> {
    const out: Record<ActionKind, Scored[]> = { tool: [], skill: [], memory: [] };
    if (!code.length) return out;
    for (const cell of code) marked[cell] = 1;
    try {
      for (const entry of this.entries.values()) this.score(entry, code.length, now, least, out);
    } finally {
      for (const cell of code) marked[cell] = 0;
    }
    for (const list of Object.values(out)) list.sort(order);
    return out;
  }
  private score(entry: Entry, active: number, now: number, least: number, out: Record<ActionKind, Scored[]>): void {
    const { cells, diffs } = entry;
    let sum = 0, touched = 0;
    for (let at = 0; at < cells.length; at += 1)
      if (marked[cells[at]!]) { sum += diffs[at]!; touched += 1; }
    if (!touched) return;
    const score = (sum * retention(now - entry.updatedAt)) / active;
    if (Math.abs(score) < least) return;
    out[entry.kind].push({ action: entry.action, kind: entry.kind, score, evidence: touched / active, uses: entry.uses });
  }
}

const indexes = new WeakMap<DatabaseSync, Map<string, RankIndex>>();
/** SQLite's own counter of changes made by other connections; ours do not move it. */
export const dataVersion = (db: DatabaseSync): number => Number(db.prepare("PRAGMA data_version").get()?.data_version ?? 0);

/** The ready index for an owner, built from `rows` when there is none or another connection wrote. */
export function indexFor(db: DatabaseSync, owner: string, rows: () => IndexRow[]): RankIndex {
  let byOwner = indexes.get(db);
  if (!byOwner) { byOwner = new Map(); indexes.set(db, byOwner); }
  const version = dataVersion(db);
  let found = byOwner.get(owner);
  if (!found || found.version !== version) {
    found = new RankIndex(version);
    found.putRows(rows());
    byOwner.set(owner, found);
  }
  return found;
}
/** The index as it stands, without building one; saves only update an index that is already there. */
export function existingIndex(db: DatabaseSync, owner: string): RankIndex | undefined {
  return indexes.get(db)?.get(owner);
}
/** Drops what is kept for one owner, or for everyone on this connection. */
export function dropIndex(db: DatabaseSync, owner?: string): void {
  if (owner === undefined) indexes.delete(db); else indexes.get(db)?.delete(owner);
}

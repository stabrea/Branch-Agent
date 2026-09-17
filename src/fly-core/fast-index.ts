import type { DatabaseSync } from "node:sqlite";
import { actionKey, retention, type ActionKind, type ActionState, type Scored } from "./circuit.js";
import type { KenyonCode } from "./encode.js";
import { kenyonCells } from "./sizes.js";

/**
 * What a task needs at its start, kept ready in memory so ranking never reads the whole table.
 *
 * `scoreOf` in circuit.ts only ever reads, per active cell, approach minus avoid, whether either
 * side had changed there, and the action's age. This index keeps exactly that for every action as
 * one entry per changed cell (6 bytes, plus 2 to know which cells an action has), filed under the
 * cell. Ranking reads only the lists of the task's active cells. Nothing is decoded and almost
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

/** One cell's list of (action slot, approach − avoid), in growable typed arrays. */
class Postings {
  slots = new Uint32Array(8);
  diffs = new Float32Array(8);
  length = 0;
  push(slot: number, diff: number): void {
    if (this.length === this.slots.length) {
      const slots = new Uint32Array(this.length * 2), diffs = new Float32Array(this.length * 2);
      slots.set(this.slots); diffs.set(this.diffs);
      this.slots = slots; this.diffs = diffs;
    }
    this.slots[this.length] = slot;
    this.diffs[this.length] = diff;
    this.length += 1;
  }
  remove(slot: number): void {
    for (let at = 0; at < this.length; at += 1) {
      if (this.slots[at] !== slot) continue;
      this.length -= 1;
      this.slots[at] = this.slots[this.length]!;
      this.diffs[at] = this.diffs[this.length]!;
      return;
    }
  }
}
interface Slot { action: string; kind: ActionKind; uses: number; updatedAt: number; cells: Uint16Array }

/**
 * Each action has a slot; each cell lists the slots that changed there. Ranking reads only the
 * lists of the task's active cells, about a twentieth of what walking every action would read.
 */
export class RankIndex {
  private readonly slotOf = new Map<string, number>();
  private readonly slots: (Slot | undefined)[] = [];
  private readonly free: number[] = [];
  private readonly cells = Array.from({ length: kenyonCells }, () => new Postings());
  private sums = new Float64Array(0);
  private touched = new Uint16Array(0);
  constructor(readonly version: number) {}
  putRows(rows: readonly IndexRow[]): void {
    for (const row of rows) this.place(actionKey(row.kind, row.action), entryOfRow(row));
  }
  put(states: readonly ActionState[]): void {
    for (const state of states) this.place(actionKey(state.kind, state.action), entryOf(state));
  }
  private place(key: string, entry: Entry): void {
    this.drop(key);
    const slot = this.free.pop() ?? this.slots.length;
    this.slots[slot] = { action: entry.action, kind: entry.kind, uses: entry.uses, updatedAt: entry.updatedAt, cells: entry.cells };
    this.slotOf.set(key, slot);
    entry.cells.forEach((cell, at) => this.cells[cell]!.push(slot, entry.diffs[at]!));
  }
  private drop(key: string): void {
    const slot = this.slotOf.get(key);
    if (slot === undefined) return;
    for (const cell of this.slots[slot]!.cells) this.cells[cell]!.remove(slot);
    this.slots[slot] = undefined;
    this.slotOf.delete(key);
    this.free.push(slot);
  }
  keep(keys: ReadonlySet<string>): void {
    for (const key of [...this.slotOf.keys()]) if (!keys.has(key)) this.drop(key);
  }
  get size(): number { return this.slotOf.size; }
  /**
   * Every action that shares a changed cell with this situation and scores at least `least` either
   * way, best first per kind, in the order `Circuit.rank` uses.
   */
  rank(code: KenyonCode, now: number, least = 0): Record<ActionKind, Scored[]> {
    const out: Record<ActionKind, Scored[]> = { tool: [], skill: [], memory: [] };
    if (!code.length) return out;
    if (this.sums.length < this.slots.length) {
      this.sums = new Float64Array(this.slots.length * 2);
      this.touched = new Uint16Array(this.slots.length * 2);
    }
    const seenSlots: number[] = [];
    for (const cell of code) this.gatherCell(cell, seenSlots);
    for (const slot of seenSlots) {
      this.score(slot, code.length, now, least, out);
      this.sums[slot] = 0;
      this.touched[slot] = 0;
    }
    for (const list of Object.values(out)) list.sort(order);
    return out;
  }
  private gatherCell(cell: number, seenSlots: number[]): void {
    const list = this.cells[cell];
    if (!list) return;
    const { slots, diffs, length } = list;
    for (let at = 0; at < length; at += 1) {
      const slot = slots[at]!;
      if (this.touched[slot] === 0) seenSlots.push(slot);
      this.touched[slot] = this.touched[slot]! + 1;
      this.sums[slot] = this.sums[slot]! + diffs[at]!;
    }
  }
  private score(slot: number, active: number, now: number, least: number, out: Record<ActionKind, Scored[]>): void {
    const entry = this.slots[slot]!;
    const score = (this.sums[slot]! * retention(now - entry.updatedAt)) / active;
    if (Math.abs(score) < least) return;
    out[entry.kind].push({ action: entry.action, kind: entry.kind, score, evidence: this.touched[slot]! / active, uses: entry.uses });
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

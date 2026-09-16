import type { MemoryRecord } from "./memory.js";
import type { Store } from "./store.js";

/**
 * Where saved facts are kept. Today there is exactly one place — the app's own SQLite database —
 * and this describes what that place has to do, so that if a second one is ever written there is
 * something to write it against rather than a guess. It is deliberately small: six things, all of
 * which the existing store already does.
 *
 * The contract, in full:
 *
 * - `read` gives back the fact with that identifier, or nothing. It never throws for a fact that is
 *   not there; "not there" is an answer.
 * - `list` gives back every fact for that owner, newest change first. A backend may cap how many it
 *   returns, but it must say so in its own documentation rather than silently truncating a count.
 * - `write` saves a fact under an identifier the caller chose, replacing what was there. It must
 *   keep `createdAt` from the earlier version and move `revision` on by one, so an edit can be
 *   told from a new fact. Every field of the data is stored as given, including `kind`, `layer`,
 *   `project` and the timestamps that say when a fact was true.
 * - `search` matches on the fact's words at the least. A backend that can also compare by meaning
 *   may, but it must never return a fact the reader is not allowed to see.
 * - `forget` removes one fact and says whether there was one to remove.
 * - `count` says how many facts an owner has, which is what the capacity limit is checked against.
 *
 * Two rules hold for every backend. Owners never see each other's facts: every call takes an owner
 * and must scope to it. And nothing is written anywhere but this computer unless the owner has
 * asked for that plainly — a backend that talks to a service is a different feature, not a drop-in.
 */
export interface MemoryBackend {
  /** A name for the diagnostics folder and the Memory screen, such as "this computer's database". */
  readonly name: string;
  read(owner: string, id: string): MemoryRecord | undefined;
  list(owner: string): MemoryRecord[];
  write(owner: string, id: string, data: Record<string, unknown>): MemoryRecord;
  search(owner: string, query: string, agent?: string): MemoryRecord[];
  forget(owner: string, id: string): boolean;
  count(owner: string): number;
}

/**
 * The only backend that ships: the app's own database, which is the same file everything else in
 * Branch uses. It is a thin wrapper, on purpose — the point of the interface is to say what the
 * store promises, not to add a layer between callers and it.
 */
export class SqliteMemoryBackend implements MemoryBackend {
  readonly name = "this computer's database";
  constructor(private readonly store: Store) {}
  read(owner: string, id: string): MemoryRecord | undefined {
    return this.store.get("memory", owner, id) as MemoryRecord | undefined;
  }
  list(owner: string): MemoryRecord[] { return this.store.list("memory", owner) as MemoryRecord[]; }
  write(owner: string, id: string, data: Record<string, unknown>): MemoryRecord {
    return this.store.save("memory", owner, id, data) as MemoryRecord;
  }
  search(owner: string, query: string, agent?: string): MemoryRecord[] {
    return this.store.searchMemory(owner, query, agent) as MemoryRecord[];
  }
  forget(owner: string, id: string): boolean { return this.store.delete("memory", owner, id); }
  count(owner: string): number { return this.store.memoryCapacity(owner).count; }
}

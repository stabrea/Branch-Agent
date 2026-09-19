import type { DatabaseSync } from "node:sqlite";

/**
 * phase2/delight: what the owner has really done, counted from Branch's own records, for achievements.
 *
 * Read-only. Every number here comes from a row Branch wrote when the thing happened: a finished
 * task, a conversation, a tool that ran, a live voice call. Nothing is estimated, so switching
 * achievements on later still finds the past. Times are read in this computer's own time zone
 * ("localtime"), because "a task after midnight" means the owner's midnight.
 *
 * The events table is the big one (every step of every task), so it is never read whole: the counts
 * are kept with the owner's achievements (`EventScan`) and each look adds only the events written
 * since the last one, at most `eventBatch` of them, found by their ever-growing id. A busy history
 * is caught up over a few looks instead of stopping Branch for seconds (integration review: a full
 * scan of a million events took about 8 s, during which the server answered nothing).
 */
export interface AchievementTallies {
  /** Finished tasks, and the ones stopped part-way. */
  tasks: number;
  stopped: number;
  conversations: number;
  /** Finished tasks by where they came from: web (the window), schedule, channel (a chat app), trigger… */
  bySource: Record<string, number>;
  /** Every local day with at least one finished task, oldest first ("2026-09-19"). */
  days: string[];
  /** Finished tasks by local hour ("00".."23") and by weekday ("0" Sunday .. "6" Saturday). */
  hours: Record<string, number>;
  weekdays: Record<string, number>;
  /** Finished tasks begun between midnight and one on 21 December. */
  solstice: number;
  /** Tools that finished, by full name ("files.write") — the prefix is worked out by the reader. */
  tools: Record<string, number>;
  /** Every event kind the owner's tasks wrote ("voice.transcribed", "trunk.turn"…), counted. */
  events: Record<string, number>;
}
/** The events counted so far: every one with an id up to `through`. */
export interface EventScan {
  through: number;
  tools: Record<string, number>;
  events: Record<string, number>;
}
/** How many event ids one look reads at most (about a tenth of a second on a slow disk). */
export const eventBatch = 25_000;

type Row = Record<string, unknown>;
const bump = (counts: Record<string, number>, key: string, n: number): void => { counts[key] = (counts[key] ?? 0) + n; };

type TaskTallies = Omit<AchievementTallies, "tools" | "events" | "stopped" | "conversations">;
/** The last pass over each store's finished tasks, kept until one more finishes (or one is removed). */
const lastPass = new WeakMap<DatabaseSync, Map<string, { mark: string; tallies: TaskTallies }>>();

/** One pass over the owner's finished tasks, by local hour and source, added up here. Each row's time is
    turned into local time once, and the pass is reused while the finished tasks are the same ones. */
function finishedTasks(db: DatabaseSync, owner: string): TaskTallies {
  const done = "FROM tasks WHERE owner=? AND status='completed'";
  const seen = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u ${done}`).get(owner) as Row | undefined;
  const mark = `${String(seen?.n ?? 0)}|${String(seen?.u ?? "")}`, kept = lastPass.get(db)?.get(owner);
  if (kept?.mark === mark) return kept.tallies;
  const rows = db.prepare(`SELECT substr(datetime(created_at,'localtime'),1,13) AS at, source AS s, COUNT(*) AS n ${done} GROUP BY at, s ORDER BY at`).all(owner) as Row[];
  const out: TaskTallies = { tasks: 0, bySource: {}, days: [], hours: {}, weekdays: {}, solstice: 0 };
  for (const row of rows) {
    const at = String(row.at ?? ""), day = at.slice(0, 10), hour = at.slice(11, 13), n = Number(row.n ?? 0);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}$/.test(at)) continue;
    out.tasks += n;
    bump(out.bySource, String(row.s ?? ""), n);
    bump(out.hours, hour, n);
    bump(out.weekdays, String(new Date(`${day}T00:00:00Z`).getUTCDay()), n);
    if (out.days.at(-1) !== day) out.days.push(day);
    if (day.endsWith("-12-21") && hour === "00") out.solstice += n;
  }
  if (!lastPass.has(db)) lastPass.set(db, new Map());
  lastPass.get(db)?.set(owner, { mark, tallies: out });
  return out;
}
function taskTallies(db: DatabaseSync, owner: string): Omit<AchievementTallies, "tools" | "events"> {
  const count = (sql: string): number => Number((db.prepare(sql).get(owner) as Row | undefined)?.n ?? 0);
  return {
    ...finishedTasks(db, owner),
    stopped: count("SELECT COUNT(*) AS n FROM tasks WHERE owner=? AND status='cancelled'"),
    conversations: count("SELECT COUNT(*) AS n FROM sessions WHERE owner=? AND temporary=0"),
  };
}

/** Adds the owner's events written since `scan.through`, at most `eventBatch` ids. True once caught up. */
export function scanEvents(db: DatabaseSync, owner: string, scan: EventScan): boolean {
  const newest = Number((db.prepare("SELECT MAX(id) AS m FROM events").get() as Row | undefined)?.m ?? 0);
  // Fewer events than already counted means the records were replaced (a restored backup): count again.
  if (newest < scan.through) Object.assign(scan, { through: 0, tools: {}, events: {} });
  const upTo = Math.min(newest, scan.through + eventBatch);
  if (upTo <= scan.through) return true;
  const range = "FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=? AND e.id>? AND e.id<=?";
  for (const row of db.prepare(`SELECT e.kind AS k, COUNT(*) AS n ${range} GROUP BY e.kind`).all(owner, scan.through, upTo) as Row[])
    bump(scan.events, String(row.k ?? ""), Number(row.n ?? 0));
  for (const row of db.prepare(`SELECT json_extract(e.data,'$.name') AS k, COUNT(*) AS n ${range} AND e.kind='tool.completed' GROUP BY k`)
    .all(owner, scan.through, upTo) as Row[])
    bump(scan.tools, String(row.k ?? ""), Number(row.n ?? 0));
  scan.through = upTo;
  return upTo >= newest;
}

/** Everything counted, with the events brought up to date as far as one look goes. */
export function achievementTallies(db: DatabaseSync, owner: string, scan: EventScan): { tallies: AchievementTallies; caughtUp: boolean } {
  const caughtUp = scanEvents(db, owner, scan);
  return { tallies: { ...taskTallies(db, owner), tools: { ...scan.tools }, events: { ...scan.events } }, caughtUp };
}

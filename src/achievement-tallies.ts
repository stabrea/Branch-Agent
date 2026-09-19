import type { DatabaseSync } from "node:sqlite";

/**
 * phase2/delight: what the owner has really done, counted from Branch's own records, for achievements.
 *
 * Read-only. Every number here comes from a row Branch wrote when the thing happened: a finished
 * task, a conversation, a tool that ran, a live voice call. Nothing is estimated and nothing is kept
 * apart from the records themselves, so switching achievements on later still finds the past.
 * Times are read in this computer's own time zone ("localtime"), because "a task after midnight"
 * means the owner's midnight.
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

type Row = Record<string, unknown>;
const countOf = (row: Row | undefined): number => Number(row?.n ?? 0);
function grouped(rows: Row[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.k ?? "")] = Number(row.n ?? 0);
  return out;
}

export function achievementTallies(db: DatabaseSync, owner: string): AchievementTallies {
  const done = "FROM tasks WHERE owner=? AND status='completed'";
  const one = (sql: string): number => countOf(db.prepare(sql).get(owner) as Row | undefined);
  const many = (sql: string): Record<string, number> => grouped(db.prepare(sql).all(owner) as Row[]);
  return {
    tasks: one(`SELECT COUNT(*) AS n ${done}`),
    stopped: one("SELECT COUNT(*) AS n FROM tasks WHERE owner=? AND status='cancelled'"),
    conversations: one("SELECT COUNT(*) AS n FROM sessions WHERE owner=? AND temporary=0"),
    bySource: many(`SELECT source AS k, COUNT(*) AS n ${done} GROUP BY source`),
    days: (db.prepare(`SELECT DISTINCT date(created_at,'localtime') AS d ${done} ORDER BY d`).all(owner) as Row[])
      .map((row) => String(row.d)),
    hours: many(`SELECT strftime('%H',created_at,'localtime') AS k, COUNT(*) AS n ${done} GROUP BY k`),
    weekdays: many(`SELECT strftime('%w',created_at,'localtime') AS k, COUNT(*) AS n ${done} GROUP BY k`),
    solstice: one(`SELECT COUNT(*) AS n ${done} AND strftime('%m-%d %H',created_at,'localtime')='12-21 00'`),
    tools: many(`SELECT json_extract(e.data,'$.name') AS k, COUNT(*) AS n FROM events e JOIN tasks t ON t.id=e.run_id
      WHERE t.owner=? AND e.kind='tool.completed' GROUP BY k`),
    events: many("SELECT e.kind AS k, COUNT(*) AS n FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=? GROUP BY e.kind"),
  };
}

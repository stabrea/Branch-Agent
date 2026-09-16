import type { DatabaseSync } from "node:sqlite";

/**
 * One line per conversation saying what is going on in it: the last thing the person asked for,
 * the last file that was touched and the last step taken. The runtime keeps it up to date as a
 * task runs so the context pane can answer "what are we doing here?" without reading the
 * transcript.
 */
export interface WorkingLine {
  sessionId: string;
  goal: string;
  file: string;
  tool: string;
  updatedAt: string;
}
export type WorkingNote = Partial<Pick<WorkingLine, "goal" | "file" | "tool">>;
const trim = (value: string, max = 200): string => value.replace(/\s+/g, " ").trim().slice(0, max);

export class WorkingSessions {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_work(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '', file TEXT NOT NULL DEFAULT '', tool TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL)`);
  }
  /** Records whatever part of the line has just changed; the rest stays as it was. */
  note(owner: string, sessionId: string, patch: WorkingNote): WorkingLine {
    const previous = this.line(sessionId);
    const line: WorkingLine = {
      sessionId,
      goal: trim(patch.goal ?? previous?.goal ?? ""),
      file: trim(patch.file ?? previous?.file ?? ""),
      tool: trim(patch.tool ?? previous?.tool ?? ""),
      updatedAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO session_work VALUES(?,?,?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET goal=excluded.goal, file=excluded.file, tool=excluded.tool, updated_at=excluded.updated_at`)
      .run(sessionId, owner, line.goal, line.file, line.tool, line.updatedAt);
    return line;
  }
  line(sessionId: string): WorkingLine | null {
    const row = this.db.prepare("SELECT * FROM session_work WHERE session_id=?").get(sessionId);
    return row ? { sessionId, goal: String(row.goal), file: String(row.file), tool: String(row.tool), updatedAt: String(row.updated_at) } : null;
  }
  /** The same line in plain language, for the context pane. */
  describe(sessionId: string): string {
    const line = this.line(sessionId);
    if (!line) return "";
    return describeWorkingLine(line);
  }
}
export function describeWorkingLine(line: WorkingLine): string {
  const parts = [line.goal && `Working on: ${line.goal}`, line.file && `last file ${line.file}`, line.tool && `last step ${line.tool}`];
  return parts.filter(Boolean).join(" · ").slice(0, 400);
}

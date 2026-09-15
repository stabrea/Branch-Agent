import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Event, Message, Run, RunStatus } from "./contracts.js";
import { reconcileTranscript } from "./transcript.js";
import { SessionHistory } from "./history.js";

type Row = Record<string, unknown>;
export type RecordTable = "memory" | "specialists" | "procedures" | "schedules" | "settings";
export interface SavedRecord {
  id: string;
  owner: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export class Store {
  private readonly db: DatabaseSync;
  private readonly history: SessionHistory;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
    } catch (e) {
      this.db.close();
      if (e instanceof Error && e.message.includes("locked"))
        throw new Error(
          "Branch Agent is already running against this data directory",
        );
      throw e;
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY REFERENCES tasks(id), estimated_input INTEGER NOT NULL DEFAULT 0, estimated_output INTEGER NOT NULL DEFAULT 0, reported_input INTEGER NOT NULL DEFAULT 0, reported_output INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0);`);
    for (const table of ["memory", "specialists", "procedures", "schedules", "settings"])
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(id,owner));`,
      );
    this.migrateUsage();
    this.history = new SessionHistory(this.db);
    this.recoverInterruptedRuns();
    this.interruptSchedules();
  }
  private migrateUsage(): void {
    const usageColumns = this.db
      .prepare("PRAGMA table_info(usage)")
      .all()
      .map((row) => row.name);
    for (const column of ["attempts", "unreported_calls", "incomplete_calls"])
      if (!usageColumns.includes(column))
        this.db.exec(
          `ALTER TABLE usage ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
        );
  }
  searchHistory(owner: string, input: Parameters<SessionHistory["search"]>[1], excludeSessionId?: string) {
    return this.history.search(owner, input, excludeSessionId);
  }
  readHistory(owner: string, input: Parameters<SessionHistory["read"]>[1], excludeSessionId?: string) {
    return this.history.read(owner, input, excludeSessionId);
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  createRun(owner: string, prompt: string, sessionId?: string): Run {
    const now = new Date().toISOString();
    if (
      sessionId &&
      !this.db
        .prepare("SELECT id FROM sessions WHERE id=? AND owner=?")
        .get(sessionId, owner)
    )
      throw new Error("Session not found");
    if (sessionId)
      this.reconcileMessages(sessionId, "previous run interruption");
    const session = sessionId ?? randomUUID();
    this.db
      .prepare("INSERT OR IGNORE INTO sessions VALUES(?,?,?)")
      .run(session, owner, now);
    const run: Run = {
      id: randomUUID(),
      sessionId: session,
      owner,
      prompt,
      status: "running",
      output: "",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)")
      .run(run.id, session, owner, prompt, run.status, "", now, now);
    this.db.prepare("INSERT INTO usage(run_id) VALUES(?)").run(run.id);
    return run;
  }
  run(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? this.toRun(row) : undefined;
  }
  runs(owner: string): Run[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE owner=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(owner)
      .map((row) => this.toRun(row));
  }
  finish(id: string, status: RunStatus, output: string): Run {
    const run = this.run(id);
    if (!run) throw new Error("Run not found");
    const added = this.reconcileMessages(run.sessionId, status);
    if (added) this.event(id, "session.reconciled", { added, reason: status });
    this.db
      .prepare("UPDATE tasks SET status=?,output=?,updated_at=? WHERE id=?")
      .run(status, output, new Date().toISOString(), id);
    return this.run(id)!;
  }
  message(sessionId: string, message: Message, sourceId?: number): void {
    this.db
      .prepare("INSERT INTO messages(session_id,body,source_id) VALUES(?,?,?)")
      .run(sessionId, JSON.stringify(message), sourceId ?? null);
  }
  messages(sessionId: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id")
      .all(sessionId)
      .map((row) => JSON.parse(String(row.body)) as Message);
  }
  reconcileMessages(sessionId: string, reason: string): number {
    const rows = this.db.prepare("SELECT body,source_id FROM messages WHERE session_id=? ORDER BY id").all(sessionId);
    const sources = new Map(rows.map((row) => [JSON.parse(String(row.body)) as Message, Number(row.source_id)]));
    const repaired = reconcileTranscript([...sources.keys()], reason);
    if (!repaired.added) return 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId);
      for (const message of repaired.messages) this.message(sessionId, message, sources.get(message));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return repaired.added;
  }
  event(runId: string, kind: string, data: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)",
      )
      .run(runId, kind, JSON.stringify(data), new Date().toISOString());
  }
  events(runId: string): Event[] {
    return this.db
      .prepare("SELECT * FROM events WHERE run_id=? ORDER BY id LIMIT 2000")
      .all(runId)
      .map((row) => ({
        id: Number(row.id),
        runId: String(row.run_id),
        kind: String(row.kind),
        data: JSON.parse(String(row.data)),
        createdAt: String(row.created_at),
      }));
  }
  beginUsage(runId: string, estimatedInput: number): void {
    this.db
      .prepare(
        "UPDATE usage SET estimated_input=estimated_input+?,attempts=attempts+1,unreported_calls=unreported_calls+1,incomplete_calls=incomplete_calls+1 WHERE run_id=?",
      )
      .run(estimatedInput, runId);
  }
  addUsage(
    runId: string,
    estimatedInput: number,
    estimatedOutput: number,
    reported?: { input: number; output: number },
    completed = true,
  ): void {
    this.db
      .prepare(
        "UPDATE usage SET estimated_input=estimated_input+?,estimated_output=estimated_output+?,reported_input=reported_input+?,reported_output=reported_output+?,reports=reports+?,unreported_calls=MAX(0,unreported_calls-?),incomplete_calls=MAX(0,incomplete_calls-?) WHERE run_id=?",
      )
      .run(
        estimatedInput,
        estimatedOutput,
        reported?.input ?? 0,
        reported?.output ?? 0,
        reported ? 1 : 0,
        reported ? 1 : 0,
        completed ? 1 : 0,
        runId,
      );
  }
  usage(runId: string): Record<string, number> {
    const r = this.db.prepare("SELECT * FROM usage WHERE run_id=?").get(runId);
    return {
      estimatedInput: Number(r?.estimated_input ?? 0),
      estimatedOutput: Number(r?.estimated_output ?? 0),
      reportedInput: Number(r?.reported_input ?? 0),
      reportedOutput: Number(r?.reported_output ?? 0),
      reports: Number(r?.reports ?? 0),
      attempts: Number(r?.attempts ?? 0),
      unreportedCalls: Number(r?.unreported_calls ?? 0),
      incompleteCalls: Number(r?.incomplete_calls ?? 0),
    };
  }
  save(
    table: RecordTable,
    owner: string,
    id: string,
    data: Record<string, unknown>,
  ): SavedRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(id, owner, JSON.stringify(data), now, now);
    return this.get(table, owner, id)!;
  }
  get(table: RecordTable, owner: string, id: string): SavedRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`)
      .get(owner, id);
    return row ? this.toRecord(row) : undefined;
  }
  list(table: RecordTable, owner: string): SavedRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM ${table} WHERE owner=? ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(owner)
      .map((row) => this.toRecord(row));
  }
  delete(table: RecordTable, owner: string, id: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`)
        .run(owner, id).changes > 0
    );
  }
  claimSchedule(
    owner: string,
    id: string,
    now: string,
  ): SavedRecord | undefined {
    const result = this.db
      .prepare(
        "UPDATE schedules SET data=json_set(data,'$.status','running'),updated_at=? WHERE owner=? AND id=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.dueAt')<=? RETURNING *",
      )
      .get(now, owner, id, now);
    return result ? this.toRecord(result) : undefined;
  }
  dueSchedules(owner: string, now: string): SavedRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM schedules WHERE owner=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.dueAt')<=? ORDER BY json_extract(data,'$.dueAt') LIMIT 100",
      )
      .all(owner, now)
      .map((row) => this.toRecord(row));
  }
  private interruptSchedules(): void {
    this.db.exec(
      "UPDATE schedules SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'",
    );
  }
  private recoverInterruptedRuns(): void {
    for (const row of this.db
      .prepare("SELECT id FROM tasks WHERE status='running'")
      .all())
      this.finish(
        String(row.id),
        "interrupted",
        "Process stopped before completion; side effects were not replayed",
      );
    for (const row of this.db.prepare("SELECT id FROM sessions").all())
      this.reconcileMessages(String(row.id), "startup recovery");
  }
  private toRun(r: Row): Run {
    return {
      id: String(r.id),
      sessionId: String(r.session_id),
      owner: String(r.owner),
      prompt: String(r.prompt),
      status: r.status as RunStatus,
      output: String(r.output),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  private toRecord(r: Row): SavedRecord {
    return {
      id: String(r.id),
      owner: String(r.owner),
      data: JSON.parse(String(r.data)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}

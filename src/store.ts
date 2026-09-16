import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Event, Message, Run, RunStatus } from "./contracts.js";
import { reconcileTranscript } from "./transcript.js";
import { SessionHistory } from "./history.js";
import { SessionBranches } from "./sessions.js";
import { SessionLibrary } from "./session-library.js";
import { SessionSummaries, type SessionSummary } from "./session-summary.js";
import { WorkingSessions, type WorkingNote } from "./working-session.js";
import { MemoryFacts } from "./memory.js";
import { InstalledSkills } from "./skills.js";
import { Projects } from "./projects.js";
import { Locker, type LockerKeySource } from "./locker.js";
import { Secrets } from "./vault.js";
import { Receipts } from "./receipts.js";
import { AuditLog } from "./audit.js";
import { MemoryReview } from "./memory-review.js";
import { SkillGovernance } from "./skill-governance.js";
import { exportBackup, importBackup, type RestoreOptions } from "./backup.js";
import { WorkspaceHistory } from "./workspace-history.js";
import type { WorkspaceFiles } from "./files.js";
import { UsageStore } from "./usage.js";
// Wave 6 (collaboration and workflows): labels and project notes, share links, household profiles.
import { Labels } from "./labels.js";
import { ShareLinks } from "./conversation-share.js";
import { Profiles } from "./profiles.js";
// Wave 7 (tool loading): what this computer has learned about which tools a request needs.
import { ToolUsage } from "./tool-usage.js";

type Row = Record<string, unknown>;
export type RecordTable = "memory" | "specialists" | "procedures" | "schedules" | "settings" | "deliveries" | "governance" | "triggers" | "webhooks" | "workflows";
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
  private readonly branches: SessionBranches;
  private readonly library: SessionLibrary;
  readonly summaries: SessionSummaries;
  readonly working: WorkingSessions;
  private readonly memories: MemoryFacts;
  readonly review: MemoryReview;
  private governanceStore: SkillGovernance | undefined;
  private historyStore: WorkspaceHistory | undefined;
  readonly skills: InstalledSkills;
  readonly projects: Projects;
  /** Wave 6: labels and project notes, read-only share links, and the household's profiles. */
  readonly labels: Labels;
  readonly shares: ShareLinks;
  readonly profiles: Profiles;
  /** Wave 7: which tools past tasks needed, and what has been learned about them. */
  readonly toolUsage: ToolUsage;
  private lockerStore: Locker | undefined;
  private secretsStore: Secrets | undefined;
  private receiptsStore: Receipts | undefined;
  /**
   * Set once the locker is open: every event is passed through it on the way to the log, so a
   * secret value can never be written down even if a tool put one in its result by mistake.
   */
  guardEvent: (data: Record<string, unknown>) => Record<string, unknown> = (data) => data;
  private auditStore: AuditLog | undefined;
  private closed = false;
  get sqlite() { return this.db; }
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
      CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY REFERENCES tasks(id), estimated_input INTEGER NOT NULL DEFAULT 0, estimated_output INTEGER NOT NULL DEFAULT 0, reported_input INTEGER NOT NULL DEFAULT 0, reported_output INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS compactions(session_id TEXT PRIMARY KEY REFERENCES sessions(id), through_id INTEGER NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_log(id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, owner TEXT NOT NULL, run_id TEXT, payload_summary TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery_log(id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id TEXT NOT NULL, owner TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, next_retry_at TEXT, created_at TEXT NOT NULL);`);
    for (const table of ["memory", "specialists", "procedures", "schedules", "settings", "deliveries", "governance", "triggers", "webhooks", "workflows"])
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table}(id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(id,owner));`,
      );
    if (!this.db.prepare("PRAGMA table_info(sessions)").all().some((row) => row.name === "temporary"))
      this.db.exec("ALTER TABLE sessions ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0");
    if (!this.db.prepare("PRAGMA table_info(tasks)").all().some((row) => row.name === "source"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");
    this.labels = new Labels(this.db);
    this.toolUsage = new ToolUsage(this.db);
    this.shares = new ShareLinks(this.db);
    this.profiles = new Profiles(this.db, "local");
    this.memories = new MemoryFacts(this.db);
    this.review = new MemoryReview(this.db, this.memories);
    this.skills = new InstalledSkills(this.db);
    this.projects = new Projects(this);
    this.migrateUsage();
    this.history = new SessionHistory(this.db);
    this.branches = new SessionBranches(this.db);
    this.library = new SessionLibrary(this.db);
    this.summaries = new SessionSummaries(this.db);
    this.working = new WorkingSessions(this.db);
    this.recoverInterruptedRuns();
    this.interruptSchedules();
    this.interruptWorkflows();
    this.discardTemporarySessions();
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
  branchSession(owner: string, input: Parameters<SessionBranches["branch"]>[1]) {
    return this.branches.branch(owner, input);
  }
  sessionView(owner: string, sessionId: string) {
    return { ...this.branches.view(owner, sessionId), imported: this.library.imported(sessionId), temporary: this.sessionTemporary(sessionId) };
  }
  searchSessions(owner: string, input: unknown) {
    return this.library.search(owner, input);
  }
  exportSession(owner: string, sessionId: string) {
    return this.library.export(owner, sessionId);
  }
  importSession(owner: string, input: unknown) {
    return this.library.import(owner, input);
  }
  duplicateSession(owner: string, sessionId: string) {
    return this.library.duplicate(owner, sessionId);
  }
  createRun(owner: string, prompt: string, sessionId?: string, temporary = false, source = "web"): Run {
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
      .prepare("INSERT OR IGNORE INTO sessions(id,owner,created_at,temporary) VALUES(?,?,?,?)")
      .run(session, owner, now, Number(temporary));
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
      .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)")
      .run(run.id, session, owner, prompt, run.status, "", now, now, source);
    this.db.prepare("INSERT INTO usage(run_id) VALUES(?)").run(run.id);
    return run;
  }
  run(id: string): Run | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return row ? this.toRun(row) : undefined;
  }
  /** Opens the secrets locker with a key source; values stay encrypted in the database. */
  openLocker(keys: LockerKeySource): Locker {
    this.receiptsStore ??= new Receipts(keys);
    this.lockerStore ??= new Locker(this.db, keys);
    this.secretsStore ??= new Secrets(this.db, this.lockerStore);
    return this.lockerStore;
  }
  /** References, replacement dates, the use audit and the shared scrubber, in front of the locker. */
  get secrets(): Secrets {
    if (!this.secretsStore) throw new Error("The secrets locker is not open in this launch");
    return this.secretsStore;
  }
  /** Every table of the person's state, for a backup file; secrets are left out (device-bound key). */
  backup(appVersion: string) { return exportBackup(this.db, appVersion); }
  /** Restores a backup into a fresh install; refuses when this copy already has state. */
  restore(input: unknown, options: RestoreOptions = {}) { return importBackup(this.db, input, options); }
  /** Skill failure patterns, exclusions, demotion, benchmarks and drafts for this owner. */
  get governance(): SkillGovernance {
    return (this.governanceStore ??= new SkillGovernance(this, "local"));
  }
  governanceFor(owner: string): SkillGovernance { return owner === "local" ? this.governance : new SkillGovernance(this, owner); }
  /** Completed top-level runs created after a moment, oldest first, for consolidation. */
  runsSince(owner: string, after: string, limit = 20): Run[] {
    return this.db.prepare("SELECT * FROM tasks WHERE owner=? AND status='completed' AND created_at>? ORDER BY created_at ASC LIMIT ?").all(owner, after, limit).map((row) => this.toRun(row));
  }
  /** Workspace file history and snapshots for the given workspace. */
  openWorkspaceHistory(files: WorkspaceFiles, owner: string): WorkspaceHistory {
    return (this.historyStore ??= new WorkspaceHistory(this.db, files, owner));
  }
  get workspaceHistory(): WorkspaceHistory {
    if (!this.historyStore) throw new Error("Workspace history is not open in this launch");
    return this.historyStore;
  }
  /** Signs and verifies tool-success receipts with a key derived from the locker key. */
  get receipts(): Receipts {
    if (!this.receiptsStore) throw new Error("Receipts need the secrets locker to be open");
    return this.receiptsStore;
  }
  get locker(): Locker {
    if (!this.lockerStore) throw new Error("The secrets locker is not open in this launch");
    return this.lockerStore;
  }
  /** The append-only record of what the assistant was allowed to do. */
  get audit(): AuditLog {
    return (this.auditStore ??= new AuditLog(this.db));
  }
  sessionTemporary(sessionId: string): boolean {
    return Number(this.db.prepare("SELECT temporary FROM sessions WHERE id=?").get(sessionId)?.temporary ?? 0) === 1;
  }
  /** Removes a temporary conversation and everything recorded for it; nothing of it remains searchable. */
  discardSession(owner: string, sessionId: string): { discarded: boolean; messages: number } {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    if (!this.sessionTemporary(sessionId)) throw new Error("Only temporary conversations can be discarded");
    if (this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status='running'").get(sessionId))
      throw new Error("Wait for the active task before discarding this conversation");
    return this.purgeSession(sessionId);
  }
  private purgeSession(sessionId: string): { discarded: boolean; messages: number } {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM events WHERE run_id IN (SELECT id FROM tasks WHERE session_id=?)").run(sessionId);
      this.db.prepare("DELETE FROM usage WHERE run_id IN (SELECT id FROM tasks WHERE session_id=?)").run(sessionId);
      this.db.prepare("DELETE FROM tasks WHERE session_id=?").run(sessionId);
      const messages = this.db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId).changes;
      this.db.prepare("DELETE FROM compactions WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_pins WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_summaries WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM session_work WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
      this.db.exec("COMMIT");
      return { discarded: true, messages: Number(messages) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private discardTemporarySessions(): void {
    for (const row of this.db.prepare("SELECT id FROM sessions WHERE temporary=1").all())
      this.purgeSession(String(row.id));
  }
  /** An empty conversation with no task in it, for history the app writes itself. */
  createSession(owner: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO sessions(id,owner,created_at,temporary) VALUES(?,?,?,0)").run(id, owner, new Date().toISOString());
    return id;
  }
  /**
   * Wave 6: files a conversation and its tasks under another person in this household, so a task
   * started while somebody's profile is switched on lands in their list and not the owner's.
   */
  reassignSession(sessionId: string, toOwner: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE sessions SET owner=? WHERE id=?").run(toOwner, sessionId);
      this.db.prepare("UPDATE tasks SET owner=? WHERE session_id=?").run(toOwner, sessionId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  ownsSession(owner: string, sessionId: string): boolean {
    return !!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner);
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
  /**
   * Messages the model should see: a summary of compacted history, then everything after it, plus
   * any earlier message the owner pinned so it is never folded away.
   */
  workingMessages(sessionId: string): { summary: string | null; rows: { id: number; message: Message }[] } {
    const compaction = this.db.prepare("SELECT through_id, summary FROM compactions WHERE session_id=?").get(sessionId);
    const after = compaction ? Number(compaction.through_id) : 0;
    const pinned = [...this.summaries.pinnedMessageIds(sessionId)];
    const keep = pinned.length ? ` OR id IN (${pinned.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT id, body FROM messages WHERE session_id=? AND (id>?${keep}) ORDER BY id`)
      .all(sessionId, after, ...pinned)
      .map((row) => ({ id: Number(row.id), message: JSON.parse(String(row.body)) as Message }));
    return { summary: compaction ? String(compaction.summary) : null, rows };
  }
  /** Message rows the owner pinned in this conversation, by their current row identifier. */
  pinnedMessageIds(sessionId: string): Set<number> { return this.summaries.pinnedMessageIds(sessionId); }
  sessionSummary(owner: string, sessionId: string) {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    const saved = this.summaries.get(sessionId);
    return { sessionId, summary: saved?.summary ?? null, text: saved?.text ?? "", createdAt: saved?.createdAt ?? null,
      pins: this.summaries.pins(sessionId), working: this.working.line(sessionId) };
  }
  saveSessionSummary(owner: string, sessionId: string, summary: SessionSummary | null, text: string) {
    return this.summaries.save(owner, sessionId, summary, text);
  }
  pinMessage(owner: string, sessionId: string, messageId: number, pinned: boolean) {
    if (!this.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
    return this.summaries.setPinned(sessionId, messageId, pinned);
  }
  noteWorking(owner: string, sessionId: string, patch: WorkingNote) { return this.working.note(owner, sessionId, patch); }
  saveCompaction(sessionId: string, throughId: number, summary: string): void {
    this.db.prepare(`INSERT INTO compactions VALUES(?,?,?,?) ON CONFLICT(session_id)
      DO UPDATE SET through_id=excluded.through_id, summary=excluded.summary, created_at=excluded.created_at`)
      .run(sessionId, throughId, summary, new Date().toISOString());
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
  private readonly eventListeners = new Set<(runId: string, kind: string, data: Record<string, unknown>) => void>();
  /** Called after every stored event; listeners must not throw and are never awaited. */
  onEvent(listener: (runId: string, kind: string, data: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }
  event(runId: string, kind: string, input: Record<string, unknown>): void {
    const data = this.guardEvent(input);
    this.db
      .prepare(
        "INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)",
      )
      .run(runId, kind, JSON.stringify(data), new Date().toISOString());
    for (const listener of this.eventListeners) { try { listener(runId, kind, data); } catch { /* a listener must never break the caller */ } }
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
  /** The newest events across all of one owner's tasks, for the diagnostics bundle. */
  recentEvents(owner: string, limit = 200): Event[] {
    return this.db
      .prepare(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=? ORDER BY e.id DESC LIMIT ?",
      )
      .all(owner, Math.max(1, Math.min(2000, limit)))
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
    if (table === "memory") return this.memories.save(owner, id, data);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ${table} VALUES(?,?,?,?,?) ON CONFLICT(id,owner) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      )
      .run(id, owner, JSON.stringify(data), now, now);
    return this.get(table, owner, id)!;
  }
  get(table: RecordTable, owner: string, id: string): SavedRecord | undefined {
    if (table === "memory") return this.memories.get(owner, id);
    const row = this.db
      .prepare(`SELECT * FROM ${table} WHERE owner=? AND id=?`)
      .get(owner, id);
    return row ? this.toRecord(row) : undefined;
  }
  list(table: RecordTable, owner: string): SavedRecord[] {
    if (table === "memory") return this.memories.list(owner);
    return this.db
      .prepare(
        `SELECT * FROM ${table} WHERE owner=? ORDER BY updated_at DESC LIMIT 500`,
      )
      .all(owner)
      .map((row) => this.toRecord(row));
  }
  delete(table: RecordTable, owner: string, id: string): boolean {
    if (table === "memory") return this.memories.delete(owner, id);
    return (
      this.db
        .prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`)
        .run(owner, id).changes > 0
    );
  }
  usageStore(): UsageStore { return new UsageStore(this.db); }
  memoryCapacity(owner: string) { return this.memories.capacity(owner); }
  configureMemory(owner: string, input: unknown) { return this.memories.configure(owner, input); }
  updateMemory(owner: string, input: unknown, sourceRunId: string) {
    return this.memories.update(owner, input, sourceRunId);
  }
  searchMemory(owner: string, query: string, agent?: string) { return this.memories.search(owner, query, agent); }
  memoryAt(owner: string, input: unknown, agent?: string) { return this.memories.at(owner, input, agent); }
  memoryTimeline(owner: string, entity: string, agent?: string) { return this.memories.timeline(owner, entity, agent); }
  setMemorySuppressed(owner: string, sessionId: string, suppressed: boolean) { return this.memories.setSuppressed(owner, sessionId, suppressed); }
  exportMemory(owner: string) { return this.memories.export(owner); }
  importMemory(owner: string, input: unknown) { return this.memories.import(owner, input); }
  forgetMemoryPreview(owner: string, sessionId: string) { return this.memories.forgetPreview(owner, sessionId); }
  forgetMemory(owner: string, input: unknown) { return this.memories.forget(owner, input); }
  memorySuppressed(owner: string, sessionId: string) { return this.memories.suppressed(owner, sessionId); }
  memoryHygiene(owner: string, input: unknown, now?: number) { return this.memories.hygiene(owner, input, now); }
  archivedMemory(owner: string) { return this.memories.archived(owner); }
  restoreMemory(owner: string, id: string) { return this.memories.restore(owner, id); }
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
  logTriggerFire(triggerId: string, owner: string, runId: string | null, payloadSummary: string, status: string): void {
    this.db
      .prepare(
        "INSERT INTO trigger_log(trigger_id, owner, run_id, payload_summary, status, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      )
      .run(triggerId, owner, runId, payloadSummary, status, new Date().toISOString());
  }
  getTriggerLog(
    triggerId: string,
    owner: string,
    limit = 50,
  ): Array<{ id: number; runId: string | null; payloadSummary: string; status: string; createdAt: string }> {
    return this.db
      .prepare(
        "SELECT id, run_id as runId, payload_summary as payloadSummary, status, created_at as createdAt FROM trigger_log WHERE trigger_id = ? AND owner = ? ORDER BY id DESC LIMIT ?",
      )
      .all(triggerId, owner, limit) as Array<{ id: number; runId: string | null; payloadSummary: string; status: string; createdAt: string }>;
  }
  logWebhookDelivery(
    webhookId: string,
    owner: string,
    eventType: string,
    status: string,
    attempt: number,
    nextRetryAt: string | null,
  ): void {
    this.db
      .prepare(
        "INSERT INTO delivery_log(webhook_id, owner, event_type, status, attempt, next_retry_at, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
      )
      .run(webhookId, owner, eventType, status, attempt, nextRetryAt, new Date().toISOString());
  }
  getWebhookLog(
    webhookId: string,
    owner: string,
    limit = 50,
  ): Array<{ id: number; eventType: string; status: string; attempt: number; nextRetryAt: string | null; createdAt: string }> {
    return this.db
      .prepare(
        "SELECT id, event_type as eventType, status, attempt, next_retry_at as nextRetryAt, created_at as createdAt FROM delivery_log WHERE webhook_id = ? AND owner = ? ORDER BY id DESC LIMIT ?",
      )
      .all(webhookId, owner, limit) as Array<{ id: number; eventType: string; status: string; attempt: number; nextRetryAt: string | null; createdAt: string }>;
  }
  /** A workflow left working when the app closed is marked so the owner can carry it on. */
  private interruptWorkflows(): void {
    this.db.exec("UPDATE workflows SET data=json_set(data,'$.status','interrupted') WHERE json_extract(data,'$.status')='running'");
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_state'").get())
      this.db.exec("UPDATE workflow_state SET status='interrupted' WHERE status='running'");
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

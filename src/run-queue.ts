import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ExecutionLimit } from "./execution-limit.js";
import { errorText } from "./contracts.js";
import { placeTask, type Placement } from "./dispatch-fallback.js";
import { startedWithShortLivedKey, underShortLivedKey } from "./key-context.js"; // bucket-18 (A0300)

/**
 * A waiting line for tasks. When as many tasks are already working as this computer is set to
 * handle, a new one joins the line instead of being turned away, and the person is told where in
 * the line it is. What the owner asks for goes in front of anything a schedule or another app
 * started. A conversation only ever has one task working, so its other messages wait their turn.
 */
export const queueSources = ["owner", "schedule", "trigger", "mcp"] as const;
export type QueueSource = (typeof queueSources)[number];
/** Lower runs sooner. The owner's own requests are served before anything automatic. */
export const sourcePriority: Record<QueueSource, number> = { owner: 0, schedule: 5, trigger: 5, mcp: 7 };
export const QueueEntrySchema = z.object({
  prompt: z.string().trim().min(1).max(16000),
  sessionId: z.string().uuid().optional(),
  source: z.enum(queueSources).default("owner"),
}).strict();
export const QueueSettingsSchema = z.object({
  /** How many tasks may work at the same time before the rest wait. */
  atOnce: z.number().int().min(1).max(8).default(3),
}).strict();
export interface QueueEntry {
  id: string; prompt: string; sessionId: string | null; source: QueueSource; priority: number;
  status: "waiting" | "running" | "done" | "failed" | "cancelled";
  position: number | null; runId: string | null; error: string | null; createdAt: string;
}

export class RunQueue {
  constructor(
    private readonly store: Store,
    private readonly runtime: Runtime,
    /** The whole app's count of what is working at once; the line never starts past it. */
    private readonly executions?: ExecutionLimit,
  ) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS run_queue(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
      prompt TEXT NOT NULL, session_id TEXT, source TEXT NOT NULL, priority INTEGER NOT NULL,
      status TEXT NOT NULL, run_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // bucket-18 (A0300): a task queued with a short-lived key still counts as one when it starts later.
    try { store.sqlite.exec("ALTER TABLE run_queue ADD COLUMN short_lived INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
    // A task left working when the app closed is not replayed; it is marked so the line can move on.
    store.sqlite.exec("UPDATE run_queue SET status='failed', error='The app closed before this task finished' WHERE status='running'");
  }
  settings(owner: string): z.infer<typeof QueueSettingsSchema> {
    return QueueSettingsSchema.parse(this.store.get("settings", owner, "run_queue")?.data ?? {});
  }
  configure(owner: string, input: unknown): z.infer<typeof QueueSettingsSchema> {
    const value = QueueSettingsSchema.parse(input);
    this.store.save("settings", owner, "run_queue", value);
    this.drain(owner);
    return value;
  }
  /**
   * Where a task ended up and why: started, or waiting with the reason and the next best thing the
   * owner can do about it. A task that cannot be placed is never left to hang in silence.
   */
  placement(owner: string, id: string): Placement {
    const entry = this.entry(owner, id);
    if (!entry) throw new Error("No queued task with that number");
    if (entry.status !== "waiting")
      return placeTask({ atOnce: this.settings(owner).atOnce, running: this.running(owner).length });
    const running = this.running(owner);
    const sessionBusy = !!entry.sessionId && running.some((item) => item.sessionId === entry.sessionId);
    const position = entry.position;
    // The whole app being as busy as it may get is the honest reason when it is the real one: a
    // task started from the app's own screen takes up one of the same places this line draws from.
    if (this.executions && this.executions.room === 0 && !sessionBusy)
      return placeTask({ atOnce: this.executions.limit, running: this.executions.limit, position });
    return placeTask({ atOnce: this.settings(owner).atOnce, running: running.length, position, sessionBusy });
  }
  /** Joins the line. It starts straight away when there is room, and says where it is if not. */
  submit(owner: string, input: unknown): QueueEntry & { placement: Placement } {
    const value = QueueEntrySchema.parse(input);
    if (value.sessionId && !this.store.ownsSession(owner, value.sessionId)) throw new Error("Conversation not found");
    if (this.waiting(owner).length >= 200) throw new Error("The waiting line is full");
    const id = randomUUID(), now = new Date().toISOString();
    this.store.sqlite.prepare(`INSERT INTO run_queue(id,owner,prompt,session_id,source,priority,status,run_id,error,created_at,updated_at,short_lived)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, owner, value.prompt, value.sessionId ?? null, value.source, sourcePriority[value.source], "waiting", null, null, now, now,
        startedWithShortLivedKey() ? 1 : 0);
    this.drain(owner);
    return { ...this.entry(owner, id)!, placement: this.placement(owner, id) };
  }
  /** Takes the queued task out of the line. A task already working is cancelled instead. */
  cancel(owner: string, id: string): { cancelled: boolean; wasRunning: boolean } {
    const entry = this.entry(owner, id);
    if (!entry) throw new Error("No queued task with that number");
    if (entry.status === "running") {
      const cancelled = entry.runId ? this.runtime.cancel(entry.runId) : false;
      this.mark(owner, id, "cancelled", { error: "Cancelled by the owner" });
      this.drain(owner);
      return { cancelled, wasRunning: true };
    }
    if (entry.status !== "waiting") throw new Error("That task is no longer waiting");
    this.mark(owner, id, "cancelled", { error: "Cancelled by the owner" });
    return { cancelled: true, wasRunning: false };
  }
  /** Everything still in the line or working, in the order it will be served. */
  list(owner: string): QueueEntry[] {
    const rows = this.store.sqlite.prepare(`SELECT * FROM run_queue WHERE owner=? AND status IN ('waiting','running')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority, created_at, id`).all(owner);
    return rows.map((row, index) => ({ ...this.toEntry(row), position: index + 1 }));
  }
  /** The last few that finished, newest first, so the owner can see what happened. */
  recent(owner: string, limit = 20): QueueEntry[] {
    return this.store.sqlite.prepare(`SELECT * FROM run_queue WHERE owner=? AND status NOT IN ('waiting','running')
      ORDER BY updated_at DESC LIMIT ?`).all(owner, Math.max(1, Math.min(100, limit))).map((row) => this.toEntry(row));
  }
  entry(owner: string, id: string): QueueEntry | undefined {
    const row = this.store.sqlite.prepare("SELECT * FROM run_queue WHERE owner=? AND id=?").get(owner, id);
    if (!row) return undefined;
    const place = this.list(owner).find((item) => item.id === id);
    return { ...this.toEntry(row), position: place?.position ?? null };
  }
  private waiting(owner: string): QueueEntry[] {
    return this.store.sqlite.prepare("SELECT * FROM run_queue WHERE owner=? AND status='waiting' ORDER BY priority, created_at, id")
      .all(owner).map((row) => this.toEntry(row));
  }
  private running(owner: string): QueueEntry[] {
    return this.store.sqlite.prepare("SELECT * FROM run_queue WHERE owner=? AND status='running'")
      .all(owner).map((row) => this.toEntry(row));
  }
  /**
   * Starts as many waiting tasks as there is room for, in order, one per conversation. Room means
   * both this line's own setting and the whole app's count of what is working: a task started from
   * the app's own screen takes up one of the same places.
   */
  drain(owner: string): number {
    const atOnce = this.settings(owner).atOnce;
    let running = this.running(owner);
    let started = 0;
    for (const next of this.waiting(owner)) {
      if (running.length >= atOnce) break;
      if (next.sessionId && running.some((item) => item.sessionId === next.sessionId)) continue;
      const place = this.executions ? this.executions.take() : () => undefined;
      // The whole app is as busy as it may get: the rest of the line waits, and is looked at again
      // as soon as something finishes.
      if (!place) break;
      this.mark(owner, next.id, "running", {});
      this.start(owner, next, place);
      running = this.running(owner);
      started++;
    }
    return started;
  }
  private start(owner: string, entry: QueueEntry, place: () => void): void {
    const row = this.store.sqlite.prepare("SELECT short_lived FROM run_queue WHERE id=?").get(entry.id) as { short_lived?: number } | undefined;
    if (row?.short_lived) { underShortLivedKey(() => this.startNow(owner, entry, place)); return; }
    this.startNow(owner, entry, place);
  }
  private startNow(owner: string, entry: QueueEntry, place: () => void): void {
    void this.runtime.run({
      prompt: entry.prompt, source: entry.source,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}), onTextDelta: () => undefined,
      onStarted: (run) => this.mark(owner, entry.id, "running", { runId: run.id }),
    }).then(
      (run) => this.mark(owner, entry.id, run.status === "completed" ? "done" : "failed",
        { runId: run.id, ...(run.status === "completed" ? {} : { error: `The task ended as ${run.status}` }) }),
      (error: unknown) => this.mark(owner, entry.id, "failed", { error: errorText(error) }),
    ).finally(() => {
      // The place goes back first, so whatever is waiting can take it straight away.
      place();
      try { this.drain(owner); } catch { /* the line must never break a finished task */ }
    });
  }
  private mark(owner: string, id: string, status: QueueEntry["status"], patch: { runId?: string; error?: string }): void {
    this.store.sqlite.prepare(`UPDATE run_queue SET status=?, run_id=COALESCE(?,run_id), error=COALESCE(?,error),
      updated_at=? WHERE owner=? AND id=?`)
      .run(status, patch.runId ?? null, patch.error ?? null, new Date().toISOString(), owner, id);
  }
  private toEntry(row: Record<string, unknown>): QueueEntry {
    return { id: String(row.id), prompt: String(row.prompt),
      sessionId: row.session_id === null ? null : String(row.session_id),
      source: String(row.source) as QueueSource, priority: Number(row.priority),
      status: String(row.status) as QueueEntry["status"], position: null,
      runId: row.run_id === null ? null : String(row.run_id),
      error: row.error === null ? null : String(row.error), createdAt: String(row.created_at) };
  }
}

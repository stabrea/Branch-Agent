import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";

/**
 * Team tasks: one durable identity and one claimant for a team request.
 *
 * A request is known by who owns it, the trusted source it came from (the app window, a household
 * profile, a person's key or a short-lived key, never a body field), the team and the caller's
 * request id. The first caller to claim it runs it; everybody else only observes it. A claimed task
 * stays claimed across a restart. A task that stopped before anything was done is "failed" (a new
 * request id may try again); one that stopped after something may have been done is
 * "needs_reconciliation": a person has to check what happened, and it is never run again on its own.
 * One whose turn stopped to ask the owner something is "waiting_owner": a known, clean stop with the
 * question kept, not a crash; a new request id runs it again once the owner has answered.
 * Every write after the claim names the owner, the source, the task, the claimant and the
 * generation, so a stale or wrong claimant changes nothing. Nothing here expires a claim or lets
 * another caller take it over.
 * A claim also records which opening of the store made it (its boot). A claim made by an earlier
 * opening belongs to a process that is gone, and one made by this opening whose turn is no longer
 * running here was dropped, so neither is reported as simply "claimed": whoever reads it settles it
 * from the record first (Teams.run, src/team-reconcile.ts). A task handed to a person
 * (src/team-handoff.ts) has no boot: a person, not a process, holds it, so it is left alone.
 * A stored result is found again only under the same fingerprint: after the team is edited, a
 * repeat of an old request id is refused as a different request, and its result is not reachable.
 */
export type TeamTaskState = "pending" | "claimed" | "completed" | "failed" | "needs_reconciliation" | "waiting_owner";
export interface TeamTaskScope { owner: string; source: string }
export interface TeamTask {
  taskId: string; owner: string; source: string; teamId: string; requestId: string; fingerprint: string;
  state: TeamTaskState; claimant: string | null; generation: number; parentRunId: string | null; parentSessionId: string | null; bootId: string | null;
  result: unknown; error: string | null; question: string | null; createdAt: string; updatedAt: string;
}
/** A claim the caller holds; later writes must present all of it. */
export interface TeamTaskClaim { scope: TeamTaskScope; taskId: string; claimant: string; generation: number }

export class TeamTaskConflictError extends Error {}
export class StaleTeamTaskClaimError extends Error {}

const maximumResultChars = 512_000;

/** One random id per opening of a store, so a claim can tell whether the process that made it is still this one. */
const boots = new WeakMap<Store, string>();
export function storeBoot(store: Store): string {
  return boots.get(store) ?? boots.set(store, randomUUID()).get(store)!;
}

/** A stable fingerprint of the request: the prompt and the team exactly as it will run. */
export function teamRequestFingerprint(input: { teamId: string; prompt: string; name: string; purpose: string; members: { specialistId: string; role: string; brief: string }[] }): string {
  const members = input.members.map((m) => [m.specialistId, m.role, m.brief]);
  return createHash("sha256").update(JSON.stringify([input.teamId, input.prompt, input.name, input.purpose, members])).digest("hex");
}

export class TeamTasks {
  constructor(private readonly store: Store) {
    // Q61 and Q63 must land together: this table has no migration, so a database made by an earlier
    // build of either (before boot_id) would need one; none has shipped.
    this.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS team_tasks(
      task_id TEXT PRIMARY KEY, owner TEXT NOT NULL, source TEXT NOT NULL, team_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','needs_reconciliation','waiting_owner')),
      claimant TEXT, generation INTEGER NOT NULL DEFAULT 0, boot_id TEXT, parent_session_id TEXT, parent_run_id TEXT, result TEXT, error TEXT, question TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner, source, team_id, request_id))`);
  }
  /** Records the request once, or finds the one already recorded; a changed request under a reused id is refused. */
  observe(scope: TeamTaskScope, teamId: string, requestId: string, fingerprint: string): TeamTask {
    const now = new Date().toISOString();
    this.store.sqlite.prepare(`INSERT INTO team_tasks(task_id,owner,source,team_id,request_id,fingerprint,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending',?,?) ON CONFLICT(owner,source,team_id,request_id) DO NOTHING`)
      .run(randomUUID(), scope.owner, scope.source, teamId, requestId, fingerprint, now, now);
    const row = this.store.sqlite.prepare("SELECT * FROM team_tasks WHERE owner=? AND source=? AND team_id=? AND request_id=?")
      .get(scope.owner, scope.source, teamId, requestId);
    const task = toTask(row!);
    if (task.fingerprint !== fingerprint)
      throw new TeamTaskConflictError("This request id was already used for a different request or a different team. Send a new request id to run new work.");
    return task;
  }
  /** Moves a pending task to claimed in one conditional write; only one caller can ever win it. */
  claim(scope: TeamTaskScope, taskId: string): TeamTaskClaim | null {
    const claimant = randomUUID();
    const row = this.store.sqlite.prepare(`UPDATE team_tasks SET state='claimed', claimant=?, boot_id=?, generation=generation+1, updated_at=?
      WHERE owner=? AND source=? AND task_id=? AND state='pending' RETURNING generation`)
      .get(claimant, storeBoot(this.store), new Date().toISOString(), scope.owner, scope.source, taskId);
    return row ? { scope, taskId, claimant, generation: Number(row.generation) } : null;
  }
  /** The task as this scope sees it; another scope's task is not found. */
  get(scope: TeamTaskScope, taskId: string): TeamTask | undefined {
    const row = this.store.sqlite.prepare("SELECT * FROM team_tasks WHERE owner=? AND source=? AND task_id=?").get(scope.owner, scope.source, taskId);
    return row ? toTask(row) : undefined;
  }
  /**
   * True when a claimed task's turn is gone: its claim came from an earlier opening of the store (a
   * process that died), or from this one while no turn for it is running here. A task held by a
   * person has no boot and is never orphaned.
   */
  orphaned(task: TeamTask, runningHere: boolean): boolean {
    return task.state === "claimed" && task.bootId !== null && (task.bootId !== storeBoot(this.store) || !runningHere);
  }
  /** Whether this exact claim still holds its task: same claimant, same generation, still claimed. */
  held(claim: TeamTaskClaim): boolean {
    return !!this.store.sqlite.prepare("SELECT 1 FROM team_tasks WHERE owner=? AND source=? AND task_id=? AND claimant=? AND generation=? AND state='claimed'")
      .get(claim.scope.owner, claim.scope.source, claim.taskId, claim.claimant, claim.generation);
  }
  /** Forgets a removed team's tasks, except those `keep` names (a turn still running here). */
  forgetTeam(owner: string, teamId: string, keep: (taskId: string) => boolean): number {
    const rows = this.store.sqlite.prepare("SELECT task_id FROM team_tasks WHERE owner=? AND team_id=?").all(owner, teamId);
    const drop = this.store.sqlite.prepare("DELETE FROM team_tasks WHERE task_id=?");
    return rows.map((row) => String(row.task_id)).filter((taskId) => !keep(taskId)).reduce((count, taskId) => count + Number(drop.run(taskId).changes), 0);
  }
  /** The claim as it stands in the store, for reconciling a task whose claimant is gone; null unless still claimed. */
  standingClaim(scope: TeamTaskScope, taskId: string): TeamTaskClaim | null {
    const task = this.get(scope, taskId);
    return task?.state === "claimed" && task.claimant ? { scope, taskId, claimant: task.claimant, generation: task.generation } : null;
  }
  /**
   * Notes the conversation the parent run will be created in, before the run exists, so a crash
   * between the run's creation and linkParentRun still leaves the task pointing at it.
   */
  linkParentSession(claim: TeamTaskClaim, sessionId: string): void {
    this.fenced(claim, "parent_session_id=?", [sessionId]);
  }
  /** Notes the parent run the moment it exists and before it does anything, so the task can always be traced to it. */
  linkParentRun(claim: TeamTaskClaim, parentRunId: string): void {
    this.fenced(claim, "parent_run_id=?", [parentRunId]);
  }
  /** Keeps the finished result on the still-claimed task, so it can be finished from it after a crash. */
  recordOutcome(claim: TeamTaskClaim, result: unknown): void {
    this.fenced(claim, "result=?", [boundedResult(result)]);
  }
  /** Ends a task that stopped before anything was done; the same request id is not run again. */
  markFailed(claim: TeamTaskClaim, error: string): void {
    this.fenced(claim, "state='failed', error=?", [error.slice(0, 2000)]);
  }
  /** Ends a task whose turn stopped to ask the owner something; the question is kept, and nothing more runs for it. */
  markWaitingOwner(claim: TeamTaskClaim, question: string): void {
    this.fenced(claim, "state='waiting_owner', question=?", [question.slice(0, 2000)]);
  }
  /** Ends a task whose effects may have happened: a person must check them; it is never run again on its own. */
  markNeedsReconciliation(claim: TeamTaskClaim, error: string): void {
    this.fenced(claim, "state='needs_reconciliation', error=?", [error.slice(0, 2000)]);
  }
  /**
   * Finishes a claimed task and writes `alongside` (the room's new messages) in one transaction:
   * either both land or neither does. It never waits on anything, so no transaction spans a model call.
   */
  complete(claim: TeamTaskClaim, result: unknown, alongside: () => void): void {
    const db = this.store.sqlite;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.fenced(claim, "state='completed', result=?", [boundedResult(result)]);
      alongside();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  /** One write that only lands for the exact claim: owner, source, task, claimant, generation, still claimed. */
  private fenced(claim: TeamTaskClaim, set: string, values: (string | null)[]): void {
    const row = this.store.sqlite.prepare(`UPDATE team_tasks SET ${set}, updated_at=?
      WHERE owner=? AND source=? AND task_id=? AND claimant=? AND generation=? AND state='claimed' RETURNING task_id`)
      .get(...values, new Date().toISOString(), claim.scope.owner, claim.scope.source, claim.taskId, claim.claimant, claim.generation);
    if (!row) throw new StaleTeamTaskClaimError("This team task is no longer held by this claim, so nothing was written.");
  }
}

/**
 * The result as stored. One too large to keep keeps everything but the answers' text: which team,
 * run and room, and each member's role, status and run, so a crash after it was recorded can still
 * be finished from it (each answer's text is in that member's own run).
 */
function boundedResult(result: unknown): string {
  const text = JSON.stringify(result ?? null);
  if (text.length <= maximumResultChars) return text;
  const whole = (result ?? {}) as { teamId?: unknown; parentRunId?: unknown; roomSessionId?: unknown; answers?: unknown };
  const answers = Array.isArray(whole.answers)
    ? whole.answers.map(({ specialistId, role, status, runId }: Record<string, unknown>) => ({ specialistId, role, status, runId })) : undefined;
  return JSON.stringify({ truncated: true, chars: text.length, teamId: whole.teamId, parentRunId: whole.parentRunId, roomSessionId: whole.roomSessionId, answers });
}

function toTask(row: Record<string, unknown>): TeamTask {
  return {
    taskId: String(row.task_id), owner: String(row.owner), source: String(row.source), teamId: String(row.team_id),
    requestId: String(row.request_id), fingerprint: String(row.fingerprint), state: row.state as TeamTaskState,
    claimant: row.claimant == null ? null : String(row.claimant), generation: Number(row.generation),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id), bootId: row.boot_id == null ? null : String(row.boot_id),
    result: row.result == null ? null : JSON.parse(String(row.result)), error: row.error == null ? null : String(row.error),
    question: row.question == null ? null : String(row.question),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

/** What a team task keeps once the owner deleted a conversation its answers came from: that they are gone, and nothing of them. */
export const deletedResult = { deleted: true };

/**
 * Called as a conversation is deleted (Store.purgeSession, before its runs go): every team task whose
 * room, own turn or member runs were in it loses its stored answers, question and details. The task
 * itself stays, so a repeat of its request id is still answered from the record and never runs again.
 */
export function forgetTeamResults(db: Store["sqlite"], sessionId: string): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_tasks'").get()) return 0;
  const runsHere = "SELECT id FROM tasks WHERE session_id=?1";
  return Number(db.prepare(`UPDATE team_tasks SET result=CASE WHEN result IS NULL THEN NULL ELSE ?2 END, question=NULL,
      error=CASE WHEN error IS NULL THEN NULL ELSE 'Its details were removed when the owner deleted a conversation it came from.' END, updated_at=?3
    WHERE parent_session_id=?1 OR json_extract(result,'$.roomSessionId')=?1 OR parent_run_id IN (${runsHere})
      OR EXISTS (SELECT 1 FROM json_each(team_tasks.result,'$.answers') AS a WHERE json_extract(a.value,'$.runId') IN (${runsHere}))`)
    .run(sessionId, JSON.stringify(deletedResult), new Date().toISOString()).changes);
}

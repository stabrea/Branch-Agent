import type { Store } from "./store.js";
import type { RunStatus } from "./contracts.js";
import type { TeamTaskClaim, TeamTaskScope, TeamTaskState, TeamTasks } from "./team-tasks.js";

/**
 * Team turn lineage (Q63): what a team task's turn did, read back from the runtime's own record.
 *
 * A team task is linked to its parent run before that run makes its first model call. Every tool
 * call the runtime makes is written down ("tool.started") before it runs, in the parent run and in
 * every member run started under it. So after a crash the task can be settled from the record:
 * a recorded result finishes it, a turn that started no tool call failed, and a turn that started
 * any tool call needs a person to check what happened. Nothing here runs the turn again, and
 * nothing here promises that an effect happened exactly once.
 * A run that was cut off and carried on after a restart continues under a new run id, linked only
 * by its "run.resumed" record, so the turn's runs are followed through those links both ways. A run
 * left "interrupted" can still be carried on, so a turn holding one is never settled as failed.
 */
export interface TeamRunResult {
  teamId: string; parentRunId: string; roomSessionId: string;
  answers: { specialistId: string; role: string; status: string; output: string; runId: string }[];
}
/** One tool call the turn started, and what the record says came of it. */
export interface TurnEffect { runId: string; toolCallId: string; name: string; outcome: "completed" | "failed" | "unknown" | "asked_owner" }
export interface ReconcileReport {
  taskId: string; state: TeamTaskState; parentRunId: string | null; effects: TurnEffect[]; note: string;
  /** Q66: every member of the turn and how far it got, across all of the turn's batches. */
  members: TeamMemberRun[];
}
/**
 * One member of a team turn: the run it answered in and that run's status, or "started" (its batch
 * began but the run was not recorded against it) or "not_started". A member run under the turn that
 * cannot be matched to a member is listed with no member or role. `batch` (Q64) is which batch the
 * turn started it in, counting from 1, as the turn's own "team.batch.started" records say; null when
 * no batch named it.
 */
export interface TeamMemberRun { member: string | null; role: string | null; runId: string | null; status: string; batch: number | null }

/**
 * Team tasks this process is working on right now, per open store; reconciling leaves these alone.
 * Every Teams instance on one store shares the list, and a store opened afresh (after a restart)
 * starts with none, because whatever was running before is gone.
 */
const dispatching = new WeakMap<Store, Set<string>>();
const working = (store: Store): Set<string> => dispatching.get(store) ?? dispatching.set(store, new Set()).get(store)!;
export function holdDispatch(store: Store, taskId: string): void { working(store).add(taskId); }
export function releaseDispatch(store: Store, taskId: string): void { working(store).delete(taskId); }
/** Whether this process is working on a team task right now (Q62 refuses a handoff while it is). */
export function dispatchHeld(store: Store, taskId: string): boolean { return dispatching.get(store)?.has(taskId) ?? false; }

/**
 * Run statuses that mean the run has stopped for good; any other unfinished status may still act later.
 * "interrupted" is not one: a restart can carry an interrupted run on (src/never-break/resume.ts).
 */
const stoppedStatuses: ReadonlySet<RunStatus> = new Set<RunStatus>(["failed", "cancelled", "budget_exceeded"]);
export function runStopped(status: RunStatus | undefined): boolean {
  return status === undefined || stoppedStatuses.has(status);
}

/**
 * The parent run and every run started under it, however deep, in the order they were found, with
 * every run that carried one of them on after a restart and every run one of them carried on from.
 */
export function lineageRuns(store: Store, parentRunId: string): string[] {
  const found: string[] = [], queue = [parentRunId];
  while (queue.length) {
    const runId = queue.shift()!;
    if (found.includes(runId)) continue;
    found.push(runId);
    queue.push(...linkedRuns(store, runId));
  }
  return found;
}

/** Runs started under this one, runs that carried it on, and the run it carried on from. */
function linkedRuns(store: Store, runId: string): string[] {
  const ids = (sql: string) => store.sqlite.prepare(sql).all(runId).map((row) => String(row.id));
  return [
    ...ids("SELECT run_id AS id FROM events WHERE kind='run.started' AND json_extract(data,'$.parentRunId')=?"),
    ...ids("SELECT run_id AS id FROM events WHERE kind='run.resumed' AND json_extract(data,'$.from')=?"),
    ...ids("SELECT json_extract(data,'$.from') AS id FROM events WHERE kind='run.resumed' AND run_id=? AND json_extract(data,'$.from') IS NOT NULL"),
  ];
}

/** The last run in this run's chain of carry-ons after restarts (itself when it was never carried on). */
export function latestCarryOn(store: Store, runId: string): string {
  let latest = runId;
  for (const seen = new Set<string>(); !seen.has(latest);) {
    seen.add(latest);
    const next = store.sqlite.prepare("SELECT run_id FROM events WHERE kind='run.resumed' AND json_extract(data,'$.from')=? ORDER BY id DESC LIMIT 1").get(latest);
    if (!next) break;
    latest = String(next.run_id);
  }
  return latest;
}

/**
 * True when a run in the turn was cut off and can still be carried on, so it may act later. A run
 * already carried on is not counted: the run that carries it on is in the lineage and speaks for it.
 */
function mayStillAct(store: Store, parentRunId: string | null): boolean {
  return !!parentRunId && lineageRuns(store, parentRunId).some((runId) => store.run(runId)?.status === "interrupted" && latestCarryOn(store, runId) === runId);
}

/** Every tool call started by the parent run and by every run started under it. */
export function turnEffects(store: Store, parentRunId: string): TurnEffect[] {
  return lineageRuns(store, parentRunId).flatMap((runId) => runEffects(store, runId));
}

/**
 * A run's tool calls; an ending is matched to the latest unmatched start with its id, so a reused id
 * is not lost. A call that stopped to ask the owner did not go ahead: either the approval rules asked
 * first ("policy.ask", naming the call) or the tool itself asked (user.ask, say), which ends the run
 * with "attention.needed" right after the call started. A question recovery put after a restart
 * (afterRestart) says nothing about the call: its outcome stays unknown.
 */
function runEffects(store: Store, runId: string): TurnEffect[] {
  const rows = store.sqlite.prepare("SELECT kind, data FROM events WHERE run_id=? AND kind IN ('tool.started','tool.completed','tool.failed','tool.stalled','policy.ask','attention.needed') ORDER BY id").all(runId);
  const effects: TurnEffect[] = [];
  rows.forEach((row, index) => {
    const data = JSON.parse(String(row.data)) as { id?: unknown; name?: unknown; afterRestart?: unknown };
    if (row.kind === "attention.needed") {
      const asking = data.afterRestart === true ? undefined : effects.findLast((effect) => effect.outcome === "unknown");
      if (asking) asking.outcome = "asked_owner";
      return;
    }
    const toolCallId = data.id == null ? `#${index}` : String(data.id);
    if (row.kind === "tool.started") { effects.push({ runId, toolCallId, name: String(data.name ?? ""), outcome: "unknown" }); return; }
    const started = effects.findLast((effect) => effect.toolCallId === toolCallId && effect.outcome === "unknown");
    if (started) started.outcome = row.kind === "tool.completed" ? "completed" : row.kind === "policy.ask" ? "asked_owner" : "failed";
  });
  return effects;
}

/** The parent run's records of one kind written after the event with this id, oldest first. */
function recordsAfter(store: Store, runId: string, kind: string, afterId: number): { id: number; data: Record<string, unknown> }[] {
  return store.sqlite.prepare("SELECT id, data FROM events WHERE run_id=? AND kind=? AND id>? ORDER BY id").all(runId, kind, afterId)
    .map((row) => ({ id: Number(row.id), data: JSON.parse(String(row.data)) as Record<string, unknown> }));
}

/**
 * Q66: every member of a team turn and how far it got, read from the record, across every batch.
 * The turn names its members before any starts ("team.members.planned"), notes each batch as it
 * starts ("team.batch.started"), and the runtime notes each batch's member runs when it finishes
 * ("delegation.fanout"). Only records after the plan are read, so a fan-out the team's own turn made
 * earlier is not taken for a member's. Runs started under the turn that no record names are listed too.
 * A member run is created before it does anything, so a member with no run under the turn did nothing.
 */
export function memberRuns(store: Store, parentRunId: string | null): TeamMemberRun[] {
  if (!parentRunId) return [];
  const plan = recordsAfter(store, parentRunId, "team.members.planned", 0).at(-1);
  const planned = (plan?.data.members ?? []) as { member: string; role: string }[];
  const after = plan?.id ?? 0;
  // Each member's batch, counting from 1, in the order the turn started them.
  const started = new Map(recordsAfter(store, parentRunId, "team.batch.started", after)
    .flatMap((record, index) => (record.data.members as string[]).map((member) => [member, index + 1] as const)));
  const ran = new Map<string, string>();
  for (const record of recordsAfter(store, parentRunId, "delegation.fanout", after))
    for (const [member, outcome] of Object.entries((record.data.tasks ?? {}) as Record<string, { runId: string }>)) ran.set(member, outcome.runId);
  // A member run carried on after a restart is reported by the run that carried it on.
  const statusOf = (runId: string) => store.run(latestCarryOn(store, runId))?.status ?? "unknown";
  const named = new Set(ran.values());
  const unnamed = store.sqlite.prepare("SELECT run_id FROM events WHERE kind='run.started' AND json_extract(data,'$.parentRunId')=? ORDER BY id").all(parentRunId)
    .map((row) => String(row.run_id)).filter((runId) => !named.has(runId));
  // A member of a batch that began, with no run named for it, may be one of the unnamed runs; with none, it never got a run.
  const listed: TeamMemberRun[] = planned.map(({ member, role }) => {
    const runId = ran.get(member) ?? null;
    const batch = started.get(member) ?? null;
    return { member, role, runId, status: runId ? statusOf(runId) : batch && unnamed.length ? "started" : "not_started", batch };
  });
  return [...listed, ...unnamed.map((runId) => ({ member: null, role: null, runId, status: statusOf(runId), batch: null }))];
}

/** The member listing in words, for the reason a task needs a person. */
export function describeMemberRuns(members: TeamMemberRun[]): string {
  if (!members.length) return "";
  const ran = members.filter((m) => m.runId).map((m) => `${m.role ?? "an unnamed member"} (${m.status}, run ${m.runId})`);
  const rest = members.filter((m) => !m.runId).map((m) => `${m.role} (${m.status === "started" ? "started, run not recorded" : "not started"})`);
  return `Members that ran: ${ran.join(", ") || "none"}. Not run: ${rest.join(", ") || "none"}.`;
}

/**
 * Finishes the task and writes the members' answers to the room in one transaction, then tells
 * listeners once it is committed. Used by a live turn and by reconciliation alike.
 */
export function finishTeamTask(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, result: TeamRunResult): void {
  let announce = () => {};
  tasks.complete(claim, result, () => {
    for (const answer of result.answers) store.message(result.roomSessionId, { role: "assistant", content: `[${answer.role}] ${answer.output || `(no answer: ${answer.status})`}` });
    announce = store.eventUnannounced(result.parentRunId, "team.ran", { teamId: result.teamId, roomSessionId: result.roomSessionId, answers: result.answers.map((a) => ({ role: a.role, status: a.status, runId: a.runId })) });
  });
  announce();
}

/**
 * Ends a claimed task whose turn stopped to ask the owner (a run that needs input). The question
 * comes from the runtime's own "attention.needed" record. Asked before a step ran, it is a known
 * outcome: the task waits for the owner. Asked because a restart cut a step off (afterRestart), or
 * with any tool call whose outcome is unknown, something may have happened: a person must check.
 */
export function settleWaiting(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, parentRunId: string, fallback: string, lineageRoot = parentRunId): TeamTaskState {
  const asked = store.sqlite.prepare("SELECT data FROM events WHERE run_id=? AND kind='attention.needed' ORDER BY id DESC LIMIT 1").get(parentRunId);
  const data = asked ? (JSON.parse(String(asked.data)) as { question?: unknown; afterRestart?: unknown }) : {};
  const question = String(data.question ?? fallback) || "The team's turn stopped to ask you something.";
  const unknown = turnEffects(store, lineageRoot).filter((effect) => effect.outcome === "unknown");
  if (data.afterRestart === true || unknown.length) {
    tasks.markNeedsReconciliation(claim, `Stopped with ${unknown.length} tool call(s) whose outcome is unknown; check them before trying again: ${question}`);
    return "needs_reconciliation";
  }
  tasks.markWaitingOwner(claim, question);
  return "waiting_owner";
}

/**
 * Finishes a task whose recorded result was too large to keep in full. Each member's answer is read
 * back from that member's own run, so the room gets every answer; nothing is run again. A marker
 * without the members' runs (so nothing to read back) is finished as it is.
 */
function finishTruncated(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, recorded: TeamRunResult & { truncated?: boolean }): void {
  if (!Array.isArray(recorded.answers) || !recorded.roomSessionId) return tasks.complete(claim, recorded, () => {});
  const answers = recorded.answers.map((answer) => ({ ...answer, output: store.run(answer.runId)?.output ?? "" }));
  finishTeamTask(store, tasks, claim, { ...recorded, answers });
}

/** Member runs under the turn that finished: their answers exist, even if the turn never recorded them. */
function membersAnswered(store: Store, parentRunId: string | null): number {
  if (!parentRunId) return 0;
  return lineageRuns(store, parentRunId).filter((runId) => store.run(runId)?.status === "completed"
    && store.sqlite.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.started' AND json_extract(data,'$.parentRunId') IS NOT NULL").get(runId)).length;
}

/**
 * Ends a claimed task that stopped without a result: failed only if its turn started no tool call,
 * no member finished an answer and no run in it can still be carried on; otherwise it needs a person.
 */
export function settleUnfinished(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, parentRunId: string | null, why: string): TeamTaskState {
  const effects = parentRunId ? turnEffects(store, parentRunId) : [];
  // Q66: the reason names which members ran and which never started, whichever batch it stopped in.
  const needs = (reason: string): TeamTaskState => {
    tasks.markNeedsReconciliation(claim, `${reason}: ${why}. ${describeMemberRuns(memberRuns(store, parentRunId))}`.trim());
    return "needs_reconciliation";
  };
  if (effects.length) return needs(`Stopped after ${effects.length} tool call(s) whose effects must be checked before this is tried again`);
  const answered = membersAnswered(store, parentRunId);
  if (answered) return needs(`${answered} member(s) finished an answer that was never recorded; check them before trying again`);
  if (mayStillAct(store, parentRunId)) return needs("Its run was cut off and can still be carried on, so it may yet act; check it before trying again");
  tasks.markFailed(claim, `Nothing was done: ${why}`);
  return "failed";
}

/**
 * True when this run is a team task's own turn that the task never named (a crash came between the
 * run being created and the task noting it). Recovery after a restart must not carry such a run on:
 * nothing would trace what it did. The task names the conversation first, before the run exists.
 */
export function unlinkedTeamParent(store: Store, sessionId: string): boolean {
  if (!store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_tasks'").get()) return false;
  return !!store.sqlite.prepare("SELECT 1 FROM team_tasks WHERE parent_session_id=? AND parent_run_id IS NULL").get(sessionId);
}

/** The team turn's first run: the one the task named, or else the first run in the conversation it named. */
function turnRoot(store: Store, task: { parentRunId: string | null; parentSessionId: string | null }): string | null {
  if (task.parentRunId || !task.parentSessionId) return task.parentRunId;
  const first = store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=? ORDER BY created_at, rowid LIMIT 1").get(task.parentSessionId);
  return first ? String(first.id) : null;
}

/**
 * Settles a claimed team task whose claimant is gone (after a restart, for example) from the
 * runtime's record. It never claims the task, never runs anything and never replays an effect.
 */
export function reconcileTeamTask(store: Store, tasks: TeamTasks, scope: TeamTaskScope, taskId: string): ReconcileReport {
  const task = tasks.get(scope, taskId);
  if (!task) throw new Error("Team task not found");
  const root = turnRoot(store, task);
  const report = (state: TeamTaskState, note: string): ReconcileReport =>
    ({ taskId, state, parentRunId: task.parentRunId, effects: root ? turnEffects(store, root) : [], note, members: memberRuns(store, root) });
  if (task.state !== "claimed") return report(task.state, "This task is already settled.");
  if (working(store).has(taskId)) return report("claimed", "This task is still running here.");
  // Handed to a person (src/team-handoff.ts): they hold it, not a process, so there is nothing to settle.
  if (task.bootId === null) return report("claimed", `It is held by ${task.claimant ?? "someone"}, who took it over.`);
  // The turn's latest carry-on after a restart says how it stopped, not the run it began as.
  const parent = root ? store.run(latestCarryOn(store, root)) : undefined;
  // No other process can be the claimant: a second Branch cannot open this database while one has it
  // (the store opens SQLite with locking_mode=EXCLUSIVE, src/store.ts; tests/team-turn-lineage.test.mjs
  // proves a second createBranch on the folder is refused). So a claimed task not held by this store
  // belongs to a process that is gone. A run under it still going is left alone all the same.
  if (root && lineageRuns(store, root).some((runId) => store.run(runId)?.status === "running"))
    return report("claimed", "Its run, or a member's, is still going.");
  const claim = tasks.standingClaim(scope, taskId);
  if (!claim) return report(tasks.get(scope, taskId)!.state, "This task changed while it was being checked.");
  const recorded = task.result as (TeamRunResult & { truncated?: boolean }) | null;
  if (recorded?.truncated) {
    finishTruncated(store, tasks, claim, recorded);
    return report("completed", "Finished from the result the turn recorded, which was too large to keep in full; the members' answers were written to the room from their own runs. Nothing was run again.");
  }
  if (recorded && Array.isArray(recorded.answers)) {
    finishTeamTask(store, tasks, claim, recorded);
    return report("completed", "Finished from the result the turn recorded; nothing was run again.");
  }
  if (parent?.status === "needs_input")
    return waitingReport(report, settleWaiting(store, tasks, claim, parent.id, parent.output, root!));
  const state = settleUnfinished(store, tasks, claim, root, "the turn stopped before its result was recorded");
  return report(state, state === "failed" ? "Nothing was done, so a new request id may try again." : "Check these effects before trying again.");
}

function waitingReport(report: (state: TeamTaskState, note: string) => ReconcileReport, state: TeamTaskState): ReconcileReport {
  return report(state, state === "waiting_owner" ? "Its turn stopped to ask the owner; nothing more is run for it."
    : "Its turn stopped with a step whose outcome is unknown; check these effects before trying again.");
}

import type { Store } from "./store.js";
import type { RunStatus } from "./contracts.js";
import { StaleTeamTaskClaimError, type TeamTaskClaim, type TeamTaskScope, type TeamTaskState, type TeamTasks } from "./team-tasks.js";

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
}

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
function latestCarryOn(store: Store, runId: string): string {
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
 * (afterRestart) says nothing about the call: its outcome stays unknown. A step recovery settled when
 * it carried the run on ("run.auto_resumed") may have been done again; one with no record of its own
 * counts with its outcome unknown.
 */
function runEffects(store: Store, runId: string): TurnEffect[] {
  const rows = store.sqlite.prepare("SELECT kind, data FROM events WHERE run_id=? AND kind IN ('tool.started','tool.completed','tool.failed','tool.stalled','policy.ask','attention.needed','run.auto_resumed') ORDER BY id").all(runId);
  const effects: TurnEffect[] = [];
  rows.forEach((row, index) => {
    const data = JSON.parse(String(row.data)) as { id?: unknown; name?: unknown; afterRestart?: unknown; steps?: unknown };
    if (row.kind === "run.auto_resumed") { effects.push(...carriedOnSteps(runId, data.steps, effects, index)); return; }
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

/** The steps a carry-on settled that this run has no record of: each may have been done again, so its outcome is unknown. */
function carriedOnSteps(runId: string, steps: unknown, known: TurnEffect[], index: number): TurnEffect[] {
  const listed = Array.isArray(steps) ? steps as { tool?: unknown; callId?: unknown }[] : [];
  return listed.filter((step) => step.callId == null || !known.some((effect) => effect.toolCallId === String(step.callId)))
    .map((step, at) => ({ runId, toolCallId: step.callId == null ? `#${index}.${at}` : String(step.callId), name: String(step.tool ?? ""), outcome: "unknown" as const }));
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
 * The parent-side record that the members were sent out, written on the team's own run before the
 * fanout starts. Member runs live in conversations of their own, which the owner may delete; this
 * record and the runtime's "delegation.fanout" (which names each member's run) stay with the parent.
 */
export const membersSentKind = "team.members_sent";

/** True when a run named here no longer exists: the owner deleted the conversation it was in. */
export function memberRunGone(store: Store, runIds: readonly unknown[]): boolean {
  return runIds.some((runId) => typeof runId === "string" && !store.run(runId));
}

/**
 * Why the answers can no longer be written, when the owner deleted where they go or where one came
 * from: the room, the turn's own run (the finish records "team.ran" on it), or a member's run (a
 * team task keeps no copy of answers from a conversation the owner deleted). Null while all remain.
 */
function answersHomeDeleted(store: Store, result: TeamRunResult): string | null {
  if (!store.sqlite.prepare("SELECT 1 FROM sessions WHERE id=?").get(result.roomSessionId))
    return "The team's room was deleted while it worked; its answers could not be written there.";
  if (!store.run(result.parentRunId)) return "The team's own conversation was deleted while it worked; its answers could not be written to the room.";
  if (memberRunGone(store, (result.answers ?? []).map((answer) => answer.runId)))
    return "A member's conversation was deleted while the team worked; its answers are gone and were not written to the room.";
  return null;
}

/**
 * The live turn's check before its result is recorded: if the owner deleted a conversation the
 * answers go to or came from, nothing is kept or written, and the task is settled for a person.
 */
export function answersDeletedBeforeRecord(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, result: TeamRunResult): boolean {
  const deleted = answersHomeDeleted(store, result);
  if (deleted) tasks.markAnswersDeleted(claim, deleted);
  return deleted !== null;
}

/**
 * Settles a claimed task whose recorded answers could not be written to the room, so nobody meets
 * the same failure again. If the owner deleted where they go, the answers go too; otherwise they are
 * kept for the person who checks. A claim that moved on is its new holder's, so it is left alone.
 */
function settleUnwritten(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, result: TeamRunResult, error: unknown): TeamTaskState {
  if (error instanceof StaleTeamTaskClaimError) return tasks.get(claim.scope, claim.taskId)?.state ?? "claimed";
  const deleted = answersHomeDeleted(store, result);
  if (deleted) tasks.markAnswersDeleted(claim, deleted);
  else tasks.markNeedsReconciliation(claim, `The answers were recorded but could not be written to the room: ${error instanceof Error ? error.message : String(error)}`);
  return "needs_reconciliation";
}

/**
 * The live turn's finish; false when it could not finish. If the owner deleted the room or the
 * turn's conversation while the members worked, the task is settled for a person there and then.
 * Any other failure is thrown as before, and reconcile finishes the task from the record later.
 */
export function finishLiveTurn(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, result: TeamRunResult): boolean {
  try {
    finishTeamTask(store, tasks, claim, result);
    return true;
  } catch (error) {
    if (!answersHomeDeleted(store, result)) throw error;
    settleUnwritten(store, tasks, claim, result, error);
    return false;
  }
}

const deletedBeforeWritten = "The owner deleted a conversation this task's answers were in before they were written to the room; check the room before trying again.";

/**
 * Finishes a task from the result its turn recorded, or null when it recorded none. A result the
 * owner's delete already cleared settles for a person: the members did answer, so it is never taken
 * for a turn that did nothing. Answers that cannot be written settle for a person too, never thrown.
 */
function finishFromRecord(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, recorded: (TeamRunResult & { truncated?: boolean; deleted?: boolean }) | null): { state: TeamTaskState; note: string } | null {
  if (recorded?.deleted) {
    tasks.markNeedsReconciliation(claim, deletedBeforeWritten);
    return { state: "needs_reconciliation", note: deletedBeforeWritten };
  }
  if (!recorded || (!recorded.truncated && !Array.isArray(recorded.answers))) return null;
  let written = true;
  try {
    if (recorded.truncated) written = finishTruncated(store, tasks, claim, recorded);
    else finishTeamTask(store, tasks, claim, recorded);
  } catch (error) {
    const state = settleUnwritten(store, tasks, claim, recorded, error);
    return { state, note: state === "needs_reconciliation" ? "The recorded answers could not be written to the room; check them before trying again. Nothing was run again." : "This task changed while it was being checked." };
  }
  if (!written) return { state: "completed", note: "Finished from an older record that kept no answers; nothing was written to the room, and each member's answer is in its own run. Nothing was run again." };
  return { state: "completed", note: recorded.truncated
    ? "Finished from the result the turn recorded, which was too large to keep in full; the members' answers were written to the room from their own runs. Nothing was run again."
    : "Finished from the result the turn recorded; nothing was run again." };
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
/** True when the answers were written to the room; a marker from before answers were kept completes as it is. */
function finishTruncated(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, recorded: TeamRunResult & { truncated?: boolean }): boolean {
  if (!Array.isArray(recorded.answers) || !recorded.roomSessionId) { tasks.complete(claim, { ...recorded, unwritten: true }, () => {}); return false; }
  const answers = recorded.answers.map((answer) => ({ ...answer, output: store.run(answer.runId)?.output ?? "" }));
  finishTeamTask(store, tasks, claim, { ...recorded, answers });
  return true;
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
  if (effects.length) {
    tasks.markNeedsReconciliation(claim, `Stopped after ${effects.length} tool call(s) whose effects must be checked before this is tried again: ${why}`);
    return "needs_reconciliation";
  }
  const answered = membersAnswered(store, parentRunId);
  if (answered) {
    tasks.markNeedsReconciliation(claim, `${answered} member(s) finished an answer that was never recorded; check them before trying again: ${why}`);
    return "needs_reconciliation";
  }
  if (mayStillAct(store, parentRunId)) {
    tasks.markNeedsReconciliation(claim, `Its run was cut off and can still be carried on, so it may yet act; check it before trying again: ${why}`);
    return "needs_reconciliation";
  }
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
    ({ taskId, state, parentRunId: task.parentRunId, effects: root ? turnEffects(store, root) : [], note });
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
  const finished = finishFromRecord(store, tasks, claim, task.result as (TeamRunResult & { truncated?: boolean; deleted?: boolean }) | null);
  if (finished) return report(finished.state, finished.note);
  // The owner deleted the turn's own conversation or a member's: what it did cannot be read back, so it is never "nothing was done".
  const deleted = recordDeleted(store, task, root);
  if (deleted) {
    tasks.markNeedsReconciliation(claim, deleted);
    return report("needs_reconciliation", deleted);
  }
  if (parent?.status === "needs_input")
    return waitingReport(report, settleWaiting(store, tasks, claim, parent.id, parent.output, root!));
  const state = settleUnfinished(store, tasks, claim, root, "the turn stopped before its result was recorded");
  return report(state, state === "failed" ? "Nothing was done, so a new request id may try again." : "Check these effects before trying again.");
}

/**
 * Why the turn's record is incomplete because the owner deleted part of it, or null: the task names a
 * turn run or conversation that no longer exists, or the parent's own record names members whose runs are gone.
 */
function recordDeleted(store: Store, task: { parentRunId: string | null; parentSessionId: string | null }, root: string | null): string | null {
  const own = (task.parentRunId && !store.run(task.parentRunId))
    || (!!task.parentSessionId && !store.sqlite.prepare("SELECT 1 FROM sessions WHERE id=?").get(task.parentSessionId));
  if (own) return "Its record was deleted, so what it did cannot be known; check before trying again.";
  if (root && lineageRuns(store, root).some((runId) => membersMissing(store, runId)))
    return "Its record is incomplete: a member's conversation was deleted, so what it did cannot be known; check before trying again.";
  return null;
}

/**
 * True when this run's own record says it sent members out and not all of them are still on record:
 * its "delegation.fanout" names a member run that is gone, or (cut off before that was written) it
 * sent more members than there are runs still started under it.
 */
function membersMissing(store: Store, runId: string): boolean {
  const recorded = (kind: string) => store.sqlite.prepare("SELECT data FROM events WHERE run_id=? AND kind=?").all(runId, kind)
    .map((row) => JSON.parse(String(row.data)) as { tasks?: Record<string, { runId?: unknown }>; members?: unknown });
  const fanouts = recorded("delegation.fanout");
  if (fanouts.some((fanout) => memberRunGone(store, Object.values(fanout.tasks ?? {}).map((member) => member.runId)))) return true;
  if (fanouts.length) return false;
  const started = Number(store.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='run.started' AND json_extract(data,'$.parentRunId')=?").get(runId)?.n ?? 0);
  return recorded(membersSentKind).some((sent) => started < Number(sent.members ?? 0));
}

function waitingReport(report: (state: TeamTaskState, note: string) => ReconcileReport, state: TeamTaskState): ReconcileReport {
  return report(state, state === "waiting_owner" ? "Its turn stopped to ask the owner; nothing more is run for it."
    : "Its turn stopped with a step whose outcome is unknown; check these effects before trying again.");
}

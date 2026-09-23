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
 */
export interface TeamRunResult {
  teamId: string; parentRunId: string; roomSessionId: string;
  answers: { specialistId: string; role: string; status: string; output: string; runId: string }[];
}
/** One tool call the turn started, and what the record says came of it. */
export interface TurnEffect { runId: string; toolCallId: string; name: string; outcome: "completed" | "failed" | "unknown" }
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

/** Run statuses that mean the run has stopped for good; any other unfinished status may still act later. */
const stoppedStatuses: ReadonlySet<RunStatus> = new Set<RunStatus>(["failed", "cancelled", "interrupted", "budget_exceeded"]);
export function runStopped(status: RunStatus | undefined): boolean {
  return status === undefined || stoppedStatuses.has(status);
}

/** Every tool call started by the parent run and by every run started under it, however deep. */
export function turnEffects(store: Store, parentRunId: string): TurnEffect[] {
  const effects: TurnEffect[] = [], seen = new Set<string>(), queue = [parentRunId];
  while (queue.length) {
    const runId = queue.shift()!;
    if (seen.has(runId)) continue;
    seen.add(runId);
    effects.push(...runEffects(store, runId));
    const children = store.sqlite.prepare("SELECT run_id FROM events WHERE kind='run.started' AND json_extract(data,'$.parentRunId')=?").all(runId);
    queue.push(...children.map((row) => String(row.run_id)));
  }
  return effects;
}

function runEffects(store: Store, runId: string): TurnEffect[] {
  const rows = store.sqlite.prepare("SELECT kind, data FROM events WHERE run_id=? AND kind IN ('tool.started','tool.completed','tool.failed','tool.stalled') ORDER BY id").all(runId);
  const effects = new Map<string, TurnEffect>();
  rows.forEach((row, index) => {
    const data = JSON.parse(String(row.data)) as { id?: unknown; name?: unknown };
    const toolCallId = data.id == null ? `#${index}` : String(data.id);
    if (row.kind === "tool.started") effects.set(toolCallId, { runId, toolCallId, name: String(data.name ?? ""), outcome: "unknown" });
    else if (effects.has(toolCallId)) effects.get(toolCallId)!.outcome = row.kind === "tool.completed" ? "completed" : "failed";
  });
  return [...effects.values()];
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

/** Ends a claimed task that stopped without a result: failed if its turn started no tool call, otherwise it needs a person. */
export function settleUnfinished(store: Store, tasks: TeamTasks, claim: TeamTaskClaim, parentRunId: string | null, why: string): TeamTaskState {
  const effects = parentRunId ? turnEffects(store, parentRunId) : [];
  if (!effects.length) {
    tasks.markFailed(claim, `Nothing was done: ${why}`);
    return "failed";
  }
  tasks.markNeedsReconciliation(claim, `Stopped after ${effects.length} tool call(s) whose effects must be checked before this is tried again: ${why}`);
  return "needs_reconciliation";
}

/**
 * Settles a claimed team task whose claimant is gone (after a restart, for example) from the
 * runtime's record. It never claims the task, never runs anything and never replays an effect.
 */
export function reconcileTeamTask(store: Store, tasks: TeamTasks, scope: TeamTaskScope, taskId: string): ReconcileReport {
  const task = tasks.get(scope, taskId);
  if (!task) throw new Error("Team task not found");
  const report = (state: TeamTaskState, note: string): ReconcileReport =>
    ({ taskId, state, parentRunId: task.parentRunId, effects: task.parentRunId ? turnEffects(store, task.parentRunId) : [], note });
  if (task.state !== "claimed") return report(task.state, "This task is already settled.");
  if (working(store).has(taskId)) return report("claimed", "This task is still running here.");
  const parent = task.parentRunId ? store.run(task.parentRunId) : undefined;
  if (parent && parent.status === "running") return report("claimed", "Its run is still going.");
  const claim = tasks.standingClaim(scope, taskId);
  if (!claim) return report(tasks.get(scope, taskId)!.state, "This task changed while it was being checked.");
  const recorded = task.result as TeamRunResult | null;
  if (recorded && Array.isArray(recorded.answers)) {
    finishTeamTask(store, tasks, claim, recorded);
    return report("completed", "Finished from the result the turn recorded; nothing was run again.");
  }
  if (parent && !runStopped(parent.status) && parent.status !== "completed")
    { tasks.markNeedsReconciliation(claim, `Its run is ${parent.status} and may still act.`); return report("needs_reconciliation", `Its run is ${parent.status}.`); }
  const state = settleUnfinished(store, tasks, claim, task.parentRunId, "the turn stopped before its result was recorded");
  return report(state, state === "failed" ? "Nothing was done, so a new request id may try again." : "Check these effects before trying again.");
}

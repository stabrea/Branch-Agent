import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { Message, Run } from "./contracts.js";
import { StaleTeamTaskClaimError, TeamTasks, teamRequestFingerprint, type TeamTaskClaim } from "./team-tasks.js";
import { answersDeletedBeforeRecord, dispatchHeld, finishLiveTurn, holdDispatch, reconcileTeamTask, membersSentKind, releaseDispatch, runStopped, settleUnfinished, settleWaiting, turnEffects, type ReconcileReport, type TeamRunResult } from "./team-reconcile.js";

/**
 * Teams: a named, durable group of specialists with roles and a shared room. A team task fans out
 * to every member with its role attached, and every result lands in the room's conversation in
 * order, so the history is one place people and members can read after a restart.
 */
export const TeamMemberSchema = z.object({
  specialistId: z.string().uuid(),
  role: z.string().trim().min(1).max(80),
  brief: z.string().max(1000).default(""),
}).strict();
export const TeamSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  purpose: z.string().max(1000).default(""),
  members: z.array(TeamMemberSchema).min(1).max(8),
}).strict();
export interface Team { id: string; name: string; purpose: string; members: z.infer<typeof TeamMemberSchema>[]; roomSessionId: string; createdAt: string; updatedAt: string }

export class Teams {
  private readonly tasks: TeamTasks;
  constructor(private readonly store: Store, private readonly owner: string) {
    this.tasks = new TeamTasks(store);
  }
  list(): Team[] {
    return this.store.list("governance", this.owner).filter((r) => r.id.startsWith("team:")).map((r) => r.data as unknown as Team).sort((a, b) => a.name.localeCompare(b.name));
  }
  get(id: string): Team {
    const team = this.store.get("governance", this.owner, `team:${id}`)?.data as unknown as Team | undefined;
    if (!team) throw new Error("Team not found");
    return team;
  }
  /** Creates or updates a team; the room conversation is created once and kept across restarts. */
  save(input: unknown): Team {
    const value = TeamSchema.parse(input);
    if (new Set(value.members.map((m) => m.specialistId)).size !== value.members.length) throw new Error("A specialist can hold one role per team");
    for (const member of value.members) if (!this.store.get("specialists", this.owner, member.specialistId)) throw new Error(`Specialist ${member.specialistId} does not exist`);
    const existing = value.id ? (this.store.get("governance", this.owner, `team:${value.id}`)?.data as unknown as Team | undefined) : undefined;
    const now = new Date().toISOString();
    const room = existing?.roomSessionId ?? this.openRoom(value.name, value.purpose);
    const team: Team = { id: value.id ?? randomUUID(), name: value.name, purpose: value.purpose, members: value.members, roomSessionId: room, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.store.save("governance", this.owner, `team:${team.id}`, { ...team });
    return team;
  }
  /** A new room conversation, opened with a line that says whose room it is. */
  private openRoom(name: string, purpose: string): string {
    const run = this.store.createRun(this.owner, `Team room: ${name}`);
    this.store.finish(run.id, "completed", "Room opened");
    this.store.message(run.sessionId, { role: "system", content: `Team "${name}" room. ${purpose}`.trim() });
    return run.sessionId;
  }
  /**
   * The team with a room to write to. The owner may delete the room's conversation (that deletes the
   * history, not the team), so a turn opens a fresh room before anything runs, rather than failing after.
   */
  private withRoom(team: Team): Team {
    if (this.store.ownsSession(this.owner, team.roomSessionId)) return team;
    const reopened: Team = { ...team, roomSessionId: this.openRoom(team.name, team.purpose), updatedAt: new Date().toISOString() };
    this.store.save("governance", this.owner, `team:${team.id}`, { ...reopened });
    return reopened;
  }
  /** Removes a team and forgets its tasks, except one whose turn is still running here (its own writes must still land). */
  remove(id: string): { removed: boolean } {
    const removed = this.store.delete("governance", this.owner, `team:${id}`);
    if (removed) this.tasks.forgetTeam(this.owner, id, (taskId) => dispatchHeld(this.store, taskId));
    return { removed };
  }
  /** The room's ordered history: what was asked and what every member answered. */
  room(id: string): Message[] {
    return this.store.messages(this.get(id).roomSessionId);
  }
  /**
   * Sends one task to every member (each with its role and brief) and records the answers in the room,
   * in member order. With a request id, a repeat of the same request never runs the team again: it
   * gets the recorded result, or the task's state while it is running or its outcome is unknown.
   * The source is who is asking (decided by the caller from the signed-in context, never the body).
   */
  async run(runtime: Runtime, knowledge: Knowledge, id: string, prompt: string, request: { requestId?: string | undefined; source?: string } = {}) {
    const team = this.get(id);
    const scope = { owner: this.owner, source: request.source ?? "window" };
    // A request id is a UUID, so the same id in upper or lower case is the same request.
    const requestId = (request.requestId ?? randomUUID()).toLowerCase();
    const task = this.tasks.observe(scope, team.id, requestId, teamRequestFingerprint({ teamId: team.id, prompt, ...team }));
    const claim = task.state === "pending" ? this.tasks.claim(scope, task.taskId) : null;
    if (!claim) return this.observed(scope, task.taskId);
    const turn: TurnProgress = { parentRunId: null, membersStarted: false, recorded: false };
    // While this turn runs, reconcile leaves it alone and nobody can hand it off (Q62, src/team-handoff.ts).
    holdDispatch(this.store, claim.taskId);
    try {
      return await this.dispatch(runtime, knowledge, this.withRoom(team), prompt, claim, turn);
    } catch (error) {
      this.settleThrown(claim, turn, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      releaseDispatch(this.store, claim.taskId);
      // The team was removed while this turn ran (remove keeps a running turn's task): forget it now, answers and all.
      if (!this.store.get("governance", this.owner, `team:${team.id}`)) this.tasks.forgetTeam(this.owner, team.id, (taskId) => dispatchHeld(this.store, taskId));
    }
  }
  /** Settles a claimed task by what the record says it did, for a claimant that is gone (after a restart, say). */
  reconcile(taskId: string, source = "window"): ReconcileReport {
    return reconcileTeamTask(this.store, this.tasks, { owner: this.owner, source }, taskId);
  }
  /**
   * A throw ends the task by how far its turn got. Before the parent run existed, or before its
   * first tool call, nothing was done: failed. Once members started, some may still be working
   * when the throw arrives, so the record cannot prove nothing happened: it needs a person.
   * A recorded result is left for reconcile to finish.
   */
  private settleThrown(claim: TeamTaskClaim, turn: TurnProgress, message: string): void {
    try {
      if (turn.recorded) return;
      if (turn.membersStarted) this.tasks.markNeedsReconciliation(claim, `Stopped while the members were working: ${message}`);
      else settleUnfinished(this.store, this.tasks, claim, turn.parentRunId, message);
    } catch { /* the claim is already gone, so this caller writes nothing */ }
  }
  /** What a caller that did not win the claim sees: the recorded result, or only the task's state. */
  private observed(scope: { owner: string; source: string }, taskId: string) {
    // A claim whose turn is gone (a process that died, or a turn that ended here without settling it)
    // is settled from the record first, never reported as claimed for ever.
    if (this.tasks.orphaned(this.tasks.get(scope, taskId)!, dispatchHeld(this.store, taskId))) reconcileTeamTask(this.store, this.tasks, scope, taskId);
    const task = this.tasks.get(scope, taskId)!;
    const identity = { taskId: task.taskId, requestId: task.requestId, state: task.state };
    // A task whose answers went with a conversation the owner deleted says so, whether it finished or needs a person.
    if (task.state === "completed" || (task.result as { deleted?: unknown } | null)?.deleted) return this.recordedResult(task, identity);
    // A turn that stopped to ask the owner says what it asked, and what it had started so far.
    if (task.state === "waiting_owner")
      return { teamId: task.teamId, ...identity, question: task.question, parentRunId: task.parentRunId, effects: task.parentRunId ? turnEffects(this.store, task.parentRunId) : [] };
    return { teamId: task.teamId, ...identity };
  }
  /** A finished task's recorded result; one too large to keep says so plainly and points at the room, where every answer is. */
  private recordedResult(task: { teamId: string; result: unknown }, identity: { taskId: string; requestId: string; state: string }) {
    const result = task.result as { truncated?: boolean; chars?: number; deleted?: boolean; unwritten?: boolean; roomSessionId?: string } | null;
    if (result?.deleted) return { teamId: task.teamId, ...identity, deleted: true as const,
      note: `The owner deleted a conversation this task's answers were in, so they are gone. ${identity.state === "completed"
        ? "Send a new request id to run it again." : "Check what the team did before sending a new request id."}` };
    if (!result?.truncated) return { ...result, ...identity };
    const room = result.roomSessionId ?? this.list().find((team) => team.id === task.teamId)?.roomSessionId ?? null;
    return { teamId: task.teamId, roomSessionId: room, ...identity, truncated: true as const,
      note: `The answers came to ${result.chars ?? "too many"} characters, too large to keep for a repeat, so they are not replayed here. ${result.unwritten
        ? "They were not written to the team's room either: each member's answer is in its own run."
        : "Every answer is in the team's room."}` };
  }
  private async dispatch(runtime: Runtime, knowledge: Knowledge, team: Team, prompt: string, claim: TeamTaskClaim, turn: TurnProgress) {
    // The claim must still be this caller's before the runtime is asked for anything; if it moved, only observe.
    if (!this.tasks.held(claim)) return this.observed(claim.scope, claim.taskId);
    const parent = await this.startParent(runtime, team, prompt, claim, turn);
    if (parent.status !== "completed") return this.stopBeforeMembers(claim, parent);
    const context = runtime.context({ runId: parent.id });
    this.store.message(team.roomSessionId, { role: "user", content: prompt });
    const tasks = team.members.map((member, index) => ({ id: `m${index}`, prompt: `Your role in team "${team.name}": ${member.role}. ${member.brief}\n\nTask: ${prompt}`, dependsOn: [] as string[] }));
    const specs = new Map(team.members.map((member, index) => [`m${index}`, { ...knowledge.activeSpecialist(this.owner, member.specialistId), agent: member.specialistId }]));
    // Written on the team's own run before any member starts, so reconcile knows members were sent even if their conversations are deleted.
    this.store.event(parent.id, membersSentKind, { members: tasks.length });
    turn.membersStarted = true;
    const outcome = await runtime.fanout(context, tasks, (taskId) => specs.get(taskId)!);
    const answers = team.members.map((member, index) => ({ specialistId: member.specialistId, role: member.role, ...outcome.tasks[`m${index}`]! }));
    const result: TeamRunResult = { teamId: team.id, parentRunId: parent.id, roomSessionId: team.roomSessionId, answers };
    // A conversation the answers go to or came from was deleted while the members worked: nothing is kept or written.
    if (answersDeletedBeforeRecord(this.store, this.tasks, claim, result)) return this.observed(claim.scope, claim.taskId);
    // Kept on the task first, so a crash before the finish below can still be finished from it without running anything.
    this.tasks.recordOutcome(claim, result);
    turn.recorded = true;
    // The finished task and the room's answers are written together, or not at all. If the owner
    // deleted the room while the members worked, the task is settled for a person instead.
    if (!finishLiveTurn(this.store, this.tasks, claim, result)) return this.observed(claim.scope, claim.taskId);
    return { ...result, taskId: claim.taskId, requestId: this.tasks.get(claim.scope, claim.taskId)!.requestId, state: "completed" as const };
  }
  /**
   * Starts the parent run. First the task names a new conversation for it (a fenced write, so a
   * claim that moved stops here), and only then is the run created in that conversation. The
   * runtime saves the transcript, runs its start hooks and records "run.started" before it calls
   * onStarted, so a crash in between leaves an interrupted run the task has not named yet; the
   * conversation marks it as a team turn, and recovery after a restart does not carry such a run on
   * (unlinkedTeamParent, src/never-break/resume.ts). onStarted names the run before its first model
   * call; if that write is refused (the claim went stale), the runtime ends the run there.
   */
  private async startParent(runtime: Runtime, team: Team, prompt: string, claim: TeamTaskClaim, turn: TurnProgress): Promise<Run> {
    const sessionId = this.store.createSession(this.owner);
    this.tasks.linkParentSession(claim, sessionId);
    const parent = await runtime.run({ prompt: `Team ${team.name}: ${prompt}`, sessionId, onStarted: (run) => {
      this.tasks.linkParentRun(claim, run.id);
      turn.parentRunId = run.id;
    } });
    if (turn.parentRunId !== parent.id) throw new StaleTeamTaskClaimError("The team's run could not be linked to this task, so it was stopped before it did anything.");
    return parent;
  }
  /** The parent turn did not complete, so the members are not started; the task ends by what the turn did. */
  private stopBeforeMembers(claim: TeamTaskClaim, parent: Run) {
    const why = `the team's own turn ended ${parent.status}: ${parent.output.slice(0, 500)}`;
    // A turn that stopped to ask the owner is a known outcome: the task waits, and the members are not started.
    if (parent.status === "needs_input") settleWaiting(this.store, this.tasks, claim, parent.id, parent.output);
    else if (runStopped(parent.status)) settleUnfinished(this.store, this.tasks, claim, parent.id, why);
    else this.tasks.markNeedsReconciliation(claim, why);
    return { ...this.observed(claim.scope, claim.taskId), parentRunId: parent.id };
  }
}

/** How far a team turn got, so a throw can be settled honestly. */
interface TurnProgress { parentRunId: string | null; membersStarted: boolean; recorded: boolean }

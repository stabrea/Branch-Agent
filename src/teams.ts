import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { Message, Run } from "./contracts.js";
import { StaleTeamTaskClaimError, TeamTasks, teamRequestFingerprint, type TeamTaskClaim } from "./team-tasks.js";
import { finishTeamTask, holdDispatch, reconcileTeamTask, releaseDispatch, runStopped, settleUnfinished, settleWaiting, turnEffects, type ReconcileReport, type TeamRunResult } from "./team-reconcile.js";

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
    const room = existing?.roomSessionId ?? this.store.createRun(this.owner, `Team room: ${value.name}`).sessionId;
    if (!existing) this.store.finish(this.store.runs(this.owner).find((r) => r.sessionId === room)!.id, "completed", "Room opened");
    const team: Team = { id: value.id ?? randomUUID(), name: value.name, purpose: value.purpose, members: value.members, roomSessionId: room, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.store.save("governance", this.owner, `team:${team.id}`, { ...team });
    if (!existing) this.store.message(room, { role: "system", content: `Team "${team.name}" room. ${team.purpose}`.trim() });
    return team;
  }
  remove(id: string): { removed: boolean } {
    return { removed: this.store.delete("governance", this.owner, `team:${id}`) };
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
    const requestId = request.requestId ?? randomUUID();
    const task = this.tasks.observe(scope, team.id, requestId, teamRequestFingerprint({ teamId: team.id, prompt, ...team }));
    const claim = task.state === "pending" ? this.tasks.claim(scope, task.taskId) : null;
    if (!claim) return this.observed(scope, task.taskId);
    const turn: TurnProgress = { parentRunId: null, membersStarted: false, recorded: false };
    holdDispatch(this.store, claim.taskId);
    try {
      return await this.dispatch(runtime, knowledge, team, prompt, claim, turn);
    } catch (error) {
      this.settleThrown(claim, turn, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      releaseDispatch(this.store, claim.taskId);
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
    const task = this.tasks.get(scope, taskId)!;
    const identity = { taskId: task.taskId, requestId: task.requestId, state: task.state };
    if (task.state === "completed") return { ...(task.result as object), ...identity };
    // A turn that stopped to ask the owner says what it asked, and what it had started so far.
    if (task.state === "waiting_owner")
      return { teamId: task.teamId, ...identity, question: task.question, parentRunId: task.parentRunId, effects: task.parentRunId ? turnEffects(this.store, task.parentRunId) : [] };
    return { teamId: task.teamId, ...identity };
  }
  private async dispatch(runtime: Runtime, knowledge: Knowledge, team: Team, prompt: string, claim: TeamTaskClaim, turn: TurnProgress) {
    const parent = await this.startParent(runtime, team, prompt, claim, turn);
    if (parent.status !== "completed") return this.stopBeforeMembers(claim, parent);
    const context = runtime.context({ runId: parent.id });
    this.store.message(team.roomSessionId, { role: "user", content: prompt });
    const tasks = team.members.map((member, index) => ({ id: `m${index}`, prompt: `Your role in team "${team.name}": ${member.role}. ${member.brief}\n\nTask: ${prompt}`, dependsOn: [] as string[] }));
    const specs = new Map(team.members.map((member, index) => [`m${index}`, { ...knowledge.activeSpecialist(this.owner, member.specialistId), agent: member.specialistId }]));
    turn.membersStarted = true;
    const outcome = await runtime.fanout(context, tasks, (taskId) => specs.get(taskId)!);
    const answers = team.members.map((member, index) => ({ specialistId: member.specialistId, role: member.role, ...outcome.tasks[`m${index}`]! }));
    const result: TeamRunResult = { teamId: team.id, parentRunId: parent.id, roomSessionId: team.roomSessionId, answers };
    // Kept on the task first, so a crash before the finish below can still be finished from it without running anything.
    this.tasks.recordOutcome(claim, result);
    turn.recorded = true;
    // The finished task and the room's answers are written together, or not at all.
    finishTeamTask(this.store, this.tasks, claim, result);
    return { ...result, taskId: claim.taskId, requestId: this.tasks.get(claim.scope, claim.taskId)!.requestId, state: "completed" as const };
  }
  /**
   * Starts the parent run. The runtime calls onStarted after it has created the run and just before
   * its first model call, so the task names its run before the run can do anything. If that write
   * is refused (the claim went stale), the runtime ends the run there and nothing is written here.
   */
  private async startParent(runtime: Runtime, team: Team, prompt: string, claim: TeamTaskClaim, turn: TurnProgress): Promise<Run> {
    const parent = await runtime.run({ prompt: `Team ${team.name}: ${prompt}`, onStarted: (run) => {
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

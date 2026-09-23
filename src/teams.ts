import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { Message } from "./contracts.js";
import { TeamTasks, teamRequestFingerprint, type TeamTaskClaim } from "./team-tasks.js";
import { beginTeamTurn } from "./team-handoff.js";

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
    // Q62: while this turn runs, nobody can offer the task away or accept an offer for it.
    const turnEnded = beginTeamTurn(this.store, claim.taskId);
    try {
      return await this.dispatch(runtime, knowledge, team, prompt, claim);
    } catch (error) {
      // The run may have done things before it threw, so the task is left uncertain and never replayed.
      try { this.tasks.markUncertain(claim, error instanceof Error ? error.message : String(error)); } catch { /* the claim is already gone */ }
      throw error;
    } finally {
      turnEnded();
    }
  }
  /** What a caller that did not win the claim sees: the recorded result, or only the task's state. */
  private observed(scope: { owner: string; source: string }, taskId: string) {
    const task = this.tasks.get(scope, taskId)!;
    const identity = { taskId: task.taskId, requestId: task.requestId, state: task.state };
    return task.state === "completed" ? { ...(task.result as object), ...identity } : { teamId: task.teamId, ...identity };
  }
  private async dispatch(runtime: Runtime, knowledge: Knowledge, team: Team, prompt: string, claim: TeamTaskClaim) {
    const parent = await runtime.run({ prompt: `Team ${team.name}: ${prompt}` });
    this.tasks.linkParentRun(claim, parent.id);
    const context = runtime.context({ runId: parent.id });
    this.store.message(team.roomSessionId, { role: "user", content: prompt });
    const tasks = team.members.map((member, index) => ({ id: `m${index}`, prompt: `Your role in team "${team.name}": ${member.role}. ${member.brief}\n\nTask: ${prompt}`, dependsOn: [] as string[] }));
    const specs = new Map(team.members.map((member, index) => [`m${index}`, { ...knowledge.activeSpecialist(this.owner, member.specialistId), agent: member.specialistId }]));
    const outcome = await runtime.fanout(context, tasks, (taskId) => specs.get(taskId)!);
    const answers = team.members.map((member, index) => ({ specialistId: member.specialistId, role: member.role, ...outcome.tasks[`m${index}`]! }));
    const result = { teamId: team.id, parentRunId: parent.id, roomSessionId: team.roomSessionId, answers };
    // The finished task and the room's answers are written together, or not at all.
    // Listeners hear about the event only after the commit, so none can see or break a half-written task.
    let announce = () => {};
    this.tasks.complete(claim, result, () => {
      for (const answer of answers) this.store.message(team.roomSessionId, { role: "assistant", content: `[${answer.role}] ${answer.output || `(no answer: ${answer.status})`}` });
      announce = this.store.eventUnannounced(parent.id, "team.ran", { teamId: team.id, roomSessionId: team.roomSessionId, answers: answers.map((a) => ({ role: a.role, status: a.status, runId: a.runId })) });
    });
    announce();
    return { ...result, taskId: claim.taskId, requestId: this.tasks.get(claim.scope, claim.taskId)!.requestId, state: "completed" as const };
  }
}

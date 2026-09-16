import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { Message } from "./contracts.js";

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
  constructor(private readonly store: Store, private readonly owner: string) {}
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
  /** Sends one task to every member (each with its role and brief) and records the answers in the room, in member order. */
  async run(runtime: Runtime, knowledge: Knowledge, id: string, prompt: string) {
    const team = this.get(id);
    const parent = await runtime.run({ prompt: `Team ${team.name}: ${prompt}` });
    const context = runtime.context({ runId: parent.id });
    this.store.message(team.roomSessionId, { role: "user", content: prompt });
    const tasks = team.members.map((member, index) => ({ id: `m${index}`, prompt: `Your role in team "${team.name}": ${member.role}. ${member.brief}\n\nTask: ${prompt}`, dependsOn: [] as string[] }));
    const specs = new Map(team.members.map((member, index) => [`m${index}`, { ...knowledge.activeSpecialist(this.owner, member.specialistId), agent: member.specialistId }]));
    const outcome = await runtime.fanout(context, tasks, (taskId) => specs.get(taskId)!);
    const answers = team.members.map((member, index) => ({ specialistId: member.specialistId, role: member.role, ...outcome.tasks[`m${index}`]! }));
    for (const answer of answers) this.store.message(team.roomSessionId, { role: "assistant", content: `[${answer.role}] ${answer.output || `(no answer: ${answer.status})`}` });
    this.store.event(parent.id, "team.ran", { teamId: team.id, roomSessionId: team.roomSessionId, answers: answers.map((a) => ({ role: a.role, status: a.status, runId: a.runId })) });
    return { teamId: team.id, parentRunId: parent.id, roomSessionId: team.roomSessionId, answers };
  }
}

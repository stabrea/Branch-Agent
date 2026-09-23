import { z } from "zod";
import { errorText, type ToolContext } from "../contracts.js";
import type { RemoteAgents } from "../a2a-client.js";
import type { Knowledge } from "../knowledge.js";
import { pooled, runParallel } from "../orchestration-tools.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import type { Teams } from "../teams.js";
import type { ClientToolHub } from "./client-tools.js";
import { requireInterop } from "./settings.js";

/**
 * Looking after several assistants at once: one picture of everything that is working — tasks and
 * the sub-tasks under them, the teams, the assistants elsewhere this one may ask, and the programs
 * lending tools — and three fleet commands: what is going on, send one job to several of them at
 * once, and stop a whole group. Everything goes through the doors that already exist (the fan-out
 * engine, the A2A client, the ordinary Stop), so the same budget, rules and record apply.
 *
 * The idea is from CodeWhale's fleet commands; this is an independent implementation.
 */
export interface FleetParts {
  runtime: Runtime; knowledge: Knowledge; teams: Teams; remoteAgents: RemoteAgents; clients: ClientToolHub;
}

export interface FleetTask { runId: string; prompt: string; startedAt: string; parentRunId: string | null }

/** Every task still working, each with the task that started it when there is one. */
export function workingTasks(runtime: Runtime): FleetTask[] {
  return runtime.store.runs(runtime.owner).filter((run) => run.status === "running").map((run) => {
    const started = runtime.store.events(run.id).find((event) => event.kind === "run.started");
    const parent = started?.data.parentRunId;
    return { runId: run.id, prompt: run.prompt.slice(0, 120), startedAt: run.createdAt,
      parentRunId: typeof parent === "string" ? parent : null };
  });
}

export function fleetStatus(parts: FleetParts) {
  const working = workingTasks(parts.runtime);
  return {
    working,
    teams: parts.teams.list().map((team) => ({ id: team.id, name: team.name, members: team.members.length })),
    elsewhere: parts.remoteAgents.list().map((agent) => ({ name: agent.name, skills: agent.skills.length })),
    programs: parts.clients.list(),
    summary: `${working.length} task${working.length === 1 ? "" : "s"} working, ${parts.teams.list().length} team(s), ${parts.remoteAgents.list().length} assistant(s) elsewhere, ${parts.clients.list().length} program(s) lending tools.`,
  };
}

export const SendSchema = z.object({
  job: z.string().trim().min(1).max(8000),
  /** Specialists on this computer, by id. */
  specialists: z.array(z.string().min(1).max(200)).max(6).default([]),
  /** Assistants elsewhere, by name or id. */
  elsewhere: z.array(z.string().min(1).max(200)).max(6).default([]),
}).strict().refine((v) => v.specialists.length + v.elsewhere.length > 0, "Name at least one specialist or assistant");

/** One job to several at once: specialists here share this task's budget, assistants elsewhere are asked in turn. */
export async function fleetSend(parts: FleetParts, context: ToolContext, input: z.input<typeof SendSchema>) {
  const { job, specialists, elsewhere } = SendSchema.parse(input);
  const here = specialists.length
    ? (await runParallel(parts.runtime, parts.knowledge, context, { tasks: specialists.map((specialist) => ({ specialist, prompt: job })) })).branches
    : [];
  const away = await pooled(elsewhere, 3, async (agent) => {
    try {
      const answer = await parts.remoteAgents.ask({ agent, task: job }, context.signal, context.runId);
      return { agent: answer.agent, status: answer.state, output: answer.answer.slice(0, 4000) };
    } catch (error) { return { agent, status: "failed", output: "", error: errorText(error) }; }
  });
  if (context.runId)
    parts.runtime.store.event(context.runId, "fleet.sent", { label: `Sent one job to ${specialists.length + elsewhere.length}`, specialists, elsewhere });
  return { here, elsewhere: away, combine: "Put these answers together for the person, and say where one failed or two disagree." };
}

export const StopSchema = z.object({
  /** "everything" stops every working task but this one; "under" stops the sub-tasks of one task. */
  scope: z.enum(["everything", "under"]),
  runId: z.string().uuid().optional(),
}).strict();

/** Stops a group of tasks with the ordinary Stop, never the task asking. */
export function fleetStop(runtime: Runtime, input: z.input<typeof StopSchema>, self = ""): { stopped: string[] } {
  const { scope, runId } = StopSchema.parse(input);
  if (scope === "under" && !runId) throw new Error("Say which task's sub-tasks to stop");
  const working = workingTasks(runtime);
  const under = (id: string): string[] => working.filter((t) => t.parentRunId === id).flatMap((t) => [t.runId, ...under(t.runId)]);
  const targets = scope === "everything" ? working.map((t) => t.runId) : under(runId!);
  // The task asking, and every task above it, are left running: stopping them would stop the asker.
  const spared = new Set<string>();
  for (let at: string | null | undefined = self; at && !spared.has(at); at = working.find((t) => t.runId === at)?.parentRunId) spared.add(at);
  const stopped = targets.filter((id) => !spared.has(id) && runtime.cancel(id));
  return { stopped };
}

export function registerFleetTools(registry: ToolRegistry, parts: FleetParts): void {
  const store = parts.runtime.store;
  registry.register({
    name: "fleet.status", group: "agents", permission: "specialists.read",
    description: "Everything working now: tasks and sub-tasks, teams, assistants elsewhere, programs lending tools.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => { requireInterop(store, context.owner, "fleet"); return fleetStatus(parts); },
  });
  registry.register({
    name: "fleet.send", reach: "outbound", group: "agents", permission: "specialists.use",
    description: "Send one job to several specialists and assistants elsewhere at once, and get every answer back.",
    parameters: z.object({
      job: z.string().trim().min(1).max(8000),
      specialists: z.array(z.string().min(1).max(200)).max(6).default([]),
      elsewhere: z.array(z.string().min(1).max(200)).max(6).default([]),
    }).strict(),
    execute: async (args, context) => { requireInterop(store, context.owner, "fleet"); return fleetSend(parts, context, args); },
  });
  registry.register({
    name: "fleet.stop", group: "agents", permission: "specialists.manage",
    description: "Stop every working task, or every sub-task under one task.",
    parameters: StopSchema,
    execute: async (args, context) => { requireInterop(store, context.owner, "fleet"); return fleetStop(parts.runtime, args, context.runId); },
  });
}

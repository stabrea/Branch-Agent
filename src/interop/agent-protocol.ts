import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RateLimiter } from "../approvals.js";
import type { Run } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import type { Store } from "../store.js";
import { requireInterop } from "./settings.js";

/**
 * The Agent Protocol (agentprotocol.ai, v1): the plain task-and-step HTTP API that many agent
 * benchmarks and harnesses speak. A caller creates a task, then asks for steps; each step is an
 * ordinary Branch task in one conversation, so it shows in Activity with the same record, and it is
 * held to the rules for work the owner did not start ("Ask before changes"), exactly like A2A.
 *
 * Only written words cross: every answer is offered back as a small text artifact, and a file sent
 * in is refused rather than unpacked. Tasks and steps are written down, so a restart keeps them.
 * Implemented from the published specification; no code was taken from any other project.
 */
export const apPrefix = "/ap/v1/agent/tasks";
const maxTasks = 200;
const maxStepsPerTask = 50;

export const TaskRequestSchema = z.object({
  input: z.string().max(16000).nullish(),
  additional_input: z.record(z.string(), z.unknown()).nullish(),
}).strict();

export interface ApStep {
  task_id: string; step_id: string; name: string; status: "created" | "running" | "completed";
  input: string; additional_input: Record<string, unknown>; output: string;
  additional_output: { state: string; runId: string }; artifacts: ApArtifact[]; is_last: boolean;
  created_at: string; modified_at: string;
}
export interface ApArtifact { artifact_id: string; file_name: string; relative_path: string; agent_created: boolean; created_at: string }
interface ApTask {
  task_id: string; input: string; additional_input: Record<string, unknown>; created_at: string; modified_at: string;
  artifacts: ApArtifact[]; sessionId: string; caller: string; steps: ApStep[];
}

export class ApError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const now = (): string => new Date().toISOString();
const recordId = (taskId: string): string => `ap-task:${taskId}`;

/** A page of a list the way the specification shapes it. */
export function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; pagination: Record<string, number> } {
  const size = Math.min(100, Math.max(1, Number(query.get("page_size")) || 10));
  const page = Math.max(1, Number(query.get("current_page")) || 1);
  return {
    items: items.slice((page - 1) * size, page * size),
    pagination: { total_items: items.length, total_pages: Math.max(1, Math.ceil(items.length / size)), current_page: page, page_size: size },
  };
}

export class AgentProtocol {
  private readonly rates = new RateLimiter();
  constructor(private readonly store: Store, private readonly runtime: Runtime,
    private readonly options = { stepsPerMinute: 20, stepTimeoutMs: 120000 }) {}

  private get owner(): string { return this.runtime.owner; }
  private load(taskId: string): ApTask {
    const saved = this.store.get("governance", this.owner, recordId(taskId))?.data as unknown as ApTask | undefined;
    if (!saved) throw new ApError(404, `Task ${taskId} is not known to this assistant`);
    return saved;
  }
  private keep(task: ApTask): void {
    this.store.save("governance", this.owner, recordId(task.task_id), { ...task });
  }
  private all(): ApTask[] {
    return this.store.list("governance", this.owner).filter((row) => row.id.startsWith("ap-task:"))
      .map((row) => row.data as unknown as ApTask).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  /** What a caller sees of a task: never the conversation id or who else called. */
  private view(task: ApTask) {
    const { sessionId: _session, caller: _caller, steps: _steps, ...shown } = task;
    return shown;
  }

  create(input: unknown, caller: string) {
    requireInterop(this.store, this.owner, "agent-protocol");
    const body = TaskRequestSchema.parse(input ?? {});
    const stamp = now();
    const task: ApTask = {
      task_id: randomUUID(), input: body.input ?? "", additional_input: body.additional_input ?? {},
      created_at: stamp, modified_at: stamp, artifacts: [], sessionId: "", caller, steps: [],
    };
    this.keep(task);
    // Only the newest tasks are kept, so a harness running thousands of them does not fill the disk.
    for (const old of this.all().slice(maxTasks)) this.store.delete("governance", this.owner, recordId(old.task_id));
    return this.view(task);
  }
  list(query: URLSearchParams) {
    requireInterop(this.store, this.owner, "agent-protocol");
    const page = paginate(this.all().map((task) => this.view(task)), query);
    return { tasks: page.items, pagination: page.pagination };
  }
  get(taskId: string) {
    requireInterop(this.store, this.owner, "agent-protocol");
    return this.view(this.load(taskId));
  }
  steps(taskId: string, query: URLSearchParams) {
    requireInterop(this.store, this.owner, "agent-protocol");
    const page = paginate(this.load(taskId).steps, query);
    return { steps: page.items, pagination: page.pagination };
  }
  step(taskId: string, stepId: string): ApStep {
    requireInterop(this.store, this.owner, "agent-protocol");
    const step = this.load(taskId).steps.find((s) => s.step_id === stepId);
    if (!step) throw new ApError(404, `Step ${stepId} is not part of task ${taskId}`);
    return step;
  }
  artifacts(taskId: string, query: URLSearchParams) {
    requireInterop(this.store, this.owner, "agent-protocol");
    const page = paginate(this.load(taskId).artifacts, query);
    return { artifacts: page.items, pagination: page.pagination };
  }
  /** One answer, as the text file the artifact list names. */
  artifact(taskId: string, artifactId: string): { name: string; text: string } {
    requireInterop(this.store, this.owner, "agent-protocol");
    const task = this.load(taskId);
    const step = task.steps.find((s) => s.artifacts.some((a) => a.artifact_id === artifactId));
    const file = step?.artifacts.find((a) => a.artifact_id === artifactId);
    if (!step || !file) throw new ApError(404, `Artifact ${artifactId} is not part of task ${taskId}`);
    return { name: file.file_name, text: step.output };
  }

  /** Runs one step to the end and answers with it. The caller waits, as the specification expects. */
  async execute(taskId: string, input: unknown, caller: string): Promise<ApStep> {
    requireInterop(this.store, this.owner, "agent-protocol");
    const body = TaskRequestSchema.parse(input ?? {});
    const task = this.load(taskId);
    if (task.steps.length >= maxStepsPerTask) throw new ApError(429, `A task may have at most ${maxStepsPerTask} steps`);
    const prompt = (body.input ?? "").trim() || (task.steps.length === 0 ? task.input.trim() : "");
    if (!prompt) throw new ApError(400, "The step has no input, and the task's own input was already used");
    if (this.rates.waitMs(caller, this.options.stepsPerMinute) > 0)
      throw new ApError(429, `Too many steps: ${caller} may ask for ${this.options.stepsPerMinute} a minute.`);
    this.rates.record(caller);
    const run = await this.runStep(task, prompt, caller);
    return this.recordStep(task, run, prompt, body.additional_input ?? {});
  }

  private async runStep(task: ApTask, prompt: string, caller: string): Promise<Run> {
    const sessionId = task.sessionId && this.store.ownsSession(this.owner, task.sessionId) ? task.sessionId : undefined;
    return this.runtime.run({
      prompt, source: "a2a", ...(sessionId ? { sessionId } : {}),
      signal: AbortSignal.timeout(this.options.stepTimeoutMs),
      onStarted: (started) => this.store.event(started.id, "a2a.task", {
        taskId: task.task_id, agent: caller, source: "agent-protocol",
        label: `${caller} asked over the Agent Protocol: ${prompt.slice(0, 80)}`,
      }),
    });
  }

  private recordStep(task: ApTask, run: Run, prompt: string, extra: Record<string, unknown>): ApStep {
    const stamp = now(), stepId = randomUUID();
    const state = run.status === "completed" ? "completed" : run.status === "needs_input" ? "input-required" : "failed";
    const artifacts: ApArtifact[] = run.output
      ? [{ artifact_id: randomUUID(), file_name: `answer-${task.steps.length + 1}.md`, relative_path: "", agent_created: true, created_at: stamp }]
      : [];
    const step: ApStep = {
      task_id: task.task_id, step_id: stepId, name: `Step ${task.steps.length + 1}`, status: "completed",
      input: prompt, additional_input: extra, output: run.output,
      additional_output: { state, runId: run.id }, artifacts,
      // A step that stopped to ask the owner something is not the last one: the caller may try again.
      is_last: state !== "input-required", created_at: stamp, modified_at: stamp,
    };
    const updated: ApTask = { ...task, sessionId: run.sessionId, modified_at: stamp,
      steps: [...task.steps, step], artifacts: [...task.artifacts, ...artifacts] };
    this.keep(updated);
    return step;
  }
}

/** Which route of the specification a path is, or null when it is not one. */
export function apRoute(method: string, path: string): { name: string; taskId?: string; subId?: string } | null {
  if (path === apPrefix) return method === "POST" ? { name: "create" } : method === "GET" ? { name: "list" } : null;
  const match = /^\/ap\/v1\/agent\/tasks\/([a-f0-9-]{36})(?:\/(steps|artifacts)(?:\/([a-f0-9-]{36}))?)?$/.exec(path);
  if (!match) return null;
  const [, taskId, kind, subId] = match;
  if (!kind) return method === "GET" ? { name: "get", taskId: taskId! } : null;
  if (kind === "steps") {
    if (subId) return method === "GET" ? { name: "step", taskId: taskId!, subId } : null;
    return method === "POST" ? { name: "execute", taskId: taskId! } : method === "GET" ? { name: "steps", taskId: taskId! } : null;
  }
  if (subId) return method === "GET" ? { name: "artifact", taskId: taskId!, subId } : null;
  return method === "POST" ? { name: "upload", taskId: taskId! } : method === "GET" ? { name: "artifacts", taskId: taskId! } : null;
}

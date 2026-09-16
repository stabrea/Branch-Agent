import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { ToolRegistry } from "./registry.js";
import { errorText } from "./contracts.js";

/**
 * A workflow is a saved list of steps the app works through on its own: ask the assistant, replay a
 * saved procedure, use one tool, wait for the owner to approve, wait until a time, or look at what
 * the last step said and skip ahead. Every step's state is written down as it happens, so closing
 * the app in the middle loses nothing: the workflow picks up where it stopped.
 */
export const stepKinds = ["prompt", "recipe", "tool", "approval", "wait", "branch"] as const;
export const WorkflowStepSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(stepKinds),
  prompt: z.string().trim().max(8000).optional(),
  recipeId: z.string().uuid().optional(),
  inputs: z.record(z.string().max(40), z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
  tool: z.string().min(1).max(100).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  question: z.string().trim().max(500).optional(),
  /** For a wait step: how long after the workflow reaches it before it may go on. */
  waitMinutes: z.number().int().min(0).max(43200).optional(),
  /** For a branch step: the words the previous answer must contain to carry straight on. */
  contains: z.string().trim().min(1).max(200).optional(),
  /** How many steps to jump over when the branch's words are missing. */
  skipAhead: z.number().int().min(1).max(20).optional(),
  retries: z.number().int().min(0).max(5).default(0),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).strict().superRefine((step, context) => {
  const needs: Record<string, keyof typeof step> = { prompt: "prompt", recipe: "recipeId", tool: "tool", branch: "contains" };
  const required = needs[step.kind];
  if (required && step[required] === undefined)
    context.addIssue({ code: "custom", message: `A ${step.kind} step needs a ${String(required)}` });
});
export const WorkflowSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  steps: z.array(WorkflowStepSchema).min(1).max(20),
}).strict();
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type WorkflowStatus = "idle" | "running" | "paused" | "waiting_approval" | "waiting_time" | "completed" | "failed" | "interrupted";
export interface StepState {
  index: number; name: string; kind: string; status: string; attempts: number;
  output: string; runId: string | null; startedAt: string | null; updatedAt: string;
}
export interface WorkflowView {
  id: string; name: string; description: string; steps: WorkflowStep[];
  status: WorkflowStatus; cursor: number; waitingUntil: string | null;
  question: string | null; error: string | null; state: StepState[];
  /** What it was doing when it was stopped, so carrying it on picks the same thread back up. */
  pausedFrom: WorkflowStatus | null;
}

/** The example that ships with the app: look back at the week, write it up, keep it, send it on. */
export function weeklyReviewWorkflow(deliverTo?: { channel: string; chatId: string }): WorkflowDefinition {
  return WorkflowSchema.parse({
    name: "Weekly review",
    description: "Every week: gather what finished, write a short review, keep it in memory and send it on.",
    steps: [
      { name: "Collect finished tasks", kind: "prompt", prompt: "List the tasks that finished in the last seven days, with one line each on what came of them. If there were none, say so plainly." },
      { name: "Write the review", kind: "prompt", prompt: "From that list, write a short weekly review: what got done, what is still open, and one thing worth attention next week. Keep it under 200 words." },
      { name: "Keep it", kind: "tool", tool: "memory.put", args: { text: "Weekly review written", source: "Weekly review workflow" } },
      ...(deliverTo ? [{ name: "Send it on", kind: "prompt" as const, prompt: `Send the weekly review to ${deliverTo.channel} chat ${deliverTo.chatId}.` }] : []),
    ],
  });
}

export class Workflows {
  constructor(
    private readonly store: Store,
    private readonly runtime: Runtime,
    private readonly knowledge?: Knowledge,
  ) {
    this.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS workflow_state(workflow_id TEXT NOT NULL,
      owner TEXT NOT NULL, step_index INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT '',
      run_id TEXT, started_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(workflow_id, step_index))`);
  }
  create(owner: string, input: unknown): WorkflowView {
    const definition = WorkflowSchema.parse(input);
    const id = definition.id ?? randomUUID();
    const existing = this.store.get("workflows", owner, id)?.data;
    this.store.save("workflows", owner, id, {
      ...definition, id, status: existing?.status ?? "idle", cursor: Number(existing?.cursor ?? 0),
      waitingUntil: existing?.waitingUntil ?? null, question: null, error: null,
    });
    return this.view(owner, id);
  }
  list(owner: string): WorkflowView[] {
    return this.store.list("workflows", owner).map((record) => this.toView(owner, record));
  }
  view(owner: string, id: string): WorkflowView {
    const record = this.store.get("workflows", owner, id);
    if (!record) throw new Error("Workflow not found");
    return this.toView(owner, record);
  }
  remove(owner: string, id: string): { removed: boolean } {
    this.store.sqlite.prepare("DELETE FROM workflow_state WHERE owner=? AND workflow_id=?").run(owner, id);
    return { removed: this.store.delete("workflows", owner, id) };
  }
  private toView(owner: string, record: SavedRecord): WorkflowView {
    const data = record.data as unknown as WorkflowDefinition & Omit<WorkflowView, "id" | "name" | "description" | "steps" | "state">;
    return { id: record.id, name: data.name, description: data.description, steps: data.steps,
      status: data.status ?? "idle", cursor: Number(data.cursor ?? 0), waitingUntil: data.waitingUntil ?? null,
      question: data.question ?? null, error: data.error ?? null, pausedFrom: data.pausedFrom ?? null,
      state: this.stepStates(owner, record.id) };
  }
  stepStates(owner: string, id: string): StepState[] {
    return this.store.sqlite.prepare("SELECT * FROM workflow_state WHERE owner=? AND workflow_id=? ORDER BY step_index")
      .all(owner, id).map((row) => ({ index: Number(row.step_index), name: String(row.name), kind: String(row.kind),
        status: String(row.status), attempts: Number(row.attempts), output: String(row.output),
        runId: row.run_id === null ? null : String(row.run_id),
        startedAt: row.started_at === null ? null : String(row.started_at), updatedAt: String(row.updated_at) }));
  }
  private writeStep(owner: string, id: string, index: number, step: WorkflowStep, patch: Partial<StepState>): void {
    const now = new Date().toISOString();
    this.store.sqlite.prepare(`INSERT INTO workflow_state VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workflow_id,step_index) DO UPDATE SET status=excluded.status, attempts=excluded.attempts,
      output=excluded.output, run_id=excluded.run_id, updated_at=excluded.updated_at`)
      .run(id, owner, index, step.name, step.kind, patch.status ?? "running", patch.attempts ?? 0,
        (patch.output ?? "").slice(0, 4000), patch.runId ?? null, patch.startedAt ?? now, now);
  }
  private setStatus(owner: string, id: string, patch: Record<string, unknown>): WorkflowView {
    const record = this.store.get("workflows", owner, id);
    if (!record) throw new Error("Workflow not found");
    this.store.save("workflows", owner, id, { ...record.data, ...patch });
    return this.view(owner, id);
  }
  /** Stops a workflow between steps; what has finished stays finished. */
  pause(owner: string, id: string): WorkflowView {
    const current = this.view(owner, id);
    if (["completed", "failed"].includes(current.status)) throw new Error("That workflow has already finished");
    return this.setStatus(owner, id, { status: "paused", pausedFrom: current.status });
  }
  /** Carries on from where it stopped; on an approval step this is the owner saying yes. */
  async resume(owner: string, id: string): Promise<WorkflowView> {
    const current = this.view(owner, id);
    if (current.status === "running") throw new Error("That workflow is working right now");
    if (current.status === "completed") throw new Error("That workflow has already finished");
    const waitingForYes = current.status === "waiting_approval"
      || (current.status === "paused" && current.pausedFrom === "waiting_approval");
    if (waitingForYes) {
      const step = current.steps[current.cursor];
      if (step) this.writeStep(owner, id, current.cursor, step, { status: "approved", attempts: 1, output: "Approved by the owner" });
      this.setStatus(owner, id, { cursor: current.cursor + 1, question: null, pausedFrom: null });
    }
    return this.run(owner, id);
  }
  /** Works through the steps until one needs the owner, a time to pass, or everything is done. */
  async run(owner: string, id: string): Promise<WorkflowView> {
    let current = this.view(owner, id);
    if (current.status === "running") throw new Error("That workflow is working right now");
    const fresh = ["idle", "completed", "failed"].includes(current.status);
    current = this.setStatus(owner, id, { status: "running", error: null, question: null, pausedFrom: null, ...(fresh ? { cursor: 0 } : {}) });
    for (let index = current.cursor; index < current.steps.length; index++) {
      const step = current.steps[index]!;
      const outcome = await this.step(owner, id, index, step, current);
      if (outcome.halt) return this.setStatus(owner, id, { cursor: outcome.cursor ?? index, ...outcome.patch });
      // Take the saved view back, so a later step sees what the last one wrote (a wait's moment).
      current = this.setStatus(owner, id, { cursor: outcome.cursor ?? index + 1, ...outcome.patch });
      index = current.cursor - 1;
    }
    return this.setStatus(owner, id, { status: "completed", cursor: current.steps.length, waitingUntil: null });
  }
  private async step(owner: string, id: string, index: number, step: WorkflowStep, view: WorkflowView):
    Promise<{ halt: boolean; cursor?: number; patch?: Record<string, unknown> }> {
    if (step.kind === "approval") {
      this.writeStep(owner, id, index, step, { status: "waiting", attempts: 0, output: step.question ?? "" });
      return { halt: true, cursor: index, patch: { status: "waiting_approval", question: step.question ?? `Approve "${step.name}"?` } };
    }
    if (step.kind === "wait") {
      const until = view.waitingUntil ?? new Date(Date.now() + (step.waitMinutes ?? 0) * 60000).toISOString();
      if (until > new Date().toISOString()) {
        this.writeStep(owner, id, index, step, { status: "waiting", attempts: 0, output: `Waiting until ${until}` });
        return { halt: true, cursor: index, patch: { status: "waiting_time", waitingUntil: until } };
      }
      this.writeStep(owner, id, index, step, { status: "done", attempts: 1, output: "The wait is over" });
      return { halt: false, cursor: index + 1, patch: { waitingUntil: null } };
    }
    if (step.kind === "branch") {
      const previous = this.stepStates(owner, id).findLast((state) => state.index < index && state.output);
      const matched = (previous?.output ?? "").toLowerCase().includes(step.contains!.toLowerCase());
      this.writeStep(owner, id, index, step, { status: "done", attempts: 1, output: matched ? "carried on" : "skipped ahead" });
      return { halt: false, cursor: index + 1 + (matched ? 0 : step.skipAhead ?? 1) };
    }
    return this.attempt(owner, id, index, step);
  }
  /** Runs one working step, giving it its allowed number of second tries before the workflow stops. */
  private async attempt(owner: string, id: string, index: number, step: WorkflowStep):
    Promise<{ halt: boolean; cursor?: number; patch?: Record<string, unknown> }> {
    let lastError = "";
    for (let attempt = 1; attempt <= step.retries + 1; attempt++) {
      this.writeStep(owner, id, index, step, { status: "running", attempts: attempt });
      try {
        const result = await this.execute(step);
        this.writeStep(owner, id, index, step, { status: "done", attempts: attempt, output: result.output, runId: result.runId });
        return { halt: false, cursor: index + 1 };
      } catch (error) {
        lastError = errorText(error);
        this.writeStep(owner, id, index, step, { status: attempt > step.retries ? "failed" : "retrying", attempts: attempt, output: lastError });
      }
    }
    return { halt: true, cursor: index, patch: { status: "failed", error: lastError } };
  }
  private async execute(step: WorkflowStep): Promise<{ output: string; runId: string | null }> {
    const signal = AbortSignal.timeout(step.timeoutMs);
    if (step.kind === "prompt") {
      const run = await this.runtime.run({ prompt: step.prompt!, signal, source: "schedule", onTextDelta: () => undefined });
      if (run.status !== "completed") throw new Error(`The step did not finish (${run.status})`);
      return { output: run.output, runId: run.id };
    }
    if (step.kind === "tool") {
      const result = await this.runtime.executeTool(step.tool!, step.args ?? {});
      return { output: JSON.stringify(result).slice(0, 4000), runId: null };
    }
    if (!this.knowledge) throw new Error("Saved procedures are not available in this launch");
    const context = this.runtime.context({ signal });
    const replayed = await this.knowledge.replayProcedure(context, step.recipeId!, step.inputs ?? {});
    return { output: JSON.stringify(replayed.results).slice(0, 4000), runId: null };
  }
}

/** Tools so a saved workflow can be made, looked at, started, stopped and carried on. */
export function registerWorkflows(registry: ToolRegistry, workflows: Workflows): void {
  registry.register({
    name: "workflows.create",
    description: "Save a list of steps the app can work through on its own: ask the assistant, replay a saved procedure, use one tool, wait for the owner to approve, wait a while, or skip ahead when the last answer did not say what was expected.",
    permission: "workflows.manage",
    parameters: WorkflowSchema,
    execute: async (value, context) => workflows.create(context.owner, value),
  });
  registry.register({
    name: "workflows.list",
    description: "Saved workflows with where each one has got to and what every step did.",
    permission: "workflows.read",
    parameters: z.object({}).strict(),
    execute: async (_value, context) => ({ workflows: workflows.list(context.owner) }),
  });
  registry.register({
    name: "workflows.run",
    description: "Start a saved workflow, or carry on one that was stopped part of the way through.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (value, context) => workflows.run(context.owner, value.id),
  });
  registry.register({
    name: "workflows.pause",
    description: "Stop a workflow between steps; everything already done stays done.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (value, context) => workflows.pause(context.owner, value.id),
  });
  registry.register({
    name: "workflows.resume",
    description: "Carry a stopped workflow on, or say yes to the step it is waiting for approval on.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (value, context) => workflows.resume(context.owner, value.id),
  });
}

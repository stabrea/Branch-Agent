import { chatOwnerOnly, startedFromChat } from "./key-context.js";
import { heldSource } from "./outside-origin.js"; // mac7/outside-resume
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import type { ToolRegistry } from "./registry.js";
import { errorText } from "./contracts.js";
import { ApprovalRequiredError, PolicyRefusedError } from "./approvals.js";
import { argumentFingerprint } from "./runtime.js";
import { outsideTask } from "./tool-gate.js"; // mac7/lockdown-fix
import type { ToolContext } from "./contracts.js";
import type { PolicyRemember, RunSource } from "./policy.js";

/**
 * A workflow is a saved list of steps the app works through on its own: ask the assistant, replay a
 * saved procedure, use one tool, wait for the owner to approve, wait until a time, or look at what
 * the last step said and skip ahead. Every step's state is written down as it happens, so closing
 * the app in the middle loses nothing: the workflow picks up where it stopped.
 */
export const stepKinds = ["prompt", "recipe", "tool", "approval", "wait", "branch", "flow"] as const;
/**
 * How deep one flow may call another. A flow inside a flow is useful — "do the weekly tidy-up"
 * belongs in one place, not copied into six — but a chain without an end would work for ever, so
 * the depth is capped and a flow that leads back to one already running is refused outright.
 */
export const maximumFlowDepth = 3;
export const WorkflowStepSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(stepKinds),
  prompt: z.string().trim().max(8000).optional(),
  recipeId: z.string().uuid().optional(),
  inputs: z.record(z.string().max(40), z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
  tool: z.string().min(1).max(100).optional(),
  /** For a flow step: another saved flow to work through before carrying on with this one. */
  flowId: z.string().uuid().optional(),
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
  const needs: Record<string, keyof typeof step> = { prompt: "prompt", recipe: "recipeId", tool: "tool", branch: "contains", flow: "flowId" };
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
/**
 * What a workflow stopped to ask about: the tool one of its steps wanted to use, what that would
 * touch, and who set the workflow going. Kept with the workflow, so the question survives a restart
 * and the owner's yes is remembered against the right thing.
 */
export interface WorkflowApproval {
  tool: string; target: string; label: string; source: RunSource; remember: PolicyRemember;
  /**
   * The fingerprint of the exact arguments the step wanted to use. The owner's yes is bound to it,
   * so a step someone edited while the workflow was waiting is asked about again.
   */
  fingerprint?: string;
}
/** Where a workflow's remembered answers are kept, since a workflow is not a conversation. */
const approvalKeyFor = (id: string): string => `workflow:${id}`;

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
  /**
   * Set by the launch: how to carry on a flow drawn as a graph. A graph flow is a saved workflow
   * to everyone outside, so "carry it on" is the one tool it already had rather than a second one
   * in a toolbox that is already full.
   */
  resumeGraph: ((id: string, within?: readonly string[], source?: RunSource) => unknown) | null = null;
  constructor(
    readonly store: Store,
    private readonly runtime: Runtime,
    private readonly knowledge?: Knowledge,
  ) {
    this.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS workflow_state(workflow_id TEXT NOT NULL,
      owner TEXT NOT NULL, step_index INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT '',
      run_id TEXT, started_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(workflow_id, step_index))`);
  }
  /**
   * The assistant always works as the owner, even during somebody else's task, so every tool here
   * checks whose profile is switched on first: a saved workflow's steps use tools with the whole
   * run of the app and must stay out of reach of anybody but the owner.
   */
  forOwner(owner: string): string {
    this.store.profiles.requireOwner("Saved workflows");
    return owner;
  }
  create(owner: string, input: unknown): WorkflowView {
    const definition = WorkflowSchema.parse(input);
    const id = definition.id ?? randomUUID();
    const existing = this.store.get("workflows", owner, id)?.data;
    this.store.save("workflows", owner, id, {
      ...definition, id, status: existing?.status ?? "idle", cursor: Number(existing?.cursor ?? 0),
      waitingUntil: existing?.waitingUntil ?? null, question: null, error: null,
      // mac7/lockdown-fix (integration review): saving the steps again never drops a task's limit.
      taskLimit: Array.isArray(existing?.taskLimit) ? existing.taskLimit : null,
      // mac7/outside-resume: nor who set a paused run going.
      ...(typeof existing?.startedFrom === "string" ? { startedFrom: existing.startedFrom } : {}),
      // Q114: nor the Trunk whose work it is, so saving the steps again never hands the rest to someone else.
      ...(typeof existing?.startedBy === "string" ? { startedBy: existing.startedBy } : {}),
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
  /**
   * Q114: the Trunk whose work this is. A fresh start takes whoever is at work now (none for the owner);
   * carrying on keeps the one that started it, whoever presses resume.
   */
  private startedBy(owner: string, id: string, fresh: boolean): string | null {
    const saved = (this.store.get("workflows", owner, id)?.data as { startedBy?: unknown } | undefined)?.startedBy;
    if (!fresh && typeof saved === "string") return saved;
    return this.runtime.trunkAtWork() ?? null;
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
  /** What the workflow stopped to ask about, when a step wanted to use a tool the settings guard. */
  private pending(owner: string, id: string): WorkflowApproval | null {
    const data = this.store.get("workflows", owner, id)?.data as { pendingApproval?: WorkflowApproval } | undefined;
    return data?.pendingApproval ?? null;
  }
  /**
   * Carries on from where it stopped; on a step that is waiting this is the owner saying yes. A
   * step that wanted to use a tool is tried again with that yes remembered, rather than skipped:
   * `remember` says whether the yes lasts for this workflow only or is kept as a standing rule.
   */
  async resume(owner: string, id: string, options: { remember?: PolicyRemember; source?: RunSource; within?: readonly string[] } = {}): Promise<WorkflowView> {
    const current = this.view(owner, id);
    if (current.status === "running") throw new Error("That workflow is working right now");
    if (current.status === "completed") throw new Error("That workflow has already finished");
    const waitingForYes = current.status === "waiting_approval"
      || (current.status === "paused" && current.pausedFrom === "waiting_approval");
    if (!waitingForYes) return this.run(owner, id, options.source ?? "owner", [], options.within);
    const asked = this.pending(owner, id);
    if (asked) {
      this.runtime.grantApproval(approvalKeyFor(id), asked, options.remember ?? asked.remember);
      this.setStatus(owner, id, { question: null, pausedFrom: null, pendingApproval: null });
      return this.run(owner, id, asked.source);
    }
    const step = current.steps[current.cursor];
    if (step) this.writeStep(owner, id, current.cursor, step, { status: "approved", attempts: 1, output: "Approved by the owner" });
    this.setStatus(owner, id, { cursor: current.cursor + 1, question: null, pausedFrom: null });
    return this.run(owner, id, options.source ?? "owner");
  }
  /**
   * The same as `resume`, but it will not say yes on the owner's behalf. The assistant calls this
   * one, so a workflow that stopped to ask can only be let past from the owner's own screen.
   */
  async resumeWithoutApproving(owner: string, id: string, source: RunSource = "owner", within?: readonly string[]): Promise<WorkflowView> {
    const current = this.view(owner, id);
    if (current.status === "waiting_approval"
      || (current.status === "paused" && current.pausedFrom === "waiting_approval"))
      throw new Error("That workflow is waiting for the owner to say yes. Ask them to approve it on their screen.");
    return this.resume(owner, id, { source, ...(within ? { within } : {}) });
  }
  /**
   * mac7/lockdown-fix: the permissions a task that set a workflow going holds, or undefined when it
   * holds them all (the owner pressing the tool by hand), so the owner's own start is unchanged.
   */
  taskLimit(context: Pick<ToolContext, "permissions">): string[] | undefined {
    return taskLimitOf(this.runtime, context);
  }
  /**
   * mac7/lockdown-fix: the limit this run works under. A task's start narrows it (and is kept with the
   * workflow, so an owner's yes later does not widen it); the owner starting it afresh clears it.
   */
  private limitFor(owner: string, id: string, fresh: boolean, within: readonly string[] | undefined): string[] | null {
    const saved = (this.store.get("workflows", owner, id)?.data as { taskLimit?: string[] | null } | undefined)?.taskLimit ?? null;
    if (!within) return fresh ? null : saved;
    return saved && !fresh ? saved.filter((p) => within.includes(p)) : [...within];
  }
  /**
   * mac7/outside-resume: who a run of the workflow is held as. Carrying one on (after a pause, a wait
   * or a yes) keeps whoever set it going — a schedule, a chat, another program — whoever carries it
   * on; the owner starting it afresh from the first step is the owner's own.
   */
  private heldSource(owner: string, id: string, fresh: boolean, source: RunSource): RunSource {
    if (fresh || source !== "owner") return source;
    const saved = (this.store.get("workflows", owner, id)?.data as { startedFrom?: RunSource } | undefined)?.startedFrom;
    return saved ?? "owner";
  }
  /**
   * Works through the steps until one needs the owner, a time to pass, or everything is done.
   * `source` is whoever set it going: a workflow started by a schedule or another app is held to
   * the same limits that task would have been, so it cannot be used to get around them.
   */
  async run(owner: string, id: string, source: RunSource = "owner", chain: readonly string[] = [], within?: readonly string[]): Promise<WorkflowView> {
    let current = this.view(owner, id);
    if (current.status === "running") throw new Error("That workflow is working right now");
    const fresh = ["idle", "completed", "failed"].includes(current.status);
    const limit = this.limitFor(owner, id, fresh, within); // mac7/lockdown-fix
    const held = this.heldSource(owner, id, fresh, source); // mac7/outside-resume
    const startedBy = this.startedBy(owner, id, fresh); // Q114
    const carryOn = async (): Promise<WorkflowView> => {
      current = this.setStatus(owner, id, { status: "running", error: null, question: null, pausedFrom: null, pendingApproval: null, taskLimit: limit,
        startedFrom: held, startedBy, ...(fresh ? { cursor: 0 } : {}) });
      for (let index = current.cursor; index < current.steps.length; index++) {
        const outcome = await this.step(owner, id, index, current.steps[index]!, current, held, chain, limit);
        if (outcome.halt) return this.setStatus(owner, id, { cursor: outcome.cursor ?? index, ...outcome.patch });
        // Take the saved view back, so a later step sees what the last one wrote (a wait's moment).
        current = this.setStatus(owner, id, { cursor: outcome.cursor ?? index + 1, ...outcome.patch });
        index = current.cursor - 1;
      }
      return this.setStatus(owner, id, { status: "completed", cursor: current.steps.length, waitingUntil: null });
    };
    // Q114: the whole carry-on runs as the Trunk that started it, so a refusal (another Trunk, or one that is
    // gone) comes before anything is marked running, and the workflow is left exactly as it stopped.
    return startedBy ? this.runtime.asTrunkWork(startedBy, carryOn) : carryOn();
  }
  private async step(owner: string, id: string, index: number, step: WorkflowStep, view: WorkflowView, source: RunSource, chain: readonly string[] = [], limit: string[] | null = null):
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
    return this.attempt(owner, id, index, step, source, chain, limit);
  }
  /** Runs one working step, giving it its allowed number of second tries before the workflow stops. */
  private async attempt(owner: string, id: string, index: number, step: WorkflowStep, source: RunSource, chain: readonly string[] = [], limit: string[] | null = null):
    Promise<{ halt: boolean; cursor?: number; patch?: Record<string, unknown> }> {
    let lastError = "";
    for (let attempt = 1; attempt <= step.retries + 1; attempt++) {
      this.writeStep(owner, id, index, step, { status: "running", attempts: attempt });
      try {
        const result = await this.execute(step, id, source, owner, chain, limit);
        this.writeStep(owner, id, index, step, { status: "done", attempts: attempt, output: result.output, runId: result.runId });
        return { halt: false, cursor: index + 1 };
      } catch (error) {
        // The settings say to ask about this one first: the workflow stops here, the same way an
        // approval step does, and the owner's yes on their own screen sets it going again.
        if (error instanceof ApprovalRequiredError)
          return this.waitForYes(owner, id, index, step, error, source, attempt - 1);
        lastError = errorText(error);
        // The settings refuse this outright, so trying again cannot help: the workflow stops here.
        if (error instanceof PolicyRefusedError) {
          this.writeStep(owner, id, index, step, { status: "failed", attempts: attempt, output: lastError });
          return { halt: true, cursor: index, patch: { status: "failed", error: lastError } };
        }
        this.writeStep(owner, id, index, step, { status: attempt > step.retries ? "failed" : "retrying", attempts: attempt, output: lastError });
      }
    }
    return { halt: true, cursor: index, patch: { status: "failed", error: lastError } };
  }
  private waitForYes(owner: string, id: string, index: number, step: WorkflowStep,
    asked: ApprovalRequiredError, source: RunSource, attempts: number):
    { halt: boolean; cursor: number; patch: Record<string, unknown> } {
    this.writeStep(owner, id, index, step, { status: "waiting", attempts, output: asked.message });
    const pendingApproval: WorkflowApproval = {
      tool: asked.tool, target: asked.target, label: asked.label, source, remember: asked.remember,
      ...(asked.fingerprint === undefined ? {} : { fingerprint: asked.fingerprint }),
    };
    return { halt: true, cursor: index, patch: { status: "waiting_approval", question: asked.message, pendingApproval } };
  }
  private async execute(step: WorkflowStep, id: string, source: RunSource, owner: string, chain: readonly string[] = [], limit: string[] | null = null): Promise<{ output: string; runId: string | null }> {
    const signal = AbortSignal.timeout(step.timeoutMs);
    if (step.kind === "flow") return this.nested(step, id, source, owner, chain, limit);
    // mac7/lockdown-fix: under a task's limit, every step holds only the permissions that task holds.
    const allowed = limit ? { permissions: [...this.runtime.context().permissions].filter((p) => limit.includes(p)) } : {};
    if (step.kind === "prompt") {
      // A chat message's workflow asks the model as the chat, never as a schedule the owner made.
      const run = await this.runtime.run({ prompt: step.prompt!, signal, source: source === "channel" ? "channel" : "schedule", onTextDelta: () => undefined, ...allowed });
      if (run.status !== "completed") throw new Error(`The step did not finish (${run.status})`);
      return { output: run.output, runId: run.id };
    }
    const context = this.runtime.context({ signal, source, approvalKey: approvalKeyFor(id), ...allowed });
    if (step.kind === "tool") {
      // A saved step uses its tool under the owner's approval settings, exactly as the assistant
      // does mid-conversation: allowed, asked about, or refused in the same words.
      // The exact bytes of this step's arguments. Everything downstream — the question the owner
      // sees, the yes they give, the retry after it — is bound to this one fingerprint.
      const fingerprint = argumentFingerprint(JSON.stringify(step.args ?? {}));
      const outside = outsideTask(this.runtime, step.tool!, context); // mac7/lockdown-fix: before any question
      if (outside) throw Object.assign(new PolicyRefusedError(step.tool!, step.name), { message: outside });
      const check = this.runtime.checkPolicy(step.tool!, step.args ?? {}, context, fingerprint);
      if (check.decision === "deny") throw new PolicyRefusedError(step.tool!, check.label);
      if (check.decision === "ask") throw new ApprovalRequiredError(step.tool!, check.target, check.label, check.remember, fingerprint);
      // mac5/manual-actions: the run itself is gated the same way, under this workflow's own yeses.
      const result = await this.runtime.executeTool(step.tool!, step.args ?? {}, { mode: "policy", source, approvalKey: approvalKeyFor(id), ...(limit ? { within: limit } : {}) });
      return { output: JSON.stringify(result).slice(0, 4000), runId: null };
    }
    if (!this.knowledge) throw new Error("Saved procedures are not available in this launch");
    const replayed = await this.knowledge.replayProcedure(context, step.recipeId!, step.inputs ?? {});
    return { output: JSON.stringify(replayed.results).slice(0, 4000), runId: null };
  }
  /**
   * One flow working through another. The chain of flows already running is carried down, so a flow
   * that leads back to one of them is refused by name rather than looping, and a chain longer than
   * `maximumFlowDepth` is refused before it starts. The step is held to whatever set the outer flow
   * going, so nesting is no way around the limits that source is kept to.
   */
  private async nested(step: WorkflowStep, id: string, source: RunSource, owner: string, chain: readonly string[], limit: string[] | null = null):
    Promise<{ output: string; runId: string | null }> {
    const target = step.flowId!;
    const running = [...chain, id];
    if (running.includes(target))
      throw new Error(`That flow leads back to one already running (${target}), so it was not started.`);
    if (running.length >= maximumFlowDepth)
      throw new Error(`Flows may only go ${maximumFlowDepth} deep; this one would be ${running.length + 1}.`);
    const finished = await this.run(owner, target, source, running, limit ?? undefined);
    // The inner flow's own reason is carried up, so the outer one says what actually went wrong.
    if (finished.status !== "completed")
      throw new Error(finished.error || `The flow inside this one did not finish (${finished.status})`);
    return { output: `The flow "${finished.name}" finished its ${finished.steps.length} step(s).`, runId: null };
  }
}

/** Tools so a saved workflow can be made, looked at, started, stopped and carried on. */
/**
 * mac7/lockdown-fix: the permissions a task holds, or undefined when it holds them all (the owner
 * pressing a tool by hand). Shared by every tool that sets saved work going.
 */
export function taskLimitOf(runtime: Pick<Runtime, "context">, context: Pick<ToolContext, "permissions">): string[] | undefined {
  const all = runtime.context().permissions;
  return [...all].every((p) => context.permissions.has(p)) ? undefined : [...context.permissions];
}

export function registerWorkflows(registry: ToolRegistry, workflows: Workflows): void {
  registry.register({
    name: "workflows.create",
    description: "Save a list of steps the app can work through on its own: ask the assistant, replay a saved procedure, use one tool, wait for the owner to approve, wait a while, or skip ahead when the last answer did not say what was expected.",
    permission: "workflows.manage",
    parameters: WorkflowSchema,
    execute: async (value, context) => {
      if (startedFromChat(context, workflows.store)) throw chatOwnerOnly("Saving a workflow");
      return workflows.create(workflows.forOwner(context.owner), value);
    },
  });
  registry.register({
    name: "workflows.list",
    description: "Saved workflows with where each one has got to and what every step did.",
    permission: "workflows.read",
    parameters: z.object({}).strict(),
    execute: async (_value, context) => ({ workflows: workflows.list(workflows.forOwner(context.owner)) }),
  });
  registry.register({
    name: "workflows.run",
    description: "Start a saved workflow, or carry on one that was stopped part of the way through.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    // The workflow is held to whatever this task is held to: starting one is no way around the
    // approval settings a schedule or another app is kept to.
    // mac7/lockdown-fix: and to the tools this task may use, so a workflow is no way round its own list.
    // mac7/outside-resume: read from the task's record too, so a task carried on from outside is held as it started.
    execute: async (value, context) => workflows.run(workflows.forOwner(context.owner), value.id, heldSource(context, workflows.store), [], workflows.taskLimit(context)),
  });
  registry.register({
    name: "workflows.pause",
    description: "Stop a workflow between steps; everything already done stays done.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (value, context) => workflows.pause(workflows.forOwner(context.owner), value.id),
  });
  registry.register({
    name: "workflows.resume",
    description: "Carry a stopped workflow on. A workflow waiting for the owner's approval is not carried on by this; the owner says yes on their own screen.",
    permission: "workflows.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (value, context) => {
      const owner = workflows.forOwner(context.owner);
      // A flow drawn as a graph carries on from its own checkpoint; everything else is a step list.
      const within = workflows.taskLimit(context); // mac7/lockdown-fix
      const source = heldSource(context, workflows.store); // mac7/outside-resume
      return workflows.resumeGraph?.(value.id, within, source)
        ?? workflows.resumeWithoutApproving(owner, value.id, source, within);
    },
  });
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalRequiredError, PolicyRefusedError } from "../approvals.js";
import { BudgetError, errorText, type ToolContext } from "../contracts.js";
import type { Knowledge } from "../knowledge.js";
import type { RunSource } from "../policy.js";
import type { InputValue } from "../recipes.js";
import type { Runtime } from "../runtime.js";
import type { ToolGateMode } from "../tool-gate.js";
import { boardTools, partRecord, requirePart } from "./settings.js";

/**
 * R17-070: checks that really run after a saved procedure (a recipe), clean-up when it fails, a time
 * limit, and a number of tries. The idea is Goose's `crates/goose/src/agents/retry.rs` (Apache-2.0,
 * Block, Inc.): run the work, run the checks, and when a check fails run the clean-up and try again, up
 * to the count the owner set. Written for Branch.
 *
 * A check is one tool call whose answer must contain some words, or a small script (`code.run`) that
 * must finish with exit code 0 — the "shell check". Clean-up is a list of tool calls. Every one of them
 * goes through the one tool gate (`Runtime.executeTool`), the procedure's own steps keep their gate in
 * src/knowledge.ts, and a call the approval rules want to ask about stops the whole thing rather than
 * being tried again: a yes is never assumed.
 */
const CallSchema = z.object({
  tool: z.string().trim().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
}).strict();
const ToolCheckSchema = CallSchema.extend({
  /** Words the answer must contain. Without them, the check passes when the call does not fail. */
  contains: z.string().max(500).optional(),
}).strict();
const ScriptCheckSchema = z.object({
  script: z.string().min(1).max(16384),
  language: z.enum(["javascript", "python"]).default("javascript"),
}).strict();
export const CheckSchema = z.union([ToolCheckSchema, ScriptCheckSchema]);
export type RecipeCheck = z.infer<typeof CheckSchema>;

export const RecipeChecksSchema = z.object({
  checks: z.array(CheckSchema).max(8).default([]),
  cleanup: z.array(CallSchema).max(8).default([]),
  /** How many more times to try after the first. */
  retries: z.number().int().min(0).max(5).default(0),
  /** How long the procedure itself may take, each try. */
  timeoutSeconds: z.number().int().min(5).max(3600).default(300),
  /** How long each check or clean-up call may take. */
  stepTimeoutSeconds: z.number().int().min(5).max(600).default(60),
}).strict();
export type RecipeChecks = z.infer<typeof RecipeChecksSchema>;

const key = (procedureId: string): string => `flowboards-recipe-checks:${procedureId}`;
/** Tools a check or a clean-up may not use: nothing that starts more procedures, schedules or specialists. */
const orchestration = /^(procedures|specialists|schedules|workflows|flows?)\./;

export interface CheckedRun {
  status: "passed" | "failed";
  attempts: number;
  /** Why each failed try failed, in order. */
  reasons: string[];
  /** What clean-up could not do, if anything. */
  cleanupProblems: string[];
  results: unknown[];
}

export interface RunOptions {
  mode: ToolGateMode; source: RunSource; runId?: string;
  /** What the task that asked may do; the owner pressing Run holds every permission. */
  permissions?: ReadonlySet<string>;
  /** The task that asked, when one did: each try is charged to its budget, and its Stop stops the checks. */
  parent?: Pick<ToolContext, "budget" | "signal" | "depth">;
}

export interface RecipeCheckDeps { runtime: Runtime; knowledge: Pick<Knowledge, "replayProcedure"> }

export class RecipeChecker {
  constructor(private readonly deps: RecipeCheckDeps) {}
  private get store() { return this.deps.runtime.store; }
  private get owner() { return this.deps.runtime.owner; }

  get(procedureId: string): RecipeChecks {
    return partRecord(this.store, this.owner, key(procedureId), RecipeChecksSchema);
  }

  save(procedureId: string, input: unknown): RecipeChecks {
    requirePart(this.store, this.owner, "recipe-checks");
    if (!this.store.get("procedures", this.owner, procedureId)) throw new Error("That procedure is not on file");
    const value = RecipeChecksSchema.parse(input);
    for (const call of [...value.checks, ...value.cleanup])
      if ("tool" in call && startsWork(call.tool)) throw new Error(startsWorkRefusal(call.tool));
    this.store.save("settings", this.owner, key(procedureId), value);
    return value;
  }

  /**
   * Replays the procedure with its checks. `mode` is "owner" when the owner pressed Run in the window,
   * and "policy" for everything else (the assistant's tool), exactly as the tool gate means them.
   */
  async run(procedureId: string, inputs: Record<string, InputValue>, options: RunOptions): Promise<CheckedRun> {
    requirePart(this.store, this.owner, "recipe-checks");
    const plan = this.get(procedureId);
    const outcome: CheckedRun = { status: "failed", attempts: 0, reasons: [], cleanupProblems: [], results: [] };
    while (outcome.attempts <= plan.retries) {
      // Integration review: every try is a step of the task that asked, and a stopped task tries no more.
      options.parent?.budget.step(options.parent.signal);
      outcome.attempts++;
      const reason = await this.attempt(procedureId, inputs, plan, options, outcome);
      if (reason === null) { outcome.status = "passed"; break; }
      outcome.reasons.push(reason);
      outcome.cleanupProblems.push(...await this.cleanUp(procedureId, plan, options));
      if (options.runId) this.store.event(options.runId, "procedure.retry", { procedure: procedureId, attempt: outcome.attempts, reason: reason.slice(0, 300) });
    }
    return outcome;
  }

  /** One try: the procedure, then every check. Null when all is well, else why not. */
  private async attempt(procedureId: string, inputs: Record<string, InputValue>, plan: RecipeChecks,
    options: RunOptions, outcome: CheckedRun): Promise<string | null> {
    try {
      const context = this.context(options, plan.timeoutSeconds);
      const replayed = await within(() => this.deps.knowledge.replayProcedure(context, procedureId, inputs), plan.timeoutSeconds, "The procedure");
      outcome.results = replayed.results;
    } catch (error) {
      if (stopsEverything(error)) throw error;
      return `The procedure did not finish: ${errorText(error)}`;
    }
    for (const [index, check] of plan.checks.entries()) {
      const problem = await this.check(check, plan, options, procedureId);
      if (problem) return `Check ${index + 1} did not pass: ${problem}`;
    }
    return null;
  }

  private async check(check: RecipeCheck, plan: RecipeChecks, options: RunOptions, procedureId: string): Promise<string | null> {
    const call = "script" in check
      ? { tool: "code.run", args: { language: check.language, source: check.script } }
      : { tool: check.tool, args: check.args };
    let answer: unknown;
    try {
      answer = await within((signal) => this.use(call, options, procedureId, signal), plan.stepTimeoutSeconds, "The check", options.parent?.signal);
    } catch (error) {
      if (stopsEverything(error)) throw error;
      return errorText(error);
    }
    if ("script" in check) {
      const ran = answer as { exitCode?: unknown; status?: unknown; errors?: unknown };
      return ran.exitCode === 0 ? null : `the script ended with ${String(ran.exitCode ?? ran.status)}${ran.errors ? `: ${String(ran.errors).slice(0, 200)}` : ""}`;
    }
    if (!check.contains) return null;
    const text = typeof answer === "string" ? answer : JSON.stringify(answer) ?? "";
    return text.toLowerCase().includes(check.contains.toLowerCase()) ? null : `the answer did not say "${check.contains}"`;
  }

  /** Every clean-up call, each on its own: one failing does not keep the next from running. */
  private async cleanUp(procedureId: string, plan: RecipeChecks, options: RunOptions): Promise<string[]> {
    const problems: string[] = [];
    for (const call of plan.cleanup) {
      try {
        await within((signal) => this.use(call, options, procedureId, signal), plan.stepTimeoutSeconds, "Clean-up", options.parent?.signal);
      } catch (error) {
        if (stopsEverything(error)) throw error;
        problems.push(`${call.tool}: ${errorText(error)}`);
      }
    }
    return problems;
  }

  private async use(call: { tool: string; args: Record<string, unknown> }, options: RunOptions, procedureId: string, signal: AbortSignal): Promise<unknown> {
    const { runtime } = this.deps;
    // Integration review: a saved record is checked again here, whatever wrote it.
    if (startsWork(call.tool)) throw refusal(call.tool, startsWorkRefusal(call.tool));
    // A task never reaches past what it may do itself, whatever the check asks for.
    if (options.permissions && !options.permissions.has(runtime.registry.permissionOf(call.tool)))
      throw refusal(call.tool, `${call.tool} needs a permission this task does not have`);
    const run = () => runtime.executeTool(call.tool, call.args, { mode: options.mode, source: options.source, approvalKey: `recipe-checks:${procedureId}`, signal });
    if (!options.runId) return run();
    // Integration review: the repeated-call guard of the task sees every check; one it refuses ends the run.
    let ran = false;
    const answer = await runtime.guards.call(options.runId, { id: randomUUID(), name: call.tool, arguments: JSON.stringify(call.args) }, () => { ran = true; return run(); });
    if (!ran) throw refusal(call.tool, `The same check kept being asked: ${String((answer as { error?: unknown }).error ?? call.tool)}`);
    return answer;
  }

  private context(options: RunOptions, seconds: number): ToolContext {
    const { parent } = options;
    const signal = AbortSignal.any([AbortSignal.timeout(seconds * 1000), ...(parent ? [parent.signal] : [])]);
    return this.deps.runtime.context({ signal, source: options.source,
      ...(parent ? { budget: parent.budget, depth: parent.depth } : {}),
      approvalKey: "recipe-checks", ...(options.runId ? { runId: options.runId } : {}),
      ...(options.permissions ? { permissions: [...options.permissions] } : {}) });
  }
}

/** A refusal, a question from the approval rules or a spent budget ends the run at once; it is never tried again. */
function stopsEverything(error: unknown): boolean {
  return error instanceof ApprovalRequiredError || error instanceof PolicyRefusedError || error instanceof BudgetError;
}

const own = new Set<string>(Object.values(boardTools).flat());
const startsWork = (tool: string): boolean => orchestration.test(tool) || own.has(tool);
const startsWorkRefusal = (tool: string): string => `A check or clean-up cannot use ${tool}; it may not start more work of its own.`;
function refusal(tool: string, message: string): PolicyRefusedError {
  const error = new PolicyRefusedError(tool, message);
  error.message = message;
  return error;
}

/**
 * The work, given a signal that is stopped when the time is up (or the caller's own stop comes), so
 * the tool itself is stopped rather than only no longer waited for (integration review).
 */
async function within<T>(work: (signal: AbortSignal) => Promise<T>, seconds: number, what: string, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${what} took longer than ${seconds} seconds`);
      controller.abort(error);
      reject(error);
    }, seconds * 1000);
    timer.unref();
  });
  try { return await Promise.race([work(signal), late]); } finally { clearTimeout(timer); }
}

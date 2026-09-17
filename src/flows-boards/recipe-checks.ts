import { z } from "zod";
import { ApprovalRequiredError, PolicyRefusedError } from "../approvals.js";
import { errorText, type ToolContext } from "../contracts.js";
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
    const own = new Set<string>(Object.values(boardTools).flat());
    for (const call of [...value.checks, ...value.cleanup])
      if ("tool" in call && (orchestration.test(call.tool) || own.has(call.tool)))
        throw new Error(`A check or clean-up cannot use ${call.tool}; it may not start more work of its own.`);
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
      const replayed = await within(this.deps.knowledge.replayProcedure(context, procedureId, inputs), plan.timeoutSeconds, "The procedure");
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
      answer = await within(this.use(call, options, procedureId), plan.stepTimeoutSeconds, "The check");
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
        await within(this.use(call, options, procedureId), plan.stepTimeoutSeconds, "Clean-up");
      } catch (error) {
        if (stopsEverything(error)) throw error;
        problems.push(`${call.tool}: ${errorText(error)}`);
      }
    }
    return problems;
  }

  private use(call: { tool: string; args: Record<string, unknown> }, options: RunOptions, procedureId: string): Promise<unknown> {
    // A task never reaches past what it may do itself, whatever the check asks for.
    if (options.permissions && !options.permissions.has(this.deps.runtime.registry.permissionOf(call.tool)))
      return Promise.reject(new PolicyRefusedError(call.tool, `${call.tool} needs a permission this task does not have`));
    return this.deps.runtime.executeTool(call.tool, call.args, { mode: options.mode, source: options.source, approvalKey: `recipe-checks:${procedureId}` });
  }

  private context(options: RunOptions, seconds: number): ToolContext {
    return this.deps.runtime.context({ signal: AbortSignal.timeout(seconds * 1000), source: options.source,
      approvalKey: "recipe-checks", ...(options.runId ? { runId: options.runId } : {}),
      ...(options.permissions ? { permissions: [...options.permissions] } : {}) });
  }
}

/** A refusal or a question from the approval rules ends the run at once; it is never tried again. */
function stopsEverything(error: unknown): boolean {
  return error instanceof ApprovalRequiredError || error instanceof PolicyRefusedError;
}

async function within<T>(work: Promise<T>, seconds: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${seconds} seconds`)), seconds * 1000);
    timer.unref();
  });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

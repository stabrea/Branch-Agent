import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { Run } from "./contracts.js";
import { isReadOnlyPermission } from "./policy.js";
import { estimateCost, pricingSettings, type CostConfidence } from "./pricing.js";
import { findSuite, type EvaluationTask, type SuiteEntry } from "./evaluation-suites.js";
import { gradeTask, type GradeMethod } from "./evaluation-grading.js";

/** One task's result: did it pass, how long it took, how many tokens and how much money. */
export interface TaskOutcome {
  id: string; runId: string | null; status: string; passed: boolean; skipped: boolean;
  score: number; method: GradeMethod | "skipped"; problem: string | null; reason: string | null;
  ms: number; tokens: number; dollars: number | null; tags: string[];
}
export interface SuiteRun {
  id: string; suiteId: string; suiteName: string; preset: string; model: string; version: string;
  startedAt: string; finishedAt: string; tasks: TaskOutcome[];
  summary: {
    accuracy: number; passed: number; total: number; skipped: number;
    latencyMs: { mean: number; max: number }; tokens: number;
    dollars: number | null; costConfidence: CostConfidence; energy: "unavailable";
  };
  /** Tasks that passed in each of the three runs before this one and have just failed. */
  regressions: { taskId: string; problem: string | null }[];
}
export const RunSuiteSchema = z.object({
  suite: z.string().min(1).max(64),
  /** The model choice to use; the one in use otherwise. */
  preset: z.string().min(1).max(64).optional(),
  /** Only let the tasks use tools that change nothing. Always on when comparing models. */
  readOnly: z.boolean().optional(),
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxTokens: z.number().int().min(1000).max(1_000_000).default(120_000),
}).strict();
export const CompareSchema = z.object({
  suite: z.string().min(1).max(64),
  presets: z.array(z.string().min(1).max(64)).min(2).max(4),
  /** Let the tasks change things. Off by default: a comparison repeats the same work several times. */
  allowChanges: z.boolean().default(false),
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxTokens: z.number().int().min(1000).max(1_000_000).default(120_000),
}).strict();
const historyLimit = 50;
const recordId = (id: string): string => `evaluation-run:${id}`;

/**
 * Runs suites, keeps every result, and says when something that used to work has stopped working.
 * Everything a run records comes from the run itself: real answers, real time taken, real tokens,
 * and money worked out from the price table. Energy is reported unavailable: nothing here can
 * measure it honestly.
 */
export class SuiteRunner {
  constructor(private readonly store: Store, private readonly runtime: Runtime, private readonly version: string) {}
  private get owner(): string { return this.runtime.owner; }

  async run(input: unknown): Promise<SuiteRun> {
    const request = RunSuiteSchema.parse(input);
    const suite = findSuite(this.store, this.owner, request.suite);
    const readOnly = request.readOnly ?? suite.readOnly;
    const choice = this.runtime.models.plan(this.owner, "evaluation", request.preset ? { preset: request.preset } : {}).choice;
    const startedAt = new Date().toISOString();
    const tasks: TaskOutcome[] = [];
    for (const task of suite.tasks) tasks.push(await this.runTask(task, request, readOnly, choice.model));
    const result = this.assemble(suite, choice.presetId, choice.model, startedAt, tasks);
    this.store.save("governance", this.owner, recordId(result.id), { ...result });
    return result;
  }

  private async runTask(task: EvaluationTask, request: z.infer<typeof RunSuiteSchema>, readOnly: boolean, model: string): Promise<TaskOutcome> {
    const missing = task.requires.filter((tool) => !this.runtime.registry.names().includes(tool));
    if (missing.length)
      return { id: task.id, runId: null, status: "skipped", passed: false, skipped: true, score: 0, method: "skipped", problem: `Skipped: ${missing.join(", ")} is not installed`, reason: null, ms: 0, tokens: 0, dollars: null, tags: task.tags };
    const began = Date.now();
    const run = await this.execute(task, request, readOnly);
    const grade = run.status === "completed"
      ? await gradeTask(this.runtime, task, run.output)
      : { score: 0, passed: false, method: "checks" as const, problem: run.output.slice(0, 200), reason: null };
    const tokens = this.tokensFor(run.id);
    return {
      id: task.id, runId: run.id, status: run.status, passed: grade.passed, skipped: false,
      score: grade.score, method: grade.method, problem: grade.problem, reason: grade.reason,
      ms: Date.now() - began, tokens: tokens.input + tokens.output,
      dollars: this.costOf(model, tokens).amount, tags: task.tags,
    };
  }

  /** Runs one task, cutting it short after its first step and continuing it when the task asks for that. */
  private async execute(task: EvaluationTask, request: z.infer<typeof RunSuiteSchema>, readOnly: boolean): Promise<Run> {
    const permissions = readOnly ? this.runtime.registry.permissions().filter(isReadOnlyPermission) : undefined;
    const options = {
      prompt: task.prompt, signal: AbortSignal.timeout(task.timeoutMs),
      ...(permissions ? { permissions } : {}),
      ...(request.preset ? { model: request.preset } : {}),
      ...(task.checks ? { checks: { ...task.checks, maxRetries: 0 as const } } : {}),
    };
    if (task.mode !== "interrupt-resume")
      return this.runtime.run({ ...options, budget: { maxSteps: request.maxSteps, maxTokens: request.maxTokens } });
    // The stop is staged, not real: one round with the model and the one tool call it asks for are
    // allowed, then the saved task is marked interrupted exactly as a power cut would leave it, and
    // the ordinary continue path takes over from there.
    const first = await this.runtime.run({ ...options, budget: { maxSteps: 2, maxTokens: request.maxTokens } });
    if (first.status === "completed") return first;
    this.store.finish(first.id, "interrupted", "Stopped on purpose by the evaluation, part way through");
    return this.runtime.resume(first.id);
  }

  private tokensFor(runId: string): { input: number; output: number } {
    const usage = this.store.usage(runId);
    return { input: usage.estimatedInput ?? 0, output: usage.estimatedOutput ?? 0 };
  }

  private costOf(model: string, tokens: { input: number; output: number }) {
    return estimateCost(model, tokens, pricingSettings(this.store, this.owner).overrides);
  }

  private assemble(suite: SuiteEntry, preset: string, model: string, startedAt: string, tasks: TaskOutcome[]): SuiteRun {
    const scored = tasks.filter((task) => !task.skipped);
    const passed = scored.filter((task) => task.passed).length;
    const latencies = scored.map((task) => task.ms);
    const priced = scored.filter((task) => task.dollars !== null);
    const confidence = this.costOf(model, { input: 0, output: 0 }).confidence;
    const id = randomUUID();
    return {
      id, suiteId: suite.id, suiteName: suite.name, preset, model, version: this.version,
      startedAt, finishedAt: new Date().toISOString(), tasks,
      summary: {
        accuracy: scored.length ? Math.round((passed / scored.length) * 1000) / 1000 : 0,
        passed, total: scored.length, skipped: tasks.length - scored.length,
        latencyMs: { mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0, max: latencies.length ? Math.max(...latencies) : 0 },
        tokens: scored.reduce((total, task) => total + task.tokens, 0),
        dollars: priced.length ? Math.round(priced.reduce((total, task) => total + (task.dollars ?? 0), 0) * 1e6) / 1e6 : null,
        costConfidence: confidence, energy: "unavailable",
      },
      regressions: this.regressionsFor(suite.id, tasks),
    };
  }

  /** A task that passed in each of the three runs before this one and has just failed. */
  private regressionsFor(suiteId: string, tasks: TaskOutcome[]): { taskId: string; problem: string | null }[] {
    const previous = this.history(suiteId).slice(0, 3);
    if (previous.length < 3) return [];
    return tasks
      .filter((task) => !task.skipped && !task.passed)
      .filter((task) => previous.every((run) => run.tasks.some((old) => old.id === task.id && old.passed)))
      .map((task) => ({ taskId: task.id, problem: task.problem }));
  }

  /** Every stored run, newest first, for one suite or for all of them. */
  history(suiteId?: string): SuiteRun[] {
    return this.store.list("governance", this.owner)
      .filter((record) => record.id.startsWith("evaluation-run:"))
      .map((record) => record.data as unknown as SuiteRun)
      .filter((run) => !suiteId || run.suiteId === suiteId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, historyLimit);
  }

  /** The history as a trend: one point per run, oldest first, plus how each task has been doing. */
  trend(suiteId?: string) {
    const runs = this.history(suiteId).slice().reverse();
    const taskIds = [...new Set(runs.flatMap((run) => run.tasks.map((task) => task.id)))];
    return {
      runs: runs.map((run) => ({ id: run.id, at: run.startedAt, preset: run.preset, version: run.version, accuracy: run.summary.accuracy, meanMs: run.summary.latencyMs.mean, tokens: run.summary.tokens, dollars: run.summary.dollars, regressions: run.regressions.length })),
      tasks: taskIds.map((id) => ({ id, results: runs.map((run) => run.tasks.find((task) => task.id === id)?.passed ?? null) })),
      latestRegressions: runs.at(-1)?.regressions ?? [],
    };
  }

  /**
   * Runs a suite on a schedule. The result is recorded as an ordinary finished task so it shows up
   * in Activity like anything else, and a regression is announced to whatever is listening.
   */
  async runScheduled(suiteId: string, preset?: string): Promise<{ run: Run; result: SuiteRun | null }> {
    const run = this.store.createRun(this.owner, `Nightly evaluation: ${suiteId}`);
    try {
      const result = await this.run({ suite: suiteId, ...(preset ? { preset } : {}) });
      const text = summaryLine(result);
      this.store.message(run.sessionId, { role: "assistant", content: text });
      this.store.event(run.id, "evaluation.finished", { suite: result.suiteId, evaluationRunId: result.id, accuracy: result.summary.accuracy, regressions: result.regressions.length });
      if (result.regressions.length)
        this.runtime.notifyEvent("evaluation.regression", { suite: result.suiteId, evaluationRunId: result.id, runId: run.id, preset: result.preset, version: result.version, accuracy: result.summary.accuracy, tasks: result.regressions });
      return { run: this.store.finish(run.id, "completed", text), result };
    } catch (error) {
      const text = `The evaluation could not run: ${error instanceof Error ? error.message : String(error)}`;
      this.store.message(run.sessionId, { role: "assistant", content: text });
      return { run: this.store.finish(run.id, "failed", text), result: null };
    }
  }

  /** The same suite against several model choices, side by side. */
  async compare(input: unknown) {
    const request = CompareSchema.parse(input);
    const rows = [];
    for (const preset of request.presets) {
      const run = await this.run({ suite: request.suite, preset, readOnly: !request.allowChanges, maxSteps: request.maxSteps, maxTokens: request.maxTokens });
      rows.push({ preset: run.preset, model: run.model, accuracy: run.summary.accuracy, passed: run.summary.passed, total: run.summary.total, meanMs: run.summary.latencyMs.mean, tokens: run.summary.tokens, dollars: run.summary.dollars, costConfidence: run.summary.costConfidence, runId: run.id });
    }
    const best = rows.slice().sort((a, b) => b.accuracy - a.accuracy || a.meanMs - b.meanMs)[0];
    return { suite: request.suite, readOnly: !request.allowChanges, rows, best: best?.preset ?? null };
  }
}

/** One line a person can read at a glance, for Activity and for a message sent to a chat. */
export function summaryLine(result: SuiteRun): string {
  const money = result.summary.dollars === null ? "no price on file" : `$${result.summary.dollars.toFixed(4)}`;
  const regressions = result.regressions.length
    ? ` Something that used to work has stopped: ${result.regressions.map((entry) => entry.taskId).join(", ")}.`
    : "";
  return `${result.suiteName}: ${result.summary.passed} of ${result.summary.total} right using ${result.preset}, ${result.summary.latencyMs.mean} ms each on average, ${money}.${regressions}`;
}

/**
 * What sits between a finished task and the scorers: reading the task's record back as a
 * trajectory, giving the rubric scorer a way to ask the model, and the gates that decide whether a
 * whole run counts as a pass — the thing a release script can stop on.
 */
import { z } from "zod";
import type { Store } from "./store.js";
import type { Runtime } from "./runtime.js";
import { makeScorer, scoreAll, type Evaluator, type ScoredTask, type ScoredTrajectory, type ScorerContext, type ScoreResult } from "./evaluation-scorers.js";

/**
 * One finished task read back in the shape a scorer understands. Tool calls and their arguments
 * come from the conversation itself, which is where the model's exact request is kept; rounds,
 * time, tokens and money are counted the same way the Look inside screen counts them.
 */
export function readTrajectory(
  store: Store, runId: string | null, extras: { ms: number; tokens: number; dollars: number | null },
): ScoredTrajectory {
  if (!runId) return { runId: null, calls: [], steps: 0, ...extras };
  const run = store.run(runId);
  const messages = run ? store.messages(run.sessionId) : [];
  const calls: ScoredTrajectory["calls"] = [];
  for (const message of messages)
    for (const call of message.toolCalls ?? []) {
      let parsed: unknown;
      try { parsed = JSON.parse(call.arguments); } catch { parsed = {}; }
      calls.push({ name: call.name, arguments: (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown> });
    }
  const steps = store.events(runId).filter((event) => event.kind === "model.selected").length;
  return { runId, calls, steps: steps || messages.filter((m) => m.role === "assistant").length, ...extras };
}

/**
 * A way to ask the model one question, for the rubric scorer. It is undefined when no connection
 * has been chosen, and the scorer then refuses to guess rather than quietly passing the task.
 */
export function runtimeJudge(runtime: Runtime | null): ScorerContext["judge"] {
  if (!runtime) return undefined;
  return async (prompt: string): Promise<string> => {
    const run = await runtime.run({ prompt, permissions: [], budget: { maxSteps: 2, maxTokens: 20000 } });
    return run.status === "completed" ? run.output : `{"score": 0, "reason": "The grader did not finish (${run.status})"}`;
  };
}

/** Builds the scorers one task asks for. An empty list means the task is decided some other way. */
export function scorersFor(specs: readonly unknown[] | undefined, context: ScorerContext): Evaluator[] {
  return (specs ?? []).map((spec) => makeScorer(spec, context));
}

/** Runs a task's scorers over its record. Nothing is scored when the task declares no scorers. */
export async function scoreTrajectory(
  specs: readonly unknown[] | undefined, context: ScorerContext,
  task: ScoredTask, trajectory: ScoredTrajectory, answer: string,
): Promise<(ScoreResult & { parts: { kind: string; score: number; pass: boolean }[] }) | null> {
  const scorers = scorersFor(specs, context);
  return scorers.length ? scoreAll(scorers, task, trajectory, answer) : null;
}

/**
 * The bar a whole run has to clear. Everything is optional: a gate with nothing set passes, so
 * adding gates never changes a run that did not ask for them.
 */
export const EvaluationGateSchema = z.object({
  /** The smallest share of tasks that may be right, from 0 to 1. */
  minAccuracy: z.number().min(0).max(1).optional(),
  /** The most one run may cost in dollars. */
  maxDollars: z.number().min(0).optional(),
  /** The longest a task may take on average. */
  maxMeanMs: z.number().int().min(1).optional(),
  /** How many tasks that used to work may have stopped working. Usually zero. */
  maxRegressions: z.number().int().min(0).optional(),
  /** Tasks that must pass whatever the overall score is. */
  mustPass: z.array(z.string().min(1).max(64)).max(20).default([]),
}).strict();
export type EvaluationGate = z.infer<typeof EvaluationGateSchema>;
/** Whether a run cleared its gates, and every reason it did not. */
export interface GateVerdict { passed: boolean; failures: string[] }

/** What a gate needs to know about a run. Any run-like record with these fields can be gated. */
export interface GateSubject {
  summary: { accuracy: number; dollars: number | null; latencyMs: { mean: number } };
  tasks: { id: string; passed: boolean; skipped: boolean }[];
  regressions: { taskId: string }[];
}

/** Checks one run against its gates. The reasons are written for a person reading a build log. */
export function applyGates(run: GateSubject, input: unknown): GateVerdict {
  const gate = EvaluationGateSchema.parse(input ?? {});
  const failures: string[] = [];
  if (gate.minAccuracy !== undefined && run.summary.accuracy < gate.minAccuracy)
    failures.push(`${Math.round(run.summary.accuracy * 100)}% of the tasks were right and ${Math.round(gate.minAccuracy * 100)}% was the bar`);
  if (gate.maxDollars !== undefined && (run.summary.dollars ?? 0) > gate.maxDollars)
    failures.push(`It cost $${(run.summary.dollars ?? 0).toFixed(4)} and $${gate.maxDollars.toFixed(4)} was the limit`);
  if (gate.maxMeanMs !== undefined && run.summary.latencyMs.mean > gate.maxMeanMs)
    failures.push(`Each task took ${run.summary.latencyMs.mean} ms on average and ${gate.maxMeanMs} ms was the limit`);
  if (gate.maxRegressions !== undefined && run.regressions.length > gate.maxRegressions)
    failures.push(`${run.regressions.length} task(s) that used to work have stopped, and ${gate.maxRegressions} was the limit`);
  for (const id of gate.mustPass) {
    const task = run.tasks.find((entry) => entry.id === id);
    if (!task) failures.push(`${id} has to pass, and it is not in this set of tasks`);
    else if (task.skipped) failures.push(`${id} has to pass, and it was skipped`);
    else if (!task.passed) failures.push(`${id} has to pass, and it did not`);
  }
  return { passed: failures.length === 0, failures };
}

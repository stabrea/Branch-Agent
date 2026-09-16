import { access } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { Runtime } from "./runtime.js";
import { evaluateChecks } from "./reliability.js";
import type { EvaluationTask } from "./evaluation-suites.js";

/** How a task was decided: by checks anyone can repeat, by asking the model, or by neither. */
export type GradeMethod = "checks" | "judge" | "none";
export interface Grade {
  score: number;
  passed: boolean;
  method: GradeMethod;
  /** Why it failed, in plain words, or null when it passed. */
  problem: string | null;
  /** The judge's reason, when a judge was used. */
  reason: string | null;
}

/** The first thing the task was told not to do that it did anyway, or null. */
export async function denyProblem(output: string, task: EvaluationTask, workspace: string): Promise<string | null> {
  const deny = task.deny;
  if (!deny) return null;
  const lower = output.toLowerCase();
  for (const phrase of deny.mentions)
    if (lower.includes(phrase.toLowerCase())) return `The answer repeated "${phrase}", which it was told to keep out`;
  for (const file of deny.files) {
    const path = resolve(workspace, file), rel = relative(workspace, path);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    try { await access(path); return `The file ${file} was created, and it should not have been`; } catch { /* absent, as it should be */ }
  }
  return null;
}

/**
 * Decides one task. Checks that can be settled without a model always win when the task has them;
 * a judge is only asked when there are none. What the task forbade is fatal either way.
 */
export async function gradeTask(runtime: Runtime, task: EvaluationTask, output: string): Promise<Grade> {
  const forbidden = await denyProblem(output, task, runtime.workspace);
  if (forbidden) return { score: 0, passed: false, method: "checks", problem: forbidden, reason: null };
  if (task.checks) {
    const problem = await evaluateChecks(output, { ...task.checks, maxRetries: 0 }, runtime.workspace);
    return { score: problem ? 0 : 1, passed: !problem, method: "checks", problem, reason: null };
  }
  if (task.judge) {
    const { score, reason } = await askJudge(runtime, task, output);
    const passed = score >= task.judge.pass;
    return { score, passed, method: "judge", problem: passed ? null : `The grader gave ${score}: ${reason}`, reason };
  }
  return { score: 1, passed: true, method: "none", problem: null, reason: null };
}

const judgeInstruction = "You are grading one answer against a rubric. Reply with JSON only, shaped {\"score\": number between 0 and 1, \"reason\": one short sentence}. Do not use any tools.";

/** Asks the model in use to grade a free-text answer. A grader that misbehaves scores nothing. */
async function askJudge(runtime: Runtime, task: EvaluationTask, output: string): Promise<{ score: number; reason: string }> {
  const prompt = [
    judgeInstruction,
    `Question that was asked:\n${task.prompt.slice(0, 4000)}`,
    task.expected ? `What a good answer looks like:\n${task.expected}` : "",
    `Rubric:\n${task.judge!.rubric}`,
    `Answer to grade:\n${output.slice(0, 4000)}`,
  ].filter(Boolean).join("\n\n");
  try {
    const run = await runtime.run({ prompt, permissions: [], budget: { maxSteps: 2, maxTokens: 20000 } });
    if (run.status !== "completed") return { score: 0, reason: `The grader did not finish (${run.status})` };
    return readGrade(run.output);
  } catch (error) {
    return { score: 0, reason: `The grader could not be asked: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Reads the grader's reply. Anything that is not a score between 0 and 1 counts as no score at all. */
export function readGrade(output: string): { score: number; reason: string } {
  const start = output.indexOf("{"), end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return { score: 0, reason: "The grader did not reply with a score" };
  let parsed: unknown;
  try { parsed = JSON.parse(output.slice(start, end + 1)); } catch { return { score: 0, reason: "The grader's reply was not readable" }; }
  const value = parsed as { score?: unknown; reason?: unknown };
  const score = typeof value.score === "number" && value.score >= 0 && value.score <= 1 ? value.score : null;
  if (score === null) return { score: 0, reason: "The grader did not give a score between 0 and 1" };
  return { score: Math.round(score * 100) / 100, reason: typeof value.reason === "string" ? value.reason.slice(0, 300) : "no reason given" };
}

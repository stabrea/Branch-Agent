/**
 * Scorers: the small, repeatable judgements an evaluation makes about one finished task.
 *
 * Every scorer answers the same question in the same shape — `score(task, trajectory, answer)`
 * gives back a number from 0 to 1, a pass or fail, and the reasons in plain words — so a suite, a
 * benchmark and a study can all be graded by the same pieces. All but one of them decide without
 * asking a model, which is what makes a result something two people can check against each other.
 * The one that does ask a model ("rubric") is off unless a connection has been chosen, and its
 * answer is remembered so the same question is never paid for twice in one study.
 */
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { checkResult } from "./delegation.js";
import { CompletionCheckSchema, evaluateChecks, type CompletionCheck } from "./reliability.js";
import { readGrade } from "./evaluation-grading.js";

/** What a scorer is told about the task it is grading. Only the parts every source can supply. */
export interface ScoredTask {
  id: string;
  prompt: string;
  /** What a good answer looks like, in words or as the reference answer itself. */
  expected?: string | undefined;
}
/** What the task actually did, read back from its record. */
export interface ScoredTrajectory {
  runId: string | null;
  /** Tool calls in the order they were made, with the arguments as they were parsed. */
  calls: { name: string; arguments: Record<string, unknown> }[];
  /** Rounds with the model. */
  steps: number;
  ms: number;
  tokens: number;
  dollars: number | null;
}
/** One scorer's verdict. `reasons` is empty only when there was nothing worth saying. */
export interface ScoreResult { score: number; pass: boolean; reasons: string[] }
export interface Evaluator {
  readonly id: string;
  readonly kind: string;
  score(task: ScoredTask, trajectory: ScoredTrajectory, answer: string): Promise<ScoreResult>;
}

const pass = (reason?: string): ScoreResult => ({ score: 1, pass: true, reasons: reason ? [reason] : [] });
const fail = (...reasons: string[]): ScoreResult => ({ score: 0, pass: false, reasons });

/** Whitespace, case and trailing punctuation dropped, the way benchmark answers are compared. */
export function normaliseAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/^[\s"'`]+|[\s"'`.,!?]+$/g, "");
}

export const ScorerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: z.string().max(4000), normalise: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("contains"), phrases: z.array(z.string().min(1).max(200)).min(1).max(20), all: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(300), flags: z.string().max(4).default("i") }).strict(),
  z.object({ kind: z.literal("json-schema"), schema: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ kind: z.literal("numeric"), value: z.number(), tolerance: z.number().min(0).default(0), relative: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal("url"), pattern: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("file-exists"), path: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("file-contains"), path: z.string().min(1).max(500), text: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("tool-called"), name: z.string().min(1).max(100), withArgs: z.record(z.string(), z.unknown()).optional() }).strict(),
  z.object({
    kind: z.literal("budget"),
    maxSteps: z.number().int().min(1).max(500).optional(),
    maxMs: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    maxDollars: z.number().min(0).optional(),
  }).strict(),
  z.object({ kind: z.literal("rubric"), rubric: z.string().min(1).max(2000), pass: z.number().min(0).max(1).default(0.6) }).strict(),
  /** "Did it actually finish?" — the completion checks the assistant already uses, as a scorer. */
  z.object({ kind: z.literal("finished"), checks: CompletionCheckSchema.optional() }).strict(),
]);
export type ScorerSpec = z.infer<typeof ScorerSchema>;
/** Every scorer the program knows, for documentation and for the screen's picker. */
export const scorerKinds: readonly string[] = [
  "exact", "contains", "regex", "json-schema", "numeric", "url", "file-exists", "file-contains",
  "tool-called", "budget", "rubric", "finished",
];
/**
 * Ways an answer says it did not really finish. A task that claims to be done while saying one of
 * these is the single most common wrong result, so it is checked for by name.
 */
const unfinishedPhrases = [
  "i was unable to", "i could not", "i couldn't", "i am unable to", "i can't complete",
  "as an ai", "please do this yourself", "left as an exercise", "todo:",
];

/** What a scorer needs from the outside world: the workspace, and a way to ask a model. */
export interface ScorerContext {
  workspace: string;
  /** Asks the model one question and gives back its raw answer. Absent means no model is chosen. */
  judge?: ((prompt: string) => Promise<string>) | undefined;
  /** Answers already paid for in this study, keyed by the exact question. Shared on purpose. */
  judgeCache?: Map<string, { score: number; reason: string }> | undefined;
}

/** A path inside the workspace, or null when it points outside it. */
function inside(workspace: string, path: string): string | null {
  const full = resolve(workspace, path), rel = relative(workspace, full);
  return rel.startsWith("..") || isAbsolute(rel) ? null : full;
}

/** Builds one scorer from its description. The description is data, so a suite file can carry it. */
export function makeScorer(input: unknown, context: ScorerContext): Evaluator {
  const spec = ScorerSchema.parse(input);
  return { id: spec.kind, kind: spec.kind, score: (task, trajectory, answer) => scoreWith(spec, context, task, trajectory, answer) };
}

async function scoreWith(
  spec: ScorerSpec, context: ScorerContext, task: ScoredTask, trajectory: ScoredTrajectory, answer: string,
): Promise<ScoreResult> {
  switch (spec.kind) {
    case "exact": return scoreExact(spec, answer);
    case "contains": return scoreContains(spec, answer);
    case "regex": return scoreRegex(spec.pattern, spec.flags, answer);
    case "json-schema": return scoreSchema(spec.schema, answer);
    case "numeric": return scoreNumeric(spec, answer);
    case "url": return scoreRegex(spec.pattern, "i", answer, "No address in the answer matches what was expected");
    case "file-exists": return scoreFileExists(context.workspace, spec.path);
    case "file-contains": return scoreFileContains(context.workspace, spec.path, spec.text);
    case "tool-called": return scoreToolCalled(spec, trajectory);
    case "budget": return scoreBudget(spec, trajectory);
    case "rubric": return scoreRubric(spec, context, task, answer);
    case "finished": return scoreFinished(spec.checks, context.workspace, answer);
  }
}

/**
 * The completion review: not "is the answer right" but "did it actually do the work". It runs the
 * task's own completion checks and then looks for the phrases an answer uses when it has quietly
 * given up, because a confident summary of work that never happened passes everything else.
 */
export async function scoreFinished(checks: CompletionCheck | undefined, workspace: string, answer: string): Promise<ScoreResult> {
  const lower = answer.toLowerCase();
  const excuse = unfinishedPhrases.find((phrase) => lower.includes(phrase));
  if (excuse) return fail(`The answer says it did not finish: it contains "${excuse}"`);
  if (!answer.trim()) return fail("There is no answer at all");
  if (!checks) return pass();
  const problem = await evaluateChecks(answer, { ...checks, maxRetries: 0 }, workspace);
  return problem ? fail(problem) : pass();
}

function scoreExact(spec: { value: string; normalise: boolean }, answer: string): ScoreResult {
  const shape = (value: string): string => (spec.normalise ? normaliseAnswer(value) : value.trim());
  return shape(answer) === shape(spec.value)
    ? pass() : fail(`The answer was "${answer.trim().slice(0, 120)}" and "${spec.value.slice(0, 120)}" was expected`);
}

function scoreContains(spec: { phrases: string[]; all: boolean }, answer: string): ScoreResult {
  const lower = answer.toLowerCase();
  const missing = spec.phrases.filter((phrase) => !lower.includes(phrase.toLowerCase()));
  const found = spec.phrases.length - missing.length;
  if (spec.all) return missing.length ? { score: found / spec.phrases.length, pass: false, reasons: missing.map((p) => `The answer does not mention "${p}"`) } : pass();
  return found ? pass() : fail(`The answer mentions none of: ${spec.phrases.join(", ")}`);
}

function scoreRegex(pattern: string, flags: string, answer: string, message = "The answer does not match the expected pattern"): ScoreResult {
  let expression: RegExp;
  try { expression = new RegExp(pattern, flags); } catch { return fail("That is not a valid pattern"); }
  return expression.test(answer) ? pass() : fail(message);
}

function scoreSchema(schema: Record<string, unknown>, answer: string): ScoreResult {
  const result = checkResult(answer, schema);
  return result.status === "unresolved" ? fail(result.reason) : pass();
}

function scoreNumeric(spec: { value: number; tolerance: number; relative: boolean }, answer: string): ScoreResult {
  const found = /-?\d+(?:[\d,]*\d)?(?:\.\d+)?/.exec(answer.replace(/,(?=\d{3}\b)/g, ""));
  if (!found) return fail("There is no number in the answer");
  const got = Number(found[0].replace(/,/g, ""));
  const allowed = spec.relative ? Math.abs(spec.value) * spec.tolerance : spec.tolerance;
  return Math.abs(got - spec.value) <= allowed
    ? pass() : fail(`The answer gave ${got} and ${spec.value} was expected${allowed ? ` (within ${allowed})` : ""}`);
}

async function scoreFileExists(workspace: string, path: string): Promise<ScoreResult> {
  const full = inside(workspace, path);
  if (!full) return fail(`${path} is outside the workspace`);
  try { await access(full); return pass(); } catch { return fail(`The file ${path} does not exist`); }
}

async function scoreFileContains(workspace: string, path: string, text: string): Promise<ScoreResult> {
  const full = inside(workspace, path);
  if (!full) return fail(`${path} is outside the workspace`);
  let contents: string;
  try { contents = await readFile(full, "utf8"); } catch { return fail(`The file ${path} does not exist`); }
  return contents.toLowerCase().includes(text.toLowerCase()) ? pass() : fail(`The file ${path} does not contain "${text.slice(0, 80)}"`);
}

function scoreToolCalled(spec: { name: string; withArgs?: Record<string, unknown> | undefined }, trajectory: ScoredTrajectory): ScoreResult {
  const matches = trajectory.calls.filter((call) => call.name === spec.name);
  if (!matches.length) return fail(`${spec.name} was never used`);
  if (!spec.withArgs) return pass();
  const wanted = Object.entries(spec.withArgs);
  const hit = matches.some((call) => wanted.every(([key, value]) => JSON.stringify(call.arguments[key]) === JSON.stringify(value)));
  return hit ? pass() : fail(`${spec.name} was used, but never with ${JSON.stringify(spec.withArgs).slice(0, 160)}`);
}

function scoreBudget(
  spec: { maxSteps?: number | undefined; maxMs?: number | undefined; maxTokens?: number | undefined; maxDollars?: number | undefined }, trajectory: ScoredTrajectory,
): ScoreResult {
  const reasons: string[] = [];
  if (spec.maxSteps !== undefined && trajectory.steps > spec.maxSteps) reasons.push(`It took ${trajectory.steps} rounds and ${spec.maxSteps} was the limit`);
  if (spec.maxMs !== undefined && trajectory.ms > spec.maxMs) reasons.push(`It took ${trajectory.ms} ms and ${spec.maxMs} ms was the limit`);
  if (spec.maxTokens !== undefined && trajectory.tokens > spec.maxTokens) reasons.push(`It used ${trajectory.tokens} tokens and ${spec.maxTokens} was the limit`);
  if (spec.maxDollars !== undefined && (trajectory.dollars ?? 0) > spec.maxDollars) reasons.push(`It cost $${(trajectory.dollars ?? 0).toFixed(4)} and $${spec.maxDollars.toFixed(4)} was the limit`);
  return reasons.length ? { score: 0, pass: false, reasons } : pass();
}

const rubricInstruction = "You are grading one answer against a rubric. Reply with JSON only, shaped {\"score\": number between 0 and 1, \"reason\": one short sentence}. Do not use any tools.";

/** The one scorer that costs money. Without a model chosen it refuses rather than guessing. */
async function scoreRubric(
  spec: { rubric: string; pass: number }, context: ScorerContext, task: ScoredTask, answer: string,
): Promise<ScoreResult> {
  if (!context.judge) return { score: 0, pass: false, reasons: ["This task is graded by a model, and no model connection was chosen for this run"] };
  const prompt = [
    rubricInstruction,
    `Question that was asked:\n${task.prompt.slice(0, 4000)}`,
    task.expected ? `What a good answer looks like:\n${task.expected.slice(0, 2000)}` : "",
    `Rubric:\n${spec.rubric}`,
    `Answer to grade:\n${answer.slice(0, 4000)}`,
  ].filter(Boolean).join("\n\n");
  const key = createHash("sha256").update(prompt).digest("hex");
  const cached = context.judgeCache?.get(key);
  if (cached) return { score: cached.score, pass: cached.score >= spec.pass, reasons: [cached.reason] };
  let answered: string;
  // A grader that could not be reached is this run's bad luck, not this answer's verdict, so it is
  // never remembered: the next task asks again instead of inheriting the failure.
  try { answered = await context.judge(prompt); }
  catch (error) { return fail(`The grader could not be asked: ${error instanceof Error ? error.message : String(error)}`); }
  const graded = readGrade(answered);
  context.judgeCache?.set(key, graded);
  return { score: graded.score, pass: graded.score >= spec.pass, reasons: [graded.reason] };
}

/**
 * Every scorer for one task, run in order, combined into one verdict: the mean score, a pass only
 * when every one of them passed, and every reason kept so a person can see what went wrong.
 */
export async function scoreAll(
  scorers: readonly Evaluator[], task: ScoredTask, trajectory: ScoredTrajectory, answer: string,
): Promise<ScoreResult & { parts: { kind: string; score: number; pass: boolean }[] }> {
  if (!scorers.length) return { score: 1, pass: true, reasons: [], parts: [] };
  const parts: { kind: string; score: number; pass: boolean }[] = [];
  const reasons: string[] = [];
  // "Did it stay inside its budget" is answered last, whatever order the task listed its scorers
  // in, because grading with a model costs money too and that cost has to be counted before the
  // question is asked. Every other scorer looks only at what is already there, so moving this one
  // changes no verdict but this one.
  const ordered = [...scorers].sort((a, b) => Number(a.kind === "budget") - Number(b.kind === "budget"));
  for (const scorer of ordered) {
    const result = await scorer.score(task, trajectory, answer);
    parts.push({ kind: scorer.kind, score: result.score, pass: result.pass });
    if (!result.pass) reasons.push(...result.reasons);
  }
  const mean = parts.reduce((total, part) => total + part.score, 0) / parts.length;
  return { score: Math.round(mean * 1000) / 1000, pass: parts.every((part) => part.pass), reasons, parts };
}

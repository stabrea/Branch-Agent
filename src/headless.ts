import type { Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import { exitCodes, exitCodeFor, runForScripts, type RunFlags, type RunWriter } from "./cli-run.js";

/**
 * The whole assistant with no window at all, for a job a script starts and a script reads: one
 * request or a file of them, run in order, each one's result printed as it finishes, and one exit
 * code at the end that says what happened.
 *
 * The codes are not new ones. They are the same four `branch run` has always used — 0 finished,
 * 2 stopped to ask, 3 failed, 4 out of budget — because a script that already knows how to read
 * one command should not have to learn a second set for another.
 */
export interface HeadlessJob {
  /** The requests to carry out, in order. */
  prompts: string[];
  flags: RunFlags;
  /** Stop at the first one that does not finish, rather than working through the rest. */
  stopEarly: boolean;
}
export interface HeadlessStep { prompt: string; runId: string; status: Run["status"]; exitCode: number }
export interface HeadlessReport {
  /** What the shell is told: 0 finished, 2 needs you, 3 failed, 4 out of budget. */
  exitCode: number;
  steps: HeadlessStep[];
  /** One plain line for a person reading the log afterwards. */
  summary: string;
}

/** Reads the words and flags after `branch headless`; `--script` names a file of requests. */
export function parseHeadlessArgs(argv: string[]): { script: string | null; stopEarly: boolean; rest: string[] } {
  let script: string | null = null, stopEarly = false;
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--script") { script = argv[++at] ?? ""; if (!script) throw new Error("--script needs a file after it"); }
    else if (word === "--stop-early") stopEarly = true;
    else rest.push(word);
  }
  return { script, stopEarly, rest };
}

/** One request per line; blank lines and lines starting with # are notes, not requests. */
export function promptsFromScript(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new Error("That script has no requests in it.");
  if (lines.length > 100) throw new Error("A script may hold at most 100 requests.");
  return lines;
}

/** The code for a whole job: the first thing that did not finish decides, otherwise it finished. */
export function jobExitCode(steps: readonly HeadlessStep[]): number {
  return steps.find((step) => step.exitCode !== exitCodes.ok)?.exitCode ?? exitCodes.ok;
}

const describe = (steps: readonly HeadlessStep[], code: number): string => {
  const done = steps.filter((step) => step.exitCode === exitCodes.ok).length;
  if (code === exitCodes.ok) return `All ${steps.length} finished.`;
  const stopped = steps.find((step) => step.exitCode !== exitCodes.ok)!;
  const why = code === exitCodes.needsInput ? "it stopped to ask you something"
    : code === exitCodes.budget ? "it ran out of the budget you set" : "it failed";
  return `${done} of ${steps.length} finished; "${stopped.prompt.slice(0, 60)}" did not, because ${why}.`;
};

/**
 * Carries out a scripted job with no window. Every request is run the same way `branch run` runs
 * one, so anything a script already relies on — the JSON Lines stream, the budget, the timeout, the
 * conversation to join — behaves identically here.
 */
export async function runHeadless(runtime: Runtime, job: HeadlessJob, writer: RunWriter): Promise<HeadlessReport> {
  const steps: HeadlessStep[] = [];
  let sessionId = job.flags.sessionId;
  for (const prompt of job.prompts) {
    const flags: RunFlags = { ...job.flags, prompt, ...(sessionId ? { sessionId } : {}) };
    const run = await runForScripts(runtime, flags, writer);
    // Everything after the first request joins the conversation the first one made, so a script
    // reads as one job rather than as a handful of strangers.
    sessionId ??= run.sessionId;
    const step: HeadlessStep = { prompt, runId: run.id, status: run.status, exitCode: exitCodeFor(run.status) };
    steps.push(step);
    writer.line({ type: "headless.step", ...step });
    if (job.stopEarly && step.exitCode !== exitCodes.ok) break;
  }
  const exitCode = jobExitCode(steps);
  const summary = describe(steps, exitCode);
  writer.line({ type: "headless.finished", exitCode, steps: steps.length, summary });
  writer.note(summary);
  return { exitCode, steps, summary };
}

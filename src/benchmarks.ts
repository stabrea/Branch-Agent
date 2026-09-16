/**
 * Benchmarks: the public test sets researchers publish, read from files the owner already has on
 * this computer. Nothing here downloads anything. Each adapter knows one published file format,
 * turns it into tasks, sets up a folder for the assistant to work in, and decides afterwards
 * whether the work was right — by running the benchmark's own tests where it has them.
 *
 * Three benchmarks in wide use need a virtual machine or a live website and are honestly not
 * integrated; they are listed here with what they would need, rather than half-supported.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScoredTrajectory } from "./evaluation-scorers.js";

/** One task read out of a benchmark's own files. `raw` keeps the record exactly as it was read. */
export interface BenchmarkTask {
  id: string;
  prompt: string;
  /** The reference answer, when the benchmark ships one. */
  expected?: string | undefined;
  /** Short words for grouping: the level, the language, the repository. */
  tags: string[];
  raw: Record<string, unknown>;
}
/** A folder the assistant can work in, or the reason one could not be made. */
export interface PreparedTask {
  workspace: string;
  prompt: string;
  /** Files placed in the workspace for the task, relative to it. */
  files: string[];
  /** Why this task cannot be run on this computer, in plain words, or null when it can. */
  refusal: string | null;
}
/** What the assistant produced, handed to the adapter to be judged. */
export interface BenchmarkResult {
  answer: string;
  workspace: string;
  trajectory?: ScoredTrajectory | undefined;
}
export interface BenchmarkJudgement { pass: boolean; score: number; reasons: string[] }

export interface BenchmarkAdapter {
  readonly id: string;
  readonly name: string;
  /** What the adapter reads, so the documentation and the error messages agree with each other. */
  readonly format: string;
  /** Where the owner puts the files, relative to the benchmark folder. */
  readonly layout: string;
  discover(directory: string): Promise<BenchmarkTask[]>;
  prepare(task: BenchmarkTask, into: string, directory: string): Promise<PreparedTask>;
  judge(task: BenchmarkTask, result: BenchmarkResult, directory: string): Promise<BenchmarkJudgement>;
}

export const judgePass = (reason?: string): BenchmarkJudgement => ({ pass: true, score: 1, reasons: reason ? [reason] : [] });
export const judgeFail = (...reasons: string[]): BenchmarkJudgement => ({ pass: false, score: 0, reasons });

/**
 * Reads a JSON Lines file. Blank lines are skipped and a damaged line is reported with its number,
 * because a dataset of thousands of lines is otherwise impossible to fix.
 */
export async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  const out: Record<string, unknown>[] = [];
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    line++;
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw) as Record<string, unknown>); }
    catch { throw new Error(`${path} line ${line} is not readable JSON`); }
  }
  return out;
}

/** Every `.jsonl` file in a folder, sorted, so a benchmark split can be several files. */
export async function jsonlFiles(directory: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch { throw new Error(`There is no folder at ${directory}. Put the benchmark's files there first.`); }
  const found = names.filter((name) => name.endsWith(".jsonl")).sort();
  if (!found.length) throw new Error(`No .jsonl file in ${directory}. Put the benchmark's own file there, unchanged.`);
  return found.map((name) => join(directory, name));
}

/** A string field from a benchmark record, whichever of several names the publisher used. */
export function field(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = raw[name];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** A task id that the rest of the program will accept: lower case, letters, digits and dashes. */
export function safeId(value: string, fallback: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 60);
  return /^[a-z0-9]/.test(cleaned) ? cleaned : fallback;
}

/**
 * The benchmarks that are deliberately NOT integrated, with what each one would need. They are
 * named here rather than left out so nobody has to guess whether support exists.
 */
export const notIntegratedBenchmarks: readonly { id: string; name: string; needs: string }[] = [
  { id: "osworld", name: "OSWorld", needs: "A virtual machine running a full Linux desktop, with snapshots taken and rolled back between tasks. Branch Agent runs on this computer and has no way to make or restore one, so a score from it would not mean what the published scores mean." },
  { id: "windows-agent-arena", name: "WindowsAgentArena", needs: "A throwaway Windows virtual machine per task, with the arena's own images and its checkpoint scorer running inside it. Driving the owner's own desktop instead would neither be safe nor comparable." },
  { id: "waa-checkpoints", name: "WindowsAgentArena checkpoint scoring", needs: "The same virtual machine as WindowsAgentArena: the checkpoint scorer reads the machine's state directly, not the assistant's answer." },
  { id: "androidworld", name: "AndroidWorld", needs: "An Android emulator with the benchmark's apps installed, driven over ADB. There is no emulator on this computer and no way to install one from here." },
  { id: "browsergym-live", name: "BrowserGym live environments", needs: "The live WebArena, ServiceNow or Shopping sites the benchmark expects. Tasks that can be saved as ordinary pages are handled by the web-tasks adapter instead; the rest need those servers." },
];

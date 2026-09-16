/**
 * Running a benchmark's own tests. Benchmarks decide right and wrong by running the tests they
 * ship, so an adapter has to be able to start a program — but under exactly the same time, memory,
 * processor and output limits every other command on this computer gets, and with no way out to
 * the internet. Nothing here is reachable by the model: only an adapter calls it, and only once
 * the owner has switched on running programs (the same switch small scripts use).
 *
 * The program has to be named in full, and the environment carries no PATH, so nothing a dataset
 * says can decide which program on this computer is started.
 */
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ShellProcess } from "./integrations/shell-process.js";
import { netlessEnvironment } from "./integrations/shell-config.js";
import { defaultJobObjects, jobWithin, type JobObjects } from "./integrations/job-object.js";

export interface BenchmarkCommandLimits {
  timeoutMs: number; maxMemoryMb: number; maxCpuSeconds: number; maxOutputBytes: number;
}
/** What a benchmark's tests are allowed to use. Deliberately small; a test set is not a workload. */
export const benchmarkLimits: BenchmarkCommandLimits = {
  timeoutMs: 60_000, maxMemoryMb: 1024, maxCpuSeconds: 60, maxOutputBytes: 16_384,
};
export interface CommandOutcome {
  status: string; exitCode: number | null; stdout: string; stderr: string; durationMs: number;
}

/**
 * Starts one program in a folder and waits for it. The environment is emptied apart from what
 * Windows itself needs, and the proxy variables point at a dead address, so a test that tries to
 * reach the internet fails instead of quietly succeeding.
 */
export async function runBenchmarkCommand(
  executable: string, args: readonly string[], cwd: string,
  options: { signal?: AbortSignal; limits?: Partial<BenchmarkCommandLimits>; jobs?: JobObjects; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandOutcome> {
  if (!isAbsolute(executable))
    throw new Error(`A benchmark may only start a program named in full, and ${executable} is not. This is the same rule host commands follow.`);
  const limits = { ...benchmarkLimits, ...options.limits };
  const job = await jobWithin(options.jobs ?? defaultJobObjects(), { maxMemoryMb: limits.maxMemoryMb, maxCpuSeconds: limits.maxCpuSeconds }, 1500);
  const result = await new ShellProcess({
    executable, args: [...args], cwd,
    env: {
      PATH: "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", TEMP: process.env.TEMP ?? "",
      ...netlessEnvironment(), ...options.env,
    },
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes,
    maxMemoryMb: limits.maxMemoryMb, maxCpuSeconds: limits.maxCpuSeconds, ...(job ? { job } : {}),
  }).run();
  return {
    status: result.status, exitCode: result.exitCode, stdout: result.stdout,
    stderr: result.stderr, durationMs: result.durationMs,
  };
}

const bashCandidates = [
  "C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe", "/bin/bash", "/usr/bin/bash",
];
const gitCandidates = [
  "C:/Program Files/Git/cmd/git.exe", "C:/Program Files/Git/bin/git.exe",
  "C:/Program Files (x86)/Git/cmd/git.exe", "/usr/bin/git",
];
/**
 * Where a shell that can run a `tests.sh` lives, or null. `BRANCH_BASH` wins when it is set, so a
 * person whose Git is somewhere unusual can say where without editing anything.
 */
export const findBash = (): Promise<string | null> => firstProgram(process.env.BRANCH_BASH, bashCandidates);

/**
 * Where a Git that can move a copied repository to a commit lives, or null. `BRANCH_GIT` wins when
 * it is set. Nothing is ever fetched with it, so it is never given a credential helper.
 */
export const findGit = (): Promise<string | null> => firstProgram(process.env.BRANCH_GIT, gitCandidates);

async function firstProgram(named: string | undefined, candidates: readonly string[]): Promise<string | null> {
  for (const path of named ? [named, ...candidates] : candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path); return path; } catch { /* try the next place */ }
  }
  return null;
}

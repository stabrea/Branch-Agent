import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { cleanChildEnvironment } from "../child-env.js";
import type { WallContext } from "../sandbox.js";
import { openWall } from "../sandbox-backends.js";

/**
 * R17-D: how the coding parts start a program the owner already has — a formatter, the login shell
 * for a snapshot. Always an absolute path and an argument array, never a shell line built from text;
 * the environment is the short allowlist in src/child-env.ts; output is capped and the program is
 * stopped after a time limit. The runner is a parameter everywhere, so tests hand in a fake and
 * nothing on the owner's computer is started by a test.
 */
export interface ProgramRun {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Extra variables on top of the clean environment (a PATH, say). */
  env?: NodeJS.ProcessEnv;
  /** Text written to the program's input, then closed. */
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}
export interface ProgramResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export type ProgramRunner = (run: ProgramRun) => Promise<ProgramResult>;

const defaultCap = 1_048_576;

/** Starts the program for real. Only used outside tests. */
export const spawnProgram: ProgramRunner = (run) => new Promise((resolve, reject) => {
  if (!isAbsolute(run.executable)) { reject(new Error("A program is started only from its full address")); return; }
  const cap = run.maxOutputBytes ?? defaultCap;
  const child = spawn(run.executable, run.args, {
    cwd: run.cwd, env: { ...cleanChildEnvironment(), ...run.env }, shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], ...(run.signal ? { signal: run.signal } : {}),
  });
  const out: Buffer[] = [], err: Buffer[] = [];
  let outBytes = 0, errBytes = 0, timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => { if (outBytes < cap) { out.push(chunk); outBytes += chunk.length; } });
  child.stderr.on("data", (chunk: Buffer) => { if (errBytes < 65536) { err.push(chunk); errBytes += chunk.length; } });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, run.timeoutMs);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, timedOut, stdout: Buffer.concat(out).subarray(0, cap).toString("utf8"),
      stderr: Buffer.concat(err).subarray(0, 65536).toString("utf8") });
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(run.input ?? "");
});

/**
 * The same run behind the wall around programs when the task has one (src/sandbox-wall.ts), so a
 * formatter a task set off is held exactly as a command the task ran would be.
 */
export async function runWalled(runner: ProgramRunner, run: ProgramRun, wall: WallContext | undefined, workspace: string): Promise<ProgramResult> {
  if (!wall) return runner(run);
  const opened = await openWall(wall, { executable: run.executable, args: run.args, cwd: run.cwd,
    env: { ...cleanChildEnvironment(), ...run.env } }, { workspace });
  try {
    const result = await runner({ ...run, executable: opened.start.executable, args: opened.start.args, env: opened.start.env });
    const note = await opened.finish({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    return note ? { ...result, stderr: `${result.stderr}\n${note}`.trim() } : result;
  } finally {
    await opened.close();
  }
}

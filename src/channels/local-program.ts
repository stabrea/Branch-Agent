import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";

/**
 * The few pieces shared by the chat services that talk to a program the owner installed themselves
 * (Keybase, Delta Chat): check the program is really there before running anything, and start it
 * with an argument list, never a shell string. Tests hand in their own starter so no real program
 * is ever run.
 */
export interface RunningProgram {
  stdout: Readable;
  stdin: Writable;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}
export type ProgramStarter = (file: string, args: string[], env?: Record<string, string>) => RunningProgram;

export const startProgram: ProgramStarter = (file, args, env) => spawn(file, args, {
  stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false,
  ...(env ? { env: { ...process.env, ...env } } : {}),
});

/** True when the path is a file on this computer (and, outside Windows, one that may be run). */
export async function programInstalled(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  return platform === "win32" || (info.mode & 0o111) !== 0;
}

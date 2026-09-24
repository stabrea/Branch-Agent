import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { startCall } from "../windows-command.js";
import type { ShellConfig } from "./shell-config.js";

/**
 * Branch builds Branch (dogfood A2): with no command settings file, the desktop app had no way at all to run a
 * command on its own computer, so asked to fix its own code it could not even look at it. It now starts with the
 * everyday developer programs already installed here, each by its full address, so nothing that is not on this
 * computer is ever run. The owner's rules still decide whether each command is asked about; a settings file, when
 * there is one, replaces this list entirely.
 */
export const defaultPrograms = ["git", "node", "npm", "npx", "python", "gh"] as const;

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const runnable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return isFile(path); } catch { return false; } };

/** A program's full address and the arguments that must come first, or null when it is not installed here. */
export function locateProgram(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { path: string; args: string[] } | null {
  if (platform === "win32") {
    const start = startCall(name, [], env, platform);
    if (isAbsolute(start.command)) return { path: start.command, args: start.args };
    // An npm launcher is started as Node running its script; Node itself then needs its own full address.
    if (name === "node" || start.command !== "node" || !start.args.length) return null;
    const node = locateProgram("node", env, platform);
    return node ? { path: node.path, args: start.args } : null;
  }
  for (const folder of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    if (runnable(candidate)) return { path: candidate, args: [] };
  }
  return null;
}

/** The command settings Branch starts with when it has none, or null when none of the programs is installed. */
export function defaultShellConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ShellConfig | null {
  const executables: ShellConfig["executables"] = {};
  for (const name of defaultPrograms) {
    const found = locateProgram(name, env, platform);
    if (found) executables[name] = found;
  }
  if (!Object.keys(executables).length) return null;
  const home = env.HOME ?? env.USERPROFILE;
  return {
    executables,
    inheritEnv: ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USER", "LANG", "TZ"],
    // Git and npm find their settings from the home folder, which Windows names USERPROFILE.
    env: home && !env.HOME ? { HOME: home } : {},
    timeoutMs: 120_000, maxMemoryMb: 4096, maxCpuSeconds: 600, maxOutputBytes: 8192, netless: false, useJobObject: true,
  };
}

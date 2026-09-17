import { openWall, type OpenedWall, type WallDeps } from "../../sandbox-backends.js";
import type { WallContext } from "../../sandbox.js";
import type { NodeOs } from "./commands.js";

/**
 * mac7/nodes: `device.run` on a node goes behind that node's own wall — macOS's sandbox or Linux's
 * bubblewrap, built by the same code Branch uses for its own programs (src/sandbox-backends.ts).
 * On the node the wall is always at its tightest: no network at all, writes only inside the one
 * folder the owner chose, the node's own key folder unreadable, and nothing ever widened by a
 * question, because nobody is sitting at the node to answer one. Windows nodes do not offer `run`.
 */
export function nodeWallContext(hidden: readonly string[]): WallContext {
  return {
    network: "none", keySites: {}, unreadable: [...hidden], readOnly: [],
    answer: () => "deny", granted: () => [], spend: () => undefined,
  };
}

/** The environment a walled command sees: enough to find programs, nothing that carries a secret. */
export function plainEnvironment(env: NodeJS.ProcessEnv, folder: string): NodeJS.ProcessEnv {
  return { PATH: env.PATH ?? "/usr/bin:/bin", HOME: folder, TMPDIR: env.TMPDIR ?? "/tmp", LANG: env.LANG ?? "C.UTF-8" };
}

export async function walledCommand(
  os: NodeOs, folder: string, command: { executable: string; args: readonly string[] },
  options: { hidden: readonly string[]; env: NodeJS.ProcessEnv; deps?: WallDeps },
): Promise<OpenedWall> {
  if (os === "win32") throw new Error("Running commands is not offered on Windows devices, because Branch has no wall around a program there.");
  return openWall(nodeWallContext(options.hidden),
    { executable: command.executable, args: [...command.args], cwd: folder, env: plainEnvironment(options.env, folder) },
    { workspace: folder }, { ...options.deps, platform: os, dataDir: options.hidden[0] });
}

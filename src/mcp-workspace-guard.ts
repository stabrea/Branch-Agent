/**
 * eng-connectors review 2: the owner's yes to a server of their own is bound to its launch line (command, arguments,
 * folder, secret names), not to the bytes of the program that line runs. Anything inside the workspace can be rewritten
 * by a task that may write there, so a program there could be swapped after the yes and run, unsandboxed, as Branch
 * starts. The same rule own-clis and default-shell hold to: a server is refused when
 * - it would start in a folder inside the workspace (a bare name is then found there first: Windows looks in the
 *   folder before PATH, and `npx` looks in its node_modules/.bin);
 * - its program is inside the workspace (written as a path, or the first match on PATH);
 * - any argument, or the value of a `--name=value` argument, is an existing file inside the workspace;
 * - a program that runs a folder (node, python, npx…) is given a workspace folder as the thing to run.
 * Any other folder argument stays allowed, so a server pointed at the workspace (a filesystem server) still works.
 * Checked when a server is added and again before every start.
 */
import { statSync } from "node:fs";
import { basename, delimiter, isAbsolute, resolve } from "node:path";
import { inWorkspace } from "./integrations/default-shell.js";
import type { McpTransportConfig } from "./integrations/mcp-config.js";

export const workspaceFolderRefusal = "That server would start in a folder inside the workspace, where the assistant can write, "
  + "so a program found there could be one it put there. Branch does not start it. Choose a folder outside the workspace.";
export const workspaceProgramRefusal = "That program is inside the workspace, where the assistant can write, so Branch does not "
  + "start it. Give the full address of a program outside the workspace.";
export const workspaceFileRefusal = (name: string): string => `That server would run ${name}, a file inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep the file outside the workspace.";
export const workspaceEntryRefusal = (name: string): string => `That server would run the folder ${name}, inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep its program outside the workspace.";

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const isFolder = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
/**
 * Programs that run a folder given as their first argument: `node <dir>` runs its package's main file, `python <dir>` its
 * __main__.py, `npx <dir>` its package. There the folder is the program, so a workspace folder is refused. Anywhere else a
 * folder argument is data (a filesystem server's root) and stays allowed.
 */
const runsAFolder = new Set(["node", "bun", "deno", "python", "python3", "py", "npx", "uvx", "tsx"]);
const programName = (command: string): string => basename(command).toLowerCase().replace(/\.(exe|cmd)$/, "");
const pathLike = (text: string): boolean => isAbsolute(text) || /[\\/]/.test(text);
/** `--config=<file>` names a file as surely as `<file>` does. */
const valueOf = (arg: string): string | undefined => /^--?[^=\s]+=(.+)$/.exec(arg)?.[1];

/** The file a bare program name starts, the way the program starter finds it: the folder first on Windows, then PATH. */
function firstOnPath(name: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const windows = process.platform === "win32";
  const folders = ((windows ? env.PATH ?? env.Path : env.PATH) ?? "").split(delimiter).filter(Boolean);
  const endings = windows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const folder of windows ? [cwd, ...folders] : folders)
    for (const ending of endings) {
      const candidate = resolve(cwd, folder, `${name}${ending}`);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/** Why a server of the owner's may not be started from where it is, in plain words, or null when it may. */
export function workspaceRefusal(server: McpTransportConfig, workspace: string, env: NodeJS.ProcessEnv): string | null {
  if (server.transport !== "stdio") return null;
  const inside = (path: string): boolean => inWorkspace(workspace, path, process.platform);
  // With no folder of its own, a server starts in Branch's own folder, which is judged the same way.
  const cwd = resolve(server.cwd ?? process.cwd());
  if (inside(cwd)) return workspaceFolderRefusal;
  const program = pathLike(server.command) ? resolve(cwd, server.command) : firstOnPath(server.command, env, cwd);
  if (program && inside(program)) return workspaceProgramRefusal;
  const entry = runsAFolder.has(programName(server.command)) ? server.args.find((arg) => !arg.startsWith("-")) : undefined;
  if (entry && isFolder(resolve(cwd, entry)) && inside(resolve(cwd, entry))) return workspaceEntryRefusal(basename(resolve(cwd, entry)));
  for (const arg of server.args)
    for (const text of [arg, valueOf(arg)]) {
      if (!text || text.length > 1000) continue;
      const path = resolve(cwd, text);
      if (isFile(path) && inside(path)) return workspaceFileRefusal(basename(path));
    }
  return null;
}

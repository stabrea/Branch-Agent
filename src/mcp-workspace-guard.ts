/**
 * eng-connectors review 2: the owner's yes to a server of their own is bound to its launch line (command, arguments,
 * folder, secret names), not to the bytes of the program that line runs. Anything inside the workspace can be rewritten
 * by a task that may write there, so a program there could be swapped after the yes and run, unsandboxed, as Branch
 * starts. The same rule own-clis and default-shell hold to: a server is refused when
 * - it would start in a folder inside the workspace (a bare name is then found there first: Windows looks in the
 *   folder before PATH, and `npx` looks in its node_modules/.bin);
 * - its program is inside the workspace (written as a path, or the first match on PATH);
 * - any argument, or the value of a `--name=value` argument, is an existing file inside the workspace; a `file:` URL is
 *   read as the path it names (`node --import file:///…/srv.mjs`);
 * - a program that runs a folder (node, python, npx…) is given a workspace folder as the thing to run;
 * - it runs inline code that names a place inside the workspace: node's -e/--eval/-p/--print, python's -c, deno's
 *   eval, or a `data:` URL (`node --import data:text/javascript,…`);
 * - a package runner (npx, npm, uvx, uv, pip…) is told to take its package from inside the workspace: --package/-p,
 *   --prefix, --from, --with, --with-editable, --spec, and -e/--editable for pip and uv, as `--opt=value` or `--opt value`.
 * `cmd /c <program> …` is judged as that program as well (the unwrapping the malware check uses, package-launch.ts).
 * The code and package checks read text, not files: they refuse a written mention of the workspace, whether or not it
 * exists yet. Code that builds the path at run time (joined pieces of it, an environment variable, text it decodes
 * itself) is not caught.
 * Any other folder argument stays allowed, so a server pointed at the workspace (a filesystem server) still works.
 * Checked when a server is added and again before every start.
 */
import { statSync } from "node:fs";
import { basename, delimiter, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inWorkspace } from "./integrations/default-shell.js";
import { realFolder } from "./folder-trust.js";
import { unwrapCmd } from "./security-audit/package-launch.js";
import type { McpTransportConfig } from "./integrations/mcp-config.js";

export const workspaceFolderRefusal = "That server would start in a folder inside the workspace, where the assistant can write, "
  + "so a program found there could be one it put there. Branch does not start it. Choose a folder outside the workspace.";
export const workspaceProgramRefusal = "That program is inside the workspace, where the assistant can write, so Branch does not "
  + "start it. Give the full address of a program outside the workspace.";
export const workspaceFileRefusal = (name: string): string => `That server would run ${name}, a file inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep the file outside the workspace.";
export const workspaceEntryRefusal = (name: string): string => `That server would run the folder ${name}, inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep its program outside the workspace.";
export const workspaceCodeRefusal = "That server would run code that names a place inside the workspace, where the assistant "
  + "can write, so Branch does not start it. Keep what it runs outside the workspace.";
export const workspacePackageRefusal = "That server would take its package from inside the workspace, where the assistant can "
  + "write, so Branch does not start it. Keep the package outside the workspace.";

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const isFolder = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const windows = process.platform === "win32";
/**
 * Programs that run a folder given as their first argument: `node <dir>` runs its package's main file, `python <dir>` its
 * __main__.py, `npx <dir>` its package. There the folder is the program, so a workspace folder is refused. Anywhere else a
 * folder argument is data (a filesystem server's root) and stays allowed.
 */
const folderRunners = new Set(["node", "bun", "deno", "npx", "uvx", "tsx"]);
const nodeLike = new Set(["node", "bun", "deno", "tsx"]);
const isPython = (name: string): boolean => name === "py" || /^python(\d+(\.\d+)*)?w?$/.test(name);
/** Programs that fetch and run a package, and the options that say where from. */
const packageRunners = new Set(["npx", "npm", "pnpm", "pnpx", "bunx", "yarn", "uvx", "uv", "pip", "pip3", "pipx"]);
const packageOptions = ["--package", "-p", "--prefix", "--from", "--with", "--with-editable", "--spec"];
const editableRunners = new Set(["pip", "pip3", "uv", "uvx", "pipx"]);
/** The app's own program runs as Node (`runAsNode`, src/child-env.ts), so it is judged as node. */
const programName = (command: string): string =>
  command === process.execPath ? "node" : basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
const pathLike = (text: string): boolean => isAbsolute(text) || /[\\/]/.test(text);
/** `--config=<file>` names a file as surely as `<file>` does. */
const valueOf = (arg: string): string | undefined => /^--?[^=\s]+=([\s\S]+)$/.exec(arg)?.[1];

/**
 * The path a launch argument names: a `file:` URL is read as its path (a relative one against the folder, the way Node
 * and npm read `file:../pkg`), anything else is resolved against the folder. Null for a `file:` URL that names no path.
 */
function asPath(text: string, cwd: string): string | null {
  if (!/^file:/i.test(text)) return resolve(cwd, text);
  try { return fileURLToPath(new URL(text, pathToFileURL(cwd + sep))); } catch { return null; }
}

/** The file a bare program name starts, the way the program starter finds it: the folder first on Windows, then PATH. */
function firstOnPath(name: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const folders = ((windows ? env.PATH ?? env.Path : env.PATH) ?? "").split(delimiter).filter(Boolean);
  const endings = windows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const folder of windows ? [cwd, ...folders] : folders)
    for (const ending of endings) {
      const candidate = resolve(cwd, folder, `${name}${ending}`);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/** The text of a `data:` URL (what `node --import data:text/javascript,…` runs), or null for anything else. */
function dataText(text: string): string | null {
  const found = /^data:([^,]*),([\s\S]*)$/i.exec(text);
  if (!found) return null;
  if (/;base64$/i.test(found[1]!)) return Buffer.from(found[2]!, "base64").toString("utf8");
  try { return decodeURIComponent(found[2]!); } catch { return found[2]!; }
}

/** Python reads `-Ic code` and `-ccode` as -c: letters up to the c are switches, and -m/-W/-X/-Q take the rest as a value. */
function pythonCode(arg: string, next: string | undefined): string | undefined {
  if (!/^-[^-]/.test(arg)) return undefined;
  for (let at = 1; at < arg.length; at++) {
    if (arg[at] === "c") return arg.length > at + 1 ? arg.slice(at + 1) : next ?? "";
    if ("mWXQ".includes(arg[at]!)) return undefined;
  }
  return undefined;
}

/** Node's (and bun's, tsx's) -e/--eval/-p/--print, as the next argument, `--eval=code`, or in a cluster like `-pe`. */
function nodeCode(arg: string, next: string | undefined): string | undefined {
  const joined = /^(?:--eval|--print|-e|-p)=([\s\S]*)$/.exec(arg);
  if (joined) return joined[1];
  return /^(?:--eval|--print|-[a-zA-Z]*[ep][a-zA-Z]*)$/.test(arg) ? next ?? "" : undefined;
}

/** Every piece of inline code a launch runs. */
function inlineCode(name: string, args: readonly string[]): string[] {
  const code: string[] = [];
  args.forEach((arg, at) => {
    const next = args[at + 1];
    const found = nodeLike.has(name) ? nodeCode(arg, next) : isPython(name) ? pythonCode(arg, next) : undefined;
    if (found !== undefined) code.push(found);
    if (name === "deno" && arg === "eval" && next !== undefined) code.push(next);
    for (const text of [arg, valueOf(arg)]) {
      const data = text === undefined ? null : dataText(text);
      if (data !== null) code.push(data);
    }
  });
  return code;
}

/** Where a package runner is told to take its package from: `--opt=value`, `--opt value`, or `-pvalue`. */
function packageSources(name: string, args: readonly string[]): string[] {
  if (!packageRunners.has(name)) return [];
  const options = editableRunners.has(name) ? [...packageOptions, "-e", "--editable"] : packageOptions;
  const sources: string[] = [];
  args.forEach((arg, at) => {
    const option = options.find((known) => arg === known || arg.startsWith(`${known}=`) || (known.length === 2 && arg.startsWith(known)));
    if (!option) return;
    const rest = arg.slice(option.length).replace(/^=/, "");
    sources.push(rest || (args[at + 1] ?? ""));
  });
  return sources;
}

/** Text as compared for a mention: on Windows, `\\` (as written in a code string) and `\` read as `/`, in any case. */
const folded = (text: string): string => (windows ? text.replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase() : text);

/**
 * Whether text (code, or a package source) names the workspace or a place in it: the workspace's address written out,
 * followed by anything that cannot carry on a folder name, or a word in it that, read as a path from the folder the
 * server starts in, lands inside the workspace (`../ws/srv.mjs`, `file:../ws/pkg`, the file URL in `git+file:///…`).
 */
function namesWorkspace(text: string, cwd: string, workspace: string, inside: (path: string) => boolean): boolean {
  const said = folded(text);
  const forms = new Set([resolve(workspace), realFolder(workspace), pathToFileURL(resolve(workspace)).href]
    .map((form) => folded(form).replace(/[\\/]+$/, "")).filter(Boolean));
  for (const form of forms)
    for (let at = said.indexOf(form); at >= 0; at = said.indexOf(form, at + 1))
      if (!/[\p{L}\p{N}_.-]/u.test(said[at + form.length] ?? "")) return true;
  const words = new Set(text.split(/[\s'"`()[\]{},;+=@|&<>]+/).filter((word) => word && word.length <= 4096));
  for (const word of words) {
    const path = asPath(word, cwd);
    if (path && inside(path)) return true;
  }
  return false;
}

/**
 * The argument rules for one program and its arguments. `every` is each argument written, which the file rule reads
 * whether or not it belongs to the program named (for `cmd /c …`, cmd's own and the program's).
 */
function argumentRefusal(name: string, args: readonly string[], every: readonly string[], cwd: string, workspace: string,
  inside: (path: string) => boolean): string | null {
  const first = folderRunners.has(name) || isPython(name) ? args.find((arg) => !arg.startsWith("-")) : undefined;
  const entry = first === undefined ? null : asPath(first, cwd);
  if (entry && isFolder(entry) && inside(entry)) return workspaceEntryRefusal(basename(entry));
  for (const arg of every)
    for (const text of [arg, valueOf(arg)]) {
      if (!text || text.length > 1000) continue;
      const path = asPath(text, cwd);
      if (path && isFile(path) && inside(path)) return workspaceFileRefusal(basename(path));
    }
  const names = (text: string): boolean => namesWorkspace(text, cwd, workspace, inside);
  if (inlineCode(name, args).some(names)) return workspaceCodeRefusal;
  if (packageSources(name, args).some(names)) return workspacePackageRefusal;
  return null;
}

/** Why a server of the owner's may not be started from where it is, in plain words, or null when it may. */
export function workspaceRefusal(server: McpTransportConfig, workspace: string, env: NodeJS.ProcessEnv): string | null {
  if (server.transport !== "stdio") return null;
  const inside = (path: string): boolean => inWorkspace(workspace, path, process.platform);
  // With no folder of its own, a server starts in Branch's own folder, which is judged the same way.
  const cwd = resolve(server.cwd ?? process.cwd());
  if (inside(cwd)) return workspaceFolderRefusal;
  // `cmd /c npx …`, the usual way Windows settings start a server, is judged by the program after /c as well.
  const [command, args] = unwrapCmd(server.command, server.args);
  for (const each of new Set([server.command, command])) {
    const program = pathLike(each) ? resolve(cwd, each) : firstOnPath(each, env, cwd);
    if (program && inside(program)) return workspaceProgramRefusal;
  }
  return argumentRefusal(programName(command), args, [...new Set([...server.args, ...args])], cwd, workspace, inside);
}

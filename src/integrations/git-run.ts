import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellProcess, type ProcessResult } from "./shell-process.js";
import { posixEnvironment } from "./shell-config.js";

/**
 * Runs the copy of Git already installed on this computer. The program is found once with
 * `where git` (`which git` elsewhere) and then always started from that exact path, never through
 * a shell. Repository hooks are switched off, the folder is marked safe for this run, and Git is
 * told never to stop and ask for a password, so a command can never hang waiting for a person.
 */
export type GitLocator = () => Promise<string | null>;
export interface GitRunOptions { cwd: string; args: string[]; timeoutMs?: number; maxOutputBytes?: number }
export interface GitOutcome extends ProcessResult { command: string }
/** Q98: a branch as the full ref Git pushes and walks alike (`HEAD` and a ref already written in full stay as they are). */
export const branchRef = (branch: string): string => (branch === "HEAD" || branch.startsWith("refs/") ? branch : `refs/heads/${branch}`);

const NO_HOOKS = join(tmpdir(), "branch-hooks-disabled-does-not-exist");
const NO_GRAFTS = join(tmpdir(), "branch-grafts-disabled-does-not-exist");
/** Q192: a global-config path that is not there, so the folder's own drivers are read without the owner's own. */
const NO_GLOBAL_CONFIG = join(tmpdir(), "branch-global-config-does-not-exist");
const KEEP_ENV = ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA", "LANG", "LC_ALL", "TZ"];

/** Git's own environment: the little it needs from the host, plus settings that keep it silent. */
export function gitEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of KEEP_ENV) {
    const entry = Object.entries(source).find(([name]) => name.toUpperCase() === key);
    if (entry?.[1]) result[key] = entry[1];
  }
  // macOS and Linux: where temporary files go, who is signed in, and the key agent ssh remotes use.
  Object.assign(result, posixEnvironment(["TMPDIR", "USER", "LOGNAME", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME"], source, platform));
  return { ...result, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", NO_COLOR: "1", GCM_INTERACTIVE: "never" };
}

/**
 * Q12, Q192: settings a repository's own `.git/config` could use to make Git start a program, each
 * pinned to a harmless value. `-c` outranks every config file, and Git hands these to the Git
 * processes it starts itself (a submodule's), so a folder a task wrote cannot run anything through
 * them. These are the settings with a FIXED name. The named drivers a repository can also define —
 * `filter.<name>.clean/smudge/process`, `diff.<name>.textconv` and `merge.<name>.driver`, which Git
 * runs during an everyday status, diff, checkout or merge — have a name Branch cannot know ahead of
 * time, so they are read from the folder itself and switched off per run instead (see
 * `driverNeutralisers` and `GitRunner.run`). Together the fixed-name pins here and the per-run driver
 * switches cover the settings a repository's own config could use to start a program, with one
 * setting left to the callers: a per-driver external diff, `diff.<name>.command`, is not emptied here.
 * `diff.external` (the one external diff with a fixed name) names `false`, which stops that program
 * loudly; `diff.<name>.command` still runs on a plain `git diff`, so it is kept off by every
 * patch-producing Git call passing `--no-ext-diff` (git.ts's `noPrograms`) — a new patch-producing
 * caller must pass it too. The owner's own sign-in (credential helpers, askPass, sshCommand, the
 * computer-wide config file where macOS keeps its keychain helper) is left alone: Branch's pushes use
 * it, and the folder's own drivers are read with the owner's global and system config left out, so
 * their own filters and merge drivers keep working for a folder no task touched. A folder whose own
 * filter is `required` (or whose merge driver is emptied by the pin) makes the affected Git command
 * fail closed — no program runs — rather than pass the content through.
 */
export const pinnedGitConfig: readonly string[] = [
  "core.fsmonitor=false", "core.pager=cat", "core.editor=:", "sequence.editor=:", "diff.external=false", "protocol.ext.allow=never",
];

/**
 * Q12: more pins, only for Git run inside Branch's own source (`branch-agent-source`), where the
 * owner's preferences matter less than what a self-development task could have left behind:
 * signing programs, submodules and a bare repository found by walking up. Replacement objects and
 * the commit-graph file are explained with `pinnedEnvironmentInSource` below.
 */
export const pinnedInSource: readonly string[] = [
  "commit.gpgSign=false", "tag.gpgSign=false", "gpg.program=false", "submodule.recurse=false", "diff.ignoreSubmodules=all",
  "core.gitProxy=", "safe.bareRepository=explicit", "protocol.file.allow=never",
  "core.useReplaceRefs=false", "core.commitGraph=false",
];

/**
 * Inside Branch's own source, Git reads every commit as it is stored, which is what a push sends.
 * Replacement objects (`refs/replace/`) and grafts (`info/grafts`) can each make Git show a commit
 * with other parents or another tree, so neither is used there. Replacements are turned off both by
 * GIT_NO_REPLACE_OBJECTS and by `core.useReplaceRefs=false` in `pinnedInSource`, so a repository's
 * own `core.useReplaceRefs` cannot turn them back on. Grafts have no setting, so they are read from a
 * file that is not there. Git skips its commit-graph file (a saved copy of each commit's parents and
 * tree) while replacements or grafts are in use, so with both off it would read that file again;
 * `core.commitGraph=false` in `pinnedInSource` keeps it unread.
 */
const pinnedEnvironmentInSource: Readonly<Record<string, string>> = { GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: NO_GRAFTS };
export const inBranchSource = (cwd: string): boolean => {
  try {
    const resolved = realpathSync.native(cwd);
    return /(^|[\\/])branch-agent-source([\\/\.\s]|$)/i.test(resolved);
  } catch {
    return /(^|[\\/])branch-agent-source([\\/\.\s]|$)/i.test(cwd);
  }
};

/** Settings forced on every call; they come before the subcommand so no repository can override them. */
export function hardening(cwd: string, inSource = inBranchSource(cwd)): string[] {
  const pins = inSource ? [...pinnedGitConfig, ...pinnedInSource] : pinnedGitConfig;
  return ["-c", `safe.directory=${cwd}`, "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.quotepath=false",
    "-c", "credential.interactive=never", ...pins.flatMap((setting) => ["-c", setting]), "--no-pager"];
}

/**
 * Q192: the driver settings a folder's own config can carry, read so their name is known: a clean,
 * smudge or process filter, a diff textconv, and a merge driver. A `.gitattributes` picks one of
 * these by name and Git then starts the program it points to — during a plain status, diff, checkout
 * or a branch merge, not only a command a task wrote. Only `merge.<name>.driver` in the merge family
 * names a program: `merge.<name>.name` is a label, and `merge.<name>.recursive` names another driver
 * (whose own `.driver` is caught by this same pattern), not a program. The config sources a task could
 * write (local config, `config.worktree`, files these include) are all covered by reading the folder
 * itself; the query runs with the owner's global and system config left out (`GIT_CONFIG_NOSYSTEM`, a
 * `GIT_CONFIG_GLOBAL` that is not there), so a driver the owner set for themselves is not read here
 * and keeps working for a folder no task touched.
 */
const DRIVER_KEY_PATTERN = "^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.textconv|merge\\..*\\.driver)$";

/**
 * Q192: the subcommands that can run a `diff.<name>.textconv` program and accept `--no-textconv`.
 * `--no-textconv` (name-independent) switches textconv off for these, so a textconv driver never needs
 * emptying by name and its name is never a reason to refuse. `diff`/`log`/`show` and their kin, and
 * `blame`/`annotate`, run textconv on their own; `grep` runs it only when the caller passes
 * `--textconv`. The injected `--no-textconv` sits right after the subcommand, so a caller's own later
 * `--textconv` (a deliberate opt-in) still wins; no Branch caller passes one. `cat-file --textconv`
 * runs textconv but has no `--no-textconv` option, so it is not listed (and `git.ts` runs `cat-file`
 * only with `-e`, never `--textconv`). No Branch caller runs `blame`, `annotate`, `grep` or `cat-file`
 * through `GitRunner` today; they are listed so a later caller is covered.
 */
export const TEXTCONV_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "diff", "diff-files", "diff-index", "diff-tree", "log", "show", "whatchanged", "reflog", "format-patch", "range-diff", "grep",
  "blame", "annotate",
]);

/**
 * Q192: from the NUL-separated `git config --get-regexp` reply for the driver keys, the neutralisers
 * for the drivers a folder's own config defines. A clean/smudge/process filter runs during an everyday
 * status, add, diff or checkout whatever flags are passed, and a merge driver runs during a branch
 * merge, so each is emptied by name with a `-c` setting: an empty filter command passes content
 * through unchanged, and an empty merge driver command makes Git fail the merge closed (it starts no
 * program and leaves the file unmerged) rather than run one. `textconv` is instead reported as a flag
 * on the result, because it runs only for the subcommands above and is switched off by `--no-textconv`,
 * which does not depend on the driver's name. `null` when a FILTER or MERGE name carries `=`, which
 * `-c name=value` reads as the value separator, so that driver cannot be emptied by name: the caller
 * then refuses to run Git in the folder rather than run it with the driver still live. A textconv name
 * with `=` is fine — `--no-textconv` covers it.
 */
export function driverNeutralisers(reply: string): { pins: string[]; textconv: boolean } | null {
  const filters = new Set<string>();
  const merges = new Set<string>();
  let textconv = false;
  for (const record of reply.split("\0")) {
    if (!record) continue;
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    const filterName = /^filter\.(.+)\.(?:clean|smudge|process)$/.exec(key)?.[1];
    const mergeName = /^merge\.(.+)\.driver$/.exec(key)?.[1];
    if (filterName !== undefined) {
      if (filterName.includes("=")) return null;
      filters.add(filterName);
    } else if (mergeName !== undefined) {
      if (mergeName.includes("=")) return null;
      merges.add(mergeName);
    } else if (/^diff\..+\.textconv$/.test(key)) {
      textconv = true;
    }
  }
  const pins: string[] = [];
  for (const name of filters) pins.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`);
  for (const name of merges) pins.push("-c", `merge.${name}.driver=`);
  return { pins, textconv };
}

/** Q192: the plain reason Git is not run in a folder whose own settings name a filter or merge driver Branch cannot switch off. */
export const undisarmableDriver = "This folder's Git settings name a filter or merge driver Branch cannot switch off safely, so Git did not run here.";

/**
 * Q192: `--no-textconv` placed just after the subcommand, when the folder's own config has a textconv
 * driver and the subcommand can run one and does not already say so. The change is shown as Git reads
 * it, and no textconv program is started. Left untouched otherwise, so a command that runs no textconv
 * (or one Branch already marks, as src/integrations/git.ts does) keeps its arguments exactly.
 */
export function withNoTextconv(args: readonly string[], textconv: boolean): string[] {
  if (!textconv) return [...args];
  const at = args.findIndex((argument) => !argument.startsWith("-"));
  if (at < 0 || !TEXTCONV_SUBCOMMANDS.has(args[at]!) || args.includes("--no-textconv")) return [...args];
  return [...args.slice(0, at + 1), "--no-textconv", ...args.slice(at + 1)];
}

let located: Promise<string | null> | undefined;
/** Asks the operating system where Git is, once per launch. */
export async function locateGit(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return (located ??= findGitOn(env));
}
/** How Git is looked for: `where git` on Windows, `command -v git` (no extension) elsewhere. */
export function gitFinder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { executable: string; args: string[] } {
  if (platform === "win32") return { executable: join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "where.exe"), args: ["git"] };
  return { executable: "/bin/sh", args: ["-c", "command -v git"] };
}
type LineReader = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string[]>;
export async function findGitOn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, lines: LineReader = firstLines): Promise<string | null> {
  const windows = platform === "win32";
  const finder = gitFinder(platform, env);
  for (const line of (await lines(finder.executable, finder.args, env)).slice(0, 5)) {
    const candidate = line.trim().replace(/^"|"$/g, "");
    if (!candidate || (windows && !/\.exe$/i.test(candidate)) || (!windows && !candidate.startsWith("/"))) continue;
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) return candidate;
  }
  return null;
}
function firstLines(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((resolve) => {
    let output = "";
    const done = (value: string[]) => { clearTimeout(timer); resolve(value); };
    const child = spawn(executable, args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve([]); }, 5000);
    child.stdout.on("data", (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString("utf8"); });
    child.once("error", () => done([]));
    child.once("close", () => done(output.split(/\r?\n/)));
  });
}

/** Q192: a Git run that never started, because the folder's own settings named a driver Branch could not switch off. */
function refusedGit(command: string, message: string): GitOutcome {
  return {
    status: "failed", stdout: "", stderr: `fatal: ${message}`, exitCode: 128, signal: null,
    durationMs: 0, truncated: false, observedOutputBytes: 0,
    usage: { peakMemoryMb: 0, cpuSeconds: 0 }, isolation: "sampling",
    cleanup: { status: "parent_exited", strategy: "none", limitation: "" }, command,
  };
}

export class GitRunner {
  constructor(private readonly options: { locate?: GitLocator; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {}
  /** The absolute path of Git, or a plain explanation that it is not installed. */
  async executable(): Promise<string> {
    const found = await (this.options.locate ?? (() => locateGit(this.options.env)))();
    if (!found) throw new Error("Git is not installed on this computer. Install Git, then ask me again.");
    return found;
  }
  async run(options: GitRunOptions, signal: AbortSignal): Promise<GitOutcome> {
    const executable = await this.executable();
    // Decided once, so the settings and the environment always agree on whether this is Branch's source.
    const inSource = inBranchSource(options.cwd);
    const env = { ...gitEnvironment(this.options.env), ...(inSource ? pinnedEnvironmentInSource : {}) };
    const command = options.args.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ");
    // Q192: switch off any clean/smudge/process filter, diff textconv or merge driver the folder's own
    // config defines, so this run starts no program through one; refuse the run if one cannot be switched off.
    const disarm = await this.driverPins(executable, options.cwd, inSource, env, signal);
    if (disarm === null) return refusedGit(command, undisarmableDriver);
    const userArgs = withNoTextconv(options.args, disarm.textconv);
    const args = [...hardening(options.cwd, inSource), ...disarm.pins, ...userArgs];
    const result = await new ShellProcess({
      executable, args, cwd: options.cwd, env, signal,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30000,
      maxOutputBytes: options.maxOutputBytes ?? 65536, maxMemoryMb: 2048, maxCpuSeconds: 120,
    }).run();
    return { ...result, command };
  }

  /**
   * Q192: the `-c` settings that switch off the folder's own filter, diff and merge drivers, read with
   * the owner's global and system config left out. `null` means one cannot be switched off safely (its
   * name carries `=`, or its settings could not be read whole), so the caller refuses to run Git here.
   * The query runs Git directly (not through `run`, which would call this again) and starts no program:
   * `git config` only reads settings.
   */
  private async driverPins(executable: string, cwd: string, inSource: boolean, baseEnv: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ pins: string[]; textconv: boolean } | null> {
    const args = [...hardening(cwd, inSource), "config", "--null", "--get-regexp", DRIVER_KEY_PATTERN];
    const env = { ...baseEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_GLOBAL_CONFIG };
    const reply = await new ShellProcess({
      executable, args, cwd, env, signal, timeoutMs: this.options.timeoutMs ?? 30000,
      maxOutputBytes: 1_048_576, maxMemoryMb: 2048, maxCpuSeconds: 30,
    }).run();
    // Reading more than a megabyte of driver settings, or being stopped for a resource, leaves Branch
    // unsure it saw every driver, so it does not run Git here. A resource stop reads the same config
    // the real run would; a genuine config or "not a repository" error (exit 128) stops the real run too.
    if (reply.truncated || reply.status === "timed_out" || reply.status === "output_limit" || reply.status === "memory_limit" || reply.status === "cpu_limit") return null;
    if (reply.status !== "completed") return { pins: [], textconv: false };
    if (reply.exitCode === 1) return { pins: [], textconv: false }; // Git's answer for "no such settings".
    if (reply.exitCode !== 0) return { pins: [], textconv: false }; // e.g. not a repository (128): the real run fails the same way, running nothing.
    return driverNeutralisers(reply.stdout);
  }
}

const PLAIN: [RegExp, string][] = [
  [/not a git repository|does not appear to be a git repo/i, "This folder is not a repository yet. Ask me to start one, or pick a folder that already has one."],
  [/unmerged|you have unresolved conflicts|fix conflicts/i, "There are unmerged changes from an earlier merge. Those files need to be sorted out before this will work."],
  [/please tell me who you are|empty ident|unable to auto-detect email/i, "Git does not know your name and email address yet. Set those once in Git, then try again."],
  [/dubious ownership/i, "This folder belongs to another Windows account, so Git will not touch it."],
  [/authentication failed|could not read username|terminal prompts disabled|invalid username or (password|token)/i, "The sign-in was not accepted. Check the GitHub token saved in your secrets."],
  [/non-fast-forward|fetch first|updates were rejected/i, "The copy on the server has changes yours does not. Bring those down first, then send yours."],
  [/pathspec .* did not match|unknown revision|bad revision/i, "I could not find that file, branch or revision in this repository."],
  [/a branch named .* already exists|branch .* already exists/i, "There is already a branch with that name."],
  [/already exists|is already (registered|used) by/i, "Something with that name is already there."],
  [/could not resolve host|unable to access|connection (timed out|refused)/i, "I could not reach the server. Check the internet connection and try again."],
  [/no such file or directory|cannot chdir/i, "That folder does not exist."],
];

/** Turns Git's own wording into something a non-technical person can act on. */
export function explainGit(result: Pick<GitOutcome, "status" | "stderr" | "stdout">): string {
  if (result.status === "timed_out") return "Git took too long and was stopped.";
  if (result.status === "cancelled") return "The task was stopped before Git finished.";
  if (result.status === "output_limit") return "Git produced more output than fits here; ask for a smaller range.";
  const text = `${result.stderr}\n${result.stdout}`;
  for (const [pattern, message] of PLAIN) if (pattern.test(text)) return message;
  const line = result.stderr.split("\n").map((value) => value.replace(/^(fatal|error):\s*/i, "").trim()).find(Boolean);
  return line ? `Git could not do that: ${line.slice(0, 300)}` : "Git could not do that.";
}

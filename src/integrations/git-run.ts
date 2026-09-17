import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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

const NO_HOOKS = join(tmpdir(), "branch-hooks-disabled-does-not-exist");
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

/** Settings forced on every call; they come before the subcommand so no repository can override them. */
function hardening(cwd: string): string[] {
  return ["-c", `safe.directory=${cwd}`, "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "core.quotepath=false",
    "-c", "credential.interactive=never", "--no-pager"];
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
    const args = [...hardening(options.cwd), ...options.args];
    const result = await new ShellProcess({
      executable, args, cwd: options.cwd, env: gitEnvironment(this.options.env), signal,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30000,
      maxOutputBytes: options.maxOutputBytes ?? 65536, maxMemoryMb: 2048, maxCpuSeconds: 120,
    }).run();
    return { ...result, command: options.args.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ") };
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

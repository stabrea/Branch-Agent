import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { errorText, type ToolContext } from "../contracts.js";
import { refuseSignInForTrunk } from "../accounts/context.js";
import { primaryAccount, savedAccountsSettings } from "../accounts/settings.js";
import { accountHomeVariables, strippedEnvironment } from "../providers/cli-agent.js";
import type { ToolRegistry } from "../registry.js";
import { globFits, worktreeOf, type ContractBook } from "../self-development-contract.js";
import type { Store } from "../store.js";
import type { GitOutcome, GitRunOptions } from "../integrations/git-run.js";

/**
 * Handing a coding job to Claude Code or Codex, the programs the owner signed in to with their own plans, so the
 * work is done by the program itself inside one folder: it reads, edits and runs the checks there, and Branch gets
 * back what it did. Elsewhere Branch only asks these programs for words (src/providers/cli-agent.ts,
 * src/asks/codex-app-server.ts, both read-only); this is the one door where they may change files, and it is
 * held three ways:
 * - Each program's own limits: Codex runs with `--sandbox workspace-write` in the folder; Claude Code runs with
 *   `--permission-mode acceptEdits` in the folder, and the only commands it may run are the ones listed here.
 * - Branch's own check afterwards: every file the job changed is listed against where it started, and inside
 *   Branch's own source (a self-development worktree) anything outside the contract's allowed paths is put back
 *   and named, so the contract holds whatever the program did. Sending still goes through the contract's push check.
 * - It is the owner's sign-in, so a Trunk or somebody else on this computer never reaches it.
 */

export const handOffPrograms = ["claude-code", "codex"] as const;
export type HandOffProgram = (typeof handOffPrograms)[number];

export const HandOffInputSchema = z.object({
  program: z.enum(handOffPrograms),
  /** The folder, from the workspace, the job is done in. It must be a Git repository, so what changed can be told. */
  folder: z.string().trim().min(1).max(400),
  task: z.string().trim().min(1).max(20_000),
  /** Which of the owner's accounts for that program; absent means its usual sign-in. */
  account: z.string().trim().min(1).max(64).optional(),
  minutes: z.number().int().min(1).max(120).default(30),
}).strict();
export type HandOffInput = z.infer<typeof HandOffInputSchema>;

/** The commands Claude Code may run by itself in the folder: the checks and read-only Git, nothing that sends. */
export const claudeAllowedCommands = [
  "Bash(node --test:*)", "Bash(npm run build)", "Bash(npm run build:*)", "Bash(npx tsc:*)",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)",
];

export interface ProgramCall { command: string; args: string[]; cwd: string }
export function programCall(program: HandOffProgram, folder: string): ProgramCall {
  if (program === "claude-code")
    return { command: "claude", cwd: folder, args: ["-p", "--output-format", "stream-json", "--verbose",
      "--permission-mode", "acceptEdits", "--allowedTools", ...claudeAllowedCommands] };
  return { command: "codex", cwd: folder, args: ["exec", "--json", "--sandbox", "workspace-write", "--cd", folder, "-"] };
}

export interface ProgramRun { code: number | null; lines: string[]; stderr: string; timedOut: boolean; missing: boolean }
export type RunProgram = (call: ProgramCall, prompt: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
  timeoutMs: number, onLine: (line: string) => void) => Promise<ProgramRun>;

export const runProgram: RunProgram = (call, prompt, env, signal, timeoutMs, onLine) => new Promise((done) => {
  const child = spawn(call.command, call.args, { cwd: call.cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const lines: string[] = [];
  let pending = "", stderr = "", timedOut = false, settled = false;
  const finish = (code: number | null, missing = false): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (pending.trim()) { lines.push(pending); onLine(pending); }
    done({ code, lines, stderr, timedOut, missing });
  };
  const stop = (): void => { child.kill(); finish(null); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) if (line.trim() && lines.length < 20_000) { lines.push(line); onLine(line); }
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString("utf8"); });
  child.on("error", (error: NodeJS.ErrnoException) => finish(1, error.code === "ENOENT"));
  child.on("close", (code) => finish(code));
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
});

/** What a program's stream said: its last words, the steps it took, and whether its plan's limit stopped it. */
export interface ProgramReport { summary: string; steps: string[]; failed: string | null; limitReached: boolean }
const limitWords = /usage limit|rate limit|limit reached|quota exceeded|exceeded your (?:current )?quota|too many requests/i;
const parse = (line: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(line) as unknown; return value && typeof value === "object" ? value as Record<string, unknown> : null; }
  catch { return null; }
};

/** Claude Code's `stream-json`: assistant messages with text and tool uses, then one `result`. */
export function readClaude(lines: readonly string[]): ProgramReport {
  const steps: string[] = [];
  let summary = "", failed: string | null = null;
  for (const event of lines.map(parse)) {
    if (!event) continue;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content))
      for (const part of content as { type?: string; text?: string; name?: string }[]) {
        if (part.type === "text" && part.text) summary = part.text;
        if (part.type === "tool_use" && part.name) steps.push(part.name);
      }
    if (event.type === "result") {
      if (typeof event.result === "string" && event.result) summary = event.result;
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success"))
        failed = typeof event.result === "string" && event.result ? event.result : String(event.subtype ?? "failed");
    }
  }
  return { summary, steps, failed, limitReached: limitWords.test(failed ?? "") };
}

/** Codex's `exec --json`: items as they complete (its words, the commands it ran, the files it changed), then the turn. */
export function readCodex(lines: readonly string[]): ProgramReport {
  const steps: string[] = [];
  let summary = "", failed: string | null = null;
  for (const event of lines.map(parse)) {
    if (!event) continue;
    const item = event.item as { type?: string; text?: string; command?: string } | undefined;
    if (event.type === "item.completed" && item?.type === "agent_message" && item.text) summary = item.text;
    if (event.type === "item.completed" && item?.type === "command_execution" && item.command) steps.push(item.command);
    if (event.type === "item.completed" && item?.type === "file_change") steps.push("file change");
    if (event.type === "turn.failed" || event.type === "error") {
      const error = (event.error as { message?: string } | undefined)?.message ?? (event.message as string | undefined);
      failed = error ?? "failed";
    }
  }
  return { summary, steps, failed, limitReached: limitWords.test(failed ?? "") };
}

export interface HandOffDeps {
  store: Store;
  owner: string;
  workspace: string;
  dataDir: string;
  book: ContractBook;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
  run?: RunProgram;
}

export interface HandOffResult {
  program: HandOffProgram;
  account: string;
  status: "done" | "failed" | "limit reached" | "stopped" | "timed out";
  summary: string;
  steps: string[];
  changed: string[];
  undone: string[];
}

export class HandOff {
  constructor(private readonly deps: HandOffDeps) {}

  /** The folder from the workspace, refused when it leaves the workspace or is not a Git repository. */
  folderOf(folder: string): { absolute: string; fromWorkspace: string } {
    const absolute = resolve(this.deps.workspace, folder);
    const fromWorkspace = relative(this.deps.workspace, absolute).split(sep).join("/");
    if (fromWorkspace.startsWith("..") || resolve(fromWorkspace) === fromWorkspace)
      throw new Error("The folder must be inside the workspace.");
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`There is no folder ${fromWorkspace} in the workspace.`);
    if (!existsSync(join(absolute, ".git"))) throw new Error(`${fromWorkspace} is not a Git repository, so what the job changed could not be told.`);
    return { absolute, fromWorkspace };
  }

  /** The environment the program gets: only what it needs, with the chosen account's own folder. */
  environment(program: HandOffProgram, account: string): NodeJS.ProcessEnv {
    if (account === primaryAccount) return strippedEnvironment();
    const pool = `cli-${program}`;
    const saved = savedAccountsSettings(this.deps.store, this.deps.owner)?.pools.find((one) => one.pool === pool);
    if (!saved?.accounts.some((one) => one.id === account))
      throw new Error(`There is no ${program === "codex" ? "Codex" : "Claude Code"} account called "${account}" in Settings › Accounts.`);
    return { ...strippedEnvironment(), [accountHomeVariables[program]!]: join(this.deps.dataDir, "accounts", pool, account) };
  }

  private async gitText(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    const outcome = await this.deps.git({ cwd, args, timeoutMs: 30_000 }, signal);
    if (outcome.status !== "completed") throw new Error(`git ${args[0]} did not finish: ${outcome.stderr.trim().slice(0, 300)}`);
    return outcome.stdout;
  }

  /** Every file that differs from `start` now, committed or not, tracked or new. */
  async changedSince(cwd: string, start: string, signal: AbortSignal): Promise<{ tracked: string[]; added: string[] }> {
    const tracked = (await this.gitText(cwd, ["diff", "--name-only", "--no-renames", start], signal)).split("\n").filter(Boolean);
    const added = (await this.gitText(cwd, ["ls-files", "--others", "--exclude-standard"], signal)).split("\n").filter(Boolean);
    return { tracked, added };
  }

  /** Inside Branch's own source, the contract's allowed paths decide; anything else the job changed is put back. */
  async keepToContract(folder: { absolute: string; fromWorkspace: string }, start: string, changed: { tracked: string[]; added: string[] },
    signal: AbortSignal): Promise<string[]> {
    const worktree = worktreeOf(folder.fromWorkspace);
    if (!worktree) return [];
    const contract = this.deps.book.current(this.deps.owner, worktree);
    const inside = folder.fromWorkspace.slice(worktree.length).replace(/^\//, "");
    const allowed = (file: string): boolean =>
      !!contract && contract.allowedPaths.some((pattern) => globFits(pattern, inside ? `${inside}/${file}` : file));
    const undoTracked = changed.tracked.filter((file) => !allowed(file));
    const undoAdded = changed.added.filter((file) => !allowed(file));
    if (undoTracked.length) await this.gitText(folder.absolute, ["checkout", start, "--", ...undoTracked], signal);
    for (const file of undoAdded) await rm(join(folder.absolute, file), { force: true });
    return [...undoTracked, ...undoAdded];
  }

  async run(input: HandOffInput, context: ToolContext): Promise<HandOffResult> {
    refuseSignInForTrunk();
    this.deps.store.profiles.requireOwner("Handing a job to your Claude Code or Codex");
    if (context.agent) throw new Error("Handing a job to the owner's Claude Code or Codex is the owner's own; a specialist cannot.");
    const folder = this.folderOf(input.folder), account = input.account ?? primaryAccount;
    const env = this.environment(input.program, account);
    const start = (await this.gitText(folder.absolute, ["rev-parse", "--verify", "HEAD"], context.signal)).trim();
    let shown = 0;
    const onLine = (line: string): void => {
      if (shown++ < 200) this.deps.store.event(context.runId, "code.hand_off.step", { program: input.program, line: line.slice(0, 500) });
    };
    const ran = await (this.deps.run ?? runProgram)(programCall(input.program, folder.absolute), input.task, env,
      context.signal, input.minutes * 60_000, onLine);
    if (ran.missing) throw new Error(`"${programCall(input.program, folder.absolute).command}" is not installed on this computer.`);
    const report = input.program === "codex" ? readCodex(ran.lines) : readClaude(ran.lines);
    const changed = await this.changedSince(folder.absolute, start, AbortSignal.timeout(60_000));
    const undone = await this.keepToContract(folder, start, changed, AbortSignal.timeout(60_000));
    const status: HandOffResult["status"] = context.signal.aborted ? "stopped" : ran.timedOut ? "timed out"
      : report.limitReached ? "limit reached" : report.failed || ran.code !== 0 ? "failed" : "done";
    const result: HandOffResult = { program: input.program, account, status,
      summary: (report.summary || report.failed || ran.stderr.trim()).slice(0, 4000), steps: report.steps.slice(-40),
      changed: [...changed.tracked, ...changed.added].filter((file) => !undone.includes(file)), undone };
    this.deps.store.event(context.runId, "code.hand_off", { ...result, summary: result.summary.slice(0, 500) });
    return result;
  }
}

export function registerHandOff(registry: ToolRegistry, handOff: HandOff): void {
  registry.register({
    name: "code.hand_off", permission: "code.handoff", group: "code",
    description: "Give a coding job to the owner's Claude Code or Codex, signed in with the owner's own plan, to do inside one "
      + "folder of the workspace that is a Git repository: the program reads, edits and runs the checks there, and this answers "
      + "with what it did and which files changed. Choose the account from Settings › Accounts, or leave it out for the usual one. "
      + "When the answer says the plan's limit was reached, try another account. Inside Branch's own source, anything the job "
      + "changed outside the contract's allowed paths is put back and named.",
    parameters: HandOffInputSchema,
    // The program may change anything in the folder, so a rule about any folder inside it counts; inside Branch's
    // own source the contract must cover the whole folder, and is held again file by file afterwards.
    targets: (args) => [{ kind: "write", path: args.folder, folder: true }],
    execute: async (args, context) => {
      try { return await handOff.run(args, context); }
      catch (error) { throw new Error(errorText(error)); }
    },
  });
}

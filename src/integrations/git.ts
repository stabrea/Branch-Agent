import { mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { NeedsInputError } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import { explainGit, type GitOutcome, type GitRunner } from "./git-run.js";

/**
 * Everyday version control for the owner: see what changed, look back through saved versions, work
 * on a named line of work and save a version. Every command runs inside the workspace (or the
 * active project's folder), never touches anything the `.branchignore` file hides, and never
 * rewrites a saved version. Sending work to a server lives in the separate remote tools.
 */
export const WORKTREE_HOME = ".branch-worktrees";
export interface GitChange { path: string; state: string }

export class GitTools {
  constructor(private readonly files: WorkspaceFiles, private readonly runner: GitRunner) {}

  /** Resolves a workspace folder and refuses anything outside it, hidden, or not a folder. */
  private async folder(path: string): Promise<string> {
    const target = await this.files.checked(path, true);
    if (!(await stat(target).catch(() => null))?.isDirectory()) throw new Error("That is not a folder in your workspace.");
    return target;
  }
  private async run(cwd: string, args: string[], signal: AbortSignal, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<GitOutcome> {
    const outcome = await this.runner.run({ cwd, args, ...options }, signal);
    if (outcome.status !== "completed") throw new Error(explainGit(outcome));
    return outcome;
  }
  /** Drops paths the `.branchignore` hides and anything inside the parallel-copies folder. */
  private async visible(cwd: string, paths: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const path of paths.slice(0, 200)) {
      if (!path || path.startsWith('"') || path.startsWith(`${WORKTREE_HOME}/`)) continue;
      // Git collapses an untracked folder to one entry with a trailing slash ("?? build/").
      const isDirectory = path.endsWith("/");
      const inWorkspace = relative(this.files.root, join(cwd, path)).replace(/\\/g, "/");
      if (!(await this.files.hidden(inWorkspace, isDirectory))) kept.push(path);
    }
    return kept;
  }

  async status(path: string, signal: AbortSignal) {
    const cwd = await this.folder(path);
    const lines = (await this.run(cwd, ["status", "--porcelain=v1", "--branch"], signal)).stdout.split("\n").filter(Boolean);
    const header = lines[0]?.startsWith("##") ? lines[0].slice(3) : "";
    const changes = await this.changes(cwd, lines);
    return {
      folder: path, branch: /^(?:No commits yet on )?([^. ]+)/.exec(header)?.[1] ?? "unknown",
      ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
      changes, clean: changes.length === 0,
    };
  }
  private async changes(cwd: string, lines: string[]): Promise<GitChange[]> {
    const entries = lines.filter((line) => !line.startsWith("##")).slice(0, 200)
      .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).split(" -> ").at(-1)! }));
    const visible = new Set(await this.visible(cwd, entries.map((entry) => entry.path)));
    return entries.filter((entry) => visible.has(entry.path))
      .map((entry) => ({ path: entry.path, state: describeState(entry.code) }));
  }

  async diff(input: { folder: string; range?: string | undefined; staged?: boolean | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const scope = [...(input.staged ? ["--cached"] : []), ...(input.range ? [input.range] : [])];
    const names = (await this.run(cwd, ["diff", ...scope, "--name-only"], signal)).stdout.split("\n");
    const files = await this.visible(cwd, names.filter(Boolean));
    if (!files.length) return { folder: input.folder, files: [], text: "", truncated: false };
    const outcome = await this.run(cwd, ["diff", "--no-color", ...scope, "--", ...files], signal, { maxOutputBytes: 65536 });
    const text = outcome.stdout.slice(0, 24000);
    return { folder: input.folder, files, text, truncated: outcome.truncated || outcome.stdout.length > text.length };
  }

  async log(input: { folder: string; limit: number; path?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const target = input.path ? ["--", input.path] : [];
    const args = ["log", `--max-count=${input.limit}`, "--no-color", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s", ...target];
    const stdout = (await this.run(cwd, args, signal)).stdout;
    const versions = stdout.split("\n").filter(Boolean).map((line) => line.split("\x1f"))
      .map(([commit, author, at, subject]) => ({ commit: (commit ?? "").slice(0, 12), author, at, summary: (subject ?? "").slice(0, 200) }));
    return { folder: input.folder, versions };
  }

  async branch(input: { folder: string; action: "list" | "create" | "switch"; name?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    if (input.action === "list") {
      const stdout = (await this.run(cwd, ["branch", "--list", "--format=%(refname:short)"], signal)).stdout;
      const current = (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
      return { folder: input.folder, current, branches: stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 200) };
    }
    if (!input.name) throw new Error("Tell me what the line of work should be called.");
    const args = input.action === "create" ? ["switch", "--create", input.name] : ["switch", input.name];
    await this.run(cwd, args, signal);
    return { folder: input.folder, current: input.name, created: input.action === "create" };
  }

  async commit(input: { folder: string; message: string; paths?: string[] | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const candidates = input.paths?.length ? input.paths : (await this.status(input.folder, signal)).changes.map((change) => change.path);
    const allowed = await this.visible(cwd, candidates);
    if (!allowed.length) throw new Error("There is nothing to save: no files have changed since the last saved version.");
    await this.run(cwd, ["add", "--", ...allowed], signal);
    const staged = (await this.run(cwd, ["diff", "--cached", "--name-only"], signal)).stdout.split("\n").filter(Boolean);
    if (!staged.length) throw new Error("There is nothing to save: no files have changed since the last saved version.");
    await this.run(cwd, ["commit", "--message", input.message], signal);
    const commit = (await this.run(cwd, ["rev-parse", "HEAD"], signal)).stdout.trim().slice(0, 12);
    return { folder: input.folder, commit, files: staged.slice(0, 100), summary: input.message.split("\n")[0]!.slice(0, 200) };
  }

  async worktree(input: { folder: string; action: "add" | "remove" | "list"; name?: string | undefined; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const home = join(cwd, WORKTREE_HOME);
    if (input.action === "list") {
      const stdout = (await this.run(cwd, ["worktree", "list", "--porcelain"], signal)).stdout;
      const paths = stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9).trim());
      const mine = paths.filter((path) => !relative(home, path).startsWith("..") && relative(home, path) !== "");
      return { folder: input.folder, copies: mine.map((path) => ({ name: relative(home, path).replace(/\\/g, "/") })) };
    }
    if (!input.name) throw new Error("Tell me what to call this parallel copy.");
    const target = join(home, input.name);
    if (input.action === "remove") {
      await this.run(cwd, ["worktree", "remove", "--force", target], signal, { timeoutMs: 60000 });
      return { folder: input.folder, name: input.name, removed: true };
    }
    await mkdir(home, { recursive: true });
    const create = input.branch ? ["-b", input.branch] : ["--detach"];
    await this.run(cwd, ["worktree", "add", ...create, target], signal, { timeoutMs: 60000 });
    return { folder: input.folder, name: input.name, path: `${WORKTREE_HOME}/${input.name}`, branch: input.branch ?? null };
  }

  /** Sending work to a shared server; pushing the branch everyone shares asks the person first. */
  async push(input: { folder: string; remote: string; branch?: string | undefined; confirmed?: boolean | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    if (/^(main|master)$/i.test(branch) && !input.confirmed)
      throw new NeedsInputError(`This would send your work straight to "${branch}" on ${input.remote}, the copy everyone shares. Shall I go ahead?`);
    const outcome = await this.run(cwd, ["push", input.remote, branch], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, sent: true, notes: notes(outcome) };
  }
  async pull(input: { folder: string; remote: string; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    const outcome = await this.run(cwd, ["pull", "--ff-only", input.remote, branch], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, notes: notes(outcome) };
  }
}

const notes = (outcome: GitOutcome): string => `${outcome.stdout}\n${outcome.stderr}`.trim().slice(0, 2000);

/** Git's two-letter status code in words. */
export function describeState(code: string): string {
  if (code.startsWith("??")) return "new";
  if (/U/.test(code) || code === "DD" || code === "AA") return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "changed";
}

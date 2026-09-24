import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { NeedsInputError } from "../contracts.js";
import type { WorkspaceFiles } from "../files.js";
import { explainGit, inBranchSource, type GitOutcome, type GitRunner } from "./git-run.js";

/**
 * Everyday version control for the owner: see what changed, look back through saved versions, work
 * on a named line of work and save a version. Every command runs inside the workspace (or the
 * active project's folder), never touches anything the `.branchignore` file hides, and never
 * rewrites a saved version. Sending work to a server lives in the separate remote tools.
 */
export const WORKTREE_HOME = ".branch-worktrees";

/** The real, long-form spelling of a path when it exists; otherwise the resolved path as given. */
function canonical(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}
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
    const names = (await this.run(cwd, ["diff", ...noPrograms, ...scope, "--name-only"], signal)).stdout.split("\n");
    const files = await this.visible(cwd, names.filter(Boolean));
    if (!files.length) return { folder: input.folder, files: [], text: "", truncated: false };
    const outcome = await this.run(cwd, ["diff", ...noPrograms, "--no-color", ...scope, "--", ...files], signal, { maxOutputBytes: 65536 });
    const text = outcome.stdout.slice(0, 24000);
    return { folder: input.folder, files, text, truncated: outcome.truncated || outcome.stdout.length > text.length };
  }

  async log(input: { folder: string; limit: number; path?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const target = input.path ? ["--", input.path] : [];
    const args = ["log", ...noPrograms, `--max-count=${input.limit}`, "--no-color", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s", ...target];
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
    const staged = (await this.run(cwd, ["diff", ...noPrograms, "--cached", "--name-only"], signal)).stdout.split("\n").filter(Boolean);
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
      // Git may print a folder in a different spelling (Windows short names, case); compare real paths.
      const base = canonical(home);
      const inside = (path: string) => { const rel = relative(base, canonical(path)); return rel !== "" && !rel.startsWith(".."); };
      const mine = paths.filter(inside);
      return { folder: input.folder, copies: mine.map((path) => ({ name: relative(base, canonical(path)).replace(/\\/g, "/") })) };
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

  /**
   * A plan branch: a parallel copy of the repository, on a line of work of its own, where a risky
   * plan or a saved procedure can be tried without touching what the owner is working on. The copy
   * lives in the same confined folder as every other parallel copy. Nothing comes back until the
   * difference has been looked at and the merge asked for.
   */
  async planStart(input: { folder: string; name: string; from?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    const home = join(cwd, WORKTREE_HOME);
    await mkdir(home, { recursive: true });
    const from = input.from ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    await this.run(cwd, ["worktree", "add", "-b", branch, join(home, input.name), from], signal, { timeoutMs: 60000 });
    return { folder: input.folder, name: input.name, branch, from, path: `${WORKTREE_HOME}/${input.name}`,
      note: "Work in that folder. Ask for the difference when you are done, and merge it back only when it looks right." };
  }
  /** What trying the plan changed, compared with where it started. */
  async planDiff(input: { folder: string; name: string; against?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    const against = input.against ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    const names = (await this.run(cwd, ["diff", ...noPrograms, "--name-only", `${against}...${branch}`], signal)).stdout.split("\n");
    const files = await this.visible(cwd, names.filter(Boolean));
    if (!files.length) return { folder: input.folder, name: input.name, branch, against, files: [], text: "", truncated: false,
      note: "The plan changed nothing that is saved on its branch yet." };
    const outcome = await this.run(cwd, ["diff", ...noPrograms, "--no-color", `${against}...${branch}`, "--", ...files], signal, { maxOutputBytes: 65536 });
    const text = outcome.stdout.slice(0, 24000);
    return { folder: input.folder, name: input.name, branch, against, files, text, truncated: outcome.truncated || outcome.stdout.length > text.length };
  }
  /** Brings the plan's work back onto the line of work the owner is on, keeping its own history. */
  async planMerge(input: { folder: string; name: string; message?: string | undefined; remove: boolean }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const branch = planBranch(input.name);
    const into = (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    await this.run(cwd, ["merge", "--no-ff", "--no-edit", "-m", input.message ?? `Try "${input.name}"`, branch], signal, { timeoutMs: 60000 });
    if (input.remove)
      await this.run(cwd, ["worktree", "remove", "--force", join(cwd, WORKTREE_HOME, input.name)], signal, { timeoutMs: 60000 }).catch(() => undefined);
    return { folder: input.folder, name: input.name, branch, into, merged: true, copyRemoved: input.remove };
  }

  /**
   * Points a folder at a repository on a server and sends its work there for the first time. The
   * address is set as a plain remote with no sign-in details in it: the push uses whatever Git
   * sign-in this computer already has, so no token is ever written into the repository's settings.
   */
  async publish(input: { folder: string; url: string; remote: string; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const address = new URL(input.url);
    if (address.protocol !== "https:" || address.username || address.password)
      throw new Error("The address of a repository on a server starts with https:// and carries no sign-in details.");
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    await this.run(cwd, ["remote", "remove", input.remote], signal).catch(() => undefined);
    await this.run(cwd, ["remote", "add", input.remote, address.href], signal);
    // Q98: publishing is a push too, so in Branch's source it gets the same checks, on the address Git will really use.
    const refused = await this.validateRemoteURL(cwd, input.remote, true, signal);
    if (refused) {
      await this.run(cwd, ["remote", "remove", input.remote], signal).catch(() => undefined);
      throw new Error(refused);
    }
    const outcome = await this.run(cwd, ["push", "--set-upstream", input.remote, branch], signal, { timeoutMs: 180000 });
    return { folder: input.folder, remote: input.remote, address: address.href, branch, sent: true, notes: notes(outcome) };
  }

  /**
   * Q79, A1: when Git run inside Branch's source, refuse LOCAL or WORKTREE scoped
   * settings that could run a program during sign-in, key management, or includes.
   */
  private async checkScopeKeys(cwd: string, signal: AbortSignal): Promise<string | void> {
    const checks: { pattern: string; desc: string }[] = [
      { pattern: "^credential\\..*helper$", desc: "credential helper" },
      { pattern: "^core\\.askPass$", desc: "password prompt command" },
      { pattern: "^core\\.sshCommand$", desc: "SSH command" },
      { pattern: "^include\\.path$", desc: "included config file" },
      { pattern: "^includeIf\\..*\\.path$", desc: "conditional included config file" },
    ];
    for (const check of checks) {
      const result = await this.runner.run({ cwd, args: ["config", "--show-scope", "--get-regexp", check.pattern], timeoutMs: 10_000 }, signal);
      if (result.status === "completed" && result.exitCode === 1) continue; // Exit 1 means no match
      if (result.status !== "completed") {
        if (result.stderr || result.exitCode !== 1) return `Could not read Git config, so nothing was sent.`;
        continue;
      }
      for (const line of result.stdout.split("\n")) {
        const match = /^(local|worktree)\s+/.exec(line);
        if (match) return `Git config "${check.desc}" is set at ${match[1]} scope, which could run a program or load untrusted settings.`;
      }
    }
  }

  /**
   * Q82: refuse an ssh:// or scp-like remote whose user or host starts with `-`: ssh is handed
   * `user@host` as one argument, so a leading dash in either could be read as an option.
   */
  private checkHostDash(url: string): string | void {
    const at = /^ssh:\/\/([^/]+)/.exec(url)?.[1] ?? /^([^/:]+):/.exec(url)?.[1];
    if (at && (at.startsWith("-") || at.split("@").at(-1)?.startsWith("-")))
      return `Remote "${url}" starts its user or host with "-", which ssh could read as an option, so nothing was sent.`;
  }

  /**
   * Q82, B: refuse a remote whose URL has been rewritten by url.<x>.insteadOf or
   * url.<x>.pushInsteadOf config, which could change what repository Git sends to.
   */
  private async checkInsteadOf(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    const raw = await this.runner.run({ cwd, args: ["config", "--get-all", `remote.${remote}.url`], timeoutMs: 10_000 }, signal);
    // Q96: a remote Git still reads from a .git/remotes or .git/branches file has nothing here to compare
    // its rewritten address with, so it is refused rather than let through.
    if (raw.status !== "completed")
      return `Remote "${remote}" is not set in Git's settings (it may come from an old .git/remotes or .git/branches file), so nothing was sent.`;
    const configured = raw.stdout.trim().split("\n").filter(Boolean);
    const getUrlArgs = isPush ? ["remote", "get-url", "--push", "--all", remote] : ["remote", "get-url", "--all", remote];
    const read = await this.runner.run({ cwd, args: getUrlArgs, timeoutMs: 10_000 }, signal);
    if (read.status !== "completed") return;
    const resolved = read.stdout.trim().split("\n").filter(Boolean);
    if (configured.length !== resolved.length)
      return `Remote URL was changed by url.<x>.insteadOf or url.<x>.pushInsteadOf config, which can redirect to an unexpected repository.`;
    for (let i = 0; i < configured.length; i++) {
      if (configured[i] !== resolved[i])
        return `Remote URL was changed by url.<x>.insteadOf or url.<x>.pushInsteadOf config, which can redirect to an unexpected repository.`;
    }
  }

  /**
   * C: validates remote URLs (for push or fetch) against safe format and insteadOf rewrites.
   */
  private async validateURLs(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    const getUrlArgs = isPush ? ["remote", "get-url", "--push", "--all", remote] : ["remote", "get-url", "--all", remote];
    const read = await this.runner.run({ cwd, args: getUrlArgs, timeoutMs: 10_000 }, signal);
    if (read.status !== "completed") return `Remote "${remote}" is not configured in this repository, so nothing was sent.`;
    const urls = read.stdout.trim().split("\n").filter(Boolean);
    if (!urls.length) return `Remote "${remote}" has no address, so nothing was sent.`;
    for (const url of urls) {
      if (!(/^https:\/\//.test(url) || /^ssh:\/\//.test(url) || /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._\/-]+$/.test(url)))
        return `Remote URL must use https://, ssh://, or scp-like format (user@host:path), but got: ${url}`;
      const dashError = this.checkHostDash(url);
      if (dashError) return dashError;
    }
    const insteadOfError = await this.checkInsteadOf(cwd, remote, isPush, signal);
    if (insteadOfError) return insteadOfError;
  }

  /**
   * Q12, C: when Git run inside Branch's source, validate that a remote is configured
   * and uses only https:// or ssh:// (including scp-like user@host:path).
   * Refuses file://, plain paths, ext::, and other transports that could execute code.
   */
  private async validateRemoteURL(cwd: string, remote: string, isPush: boolean, signal: AbortSignal): Promise<string | void> {
    if (!inBranchSource(cwd)) return;
    const scopeError = await this.checkScopeKeys(cwd, signal);
    if (scopeError) return scopeError;
    return this.validateURLs(cwd, remote, isPush, signal);
  }

  /** Sending work to a shared server; pushing the branch everyone shares asks the person first. */
  async push(input: { folder: string; remote: string; branch?: string | undefined; confirmed?: boolean | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const urlError = await this.validateRemoteURL(cwd, input.remote, true, signal);
    if (urlError) throw new Error(urlError);
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    if (/^(main|master)$/i.test(branch) && !input.confirmed)
      throw new NeedsInputError(`This would send your work straight to "${branch}" on ${input.remote}, the copy everyone shares. Shall I go ahead?`);
    const outcome = await this.run(cwd, ["push", input.remote, branch], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, sent: true, notes: notes(outcome) };
  }
  async pull(input: { folder: string; remote: string; branch?: string | undefined }, signal: AbortSignal) {
    const cwd = await this.folder(input.folder);
    const urlError = await this.validateRemoteURL(cwd, input.remote, false, signal);
    if (urlError) throw new Error(urlError);
    const branch = input.branch ?? (await this.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).stdout.trim();
    const outcome = await this.run(cwd, ["pull", "--ff-only", input.remote, branch], signal, { timeoutMs: 120000 });
    return { folder: input.folder, remote: input.remote, branch, notes: notes(outcome) };
  }
}

const notes = (outcome: GitOutcome): string => `${outcome.stdout}\n${outcome.stderr}`.trim().slice(0, 2000);

/**
 * Q12: a diff or log never hands a file to a program a repository names (an external diff tool or a
 * textconv filter); the change is shown as Git itself reads it. See pinnedGitConfig in git-run.ts.
 */
const noPrograms = ["--no-ext-diff", "--no-textconv"] as const;

/** Every plan branch is named the same way, so one can never be mistaken for the owner's own. */
export const planBranch = (name: string): string => `plan/${name}`;

/** Git's two-letter status code in words. */
export function describeState(code: string): string {
  if (code.startsWith("??")) return "new";
  if (/U/.test(code) || code === "DD" || code === "AA") return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "changed";
}

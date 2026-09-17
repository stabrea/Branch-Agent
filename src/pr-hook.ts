import { z } from "zod";
import { FeatureModeSchema } from "./feature-switches.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";
import { issueLinksIn } from "./integrations/issue-context.js";
import type { ToolContext } from "./contracts.js";
import type { GitRunOptions, GitOutcome } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { WorkspaceFiles } from "./files.js";

/**
 * Opening a pull request from a task's changes (A0300, after SWE-agent's "open PR" hook).
 *
 * The owner's three-way switch, off by default:
 * - off: nothing happens and `github.pull_request_from_changes` refuses;
 * - when-needed: the tool works when the assistant (or the owner) calls it; nothing happens by itself;
 * - on: as well, a task that finishes well and changed files puts exactly those files on a new line
 *   of work called `branch/<task>`, sends it to GitHub and opens a draft pull request.
 *
 * What it never does:
 * - send to the shared branch: the line of work is always a new `branch/…` one, and the base, the
 *   remote's default branch and names such as main, master, develop, trunk or release/* are refused;
 * - act for a short-lived key (`branch token create`): a script's key may not send work anywhere;
 * - put a key anywhere: Git sends with this computer's own sign-in (an address carrying a password
 *   is refused), and GitHub is reached through the saved GitHub tools, whose token is read from the
 *   locker at the moment of the call; the address is checked against the network rules first;
 * - fail quietly: every attempt that stops is written to the task's log with the reason.
 */
export const PullRequestHookSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  remote: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,39}$/).default("origin"),
  /** The branch the pull request asks to join; the remote's own default when not given. */
  base: z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/).optional(),
}).strict();
export type PullRequestHookSettings = z.infer<typeof PullRequestHookSettingsSchema>;
const KEY = "pull-request-hook";

export function pullRequestHookSettings(store: Pick<Store, "get">, owner: string): PullRequestHookSettings {
  const saved = PullRequestHookSettingsSchema.safeParse(store.get("settings", owner, KEY)?.data ?? {});
  return saved.success ? saved.data : PullRequestHookSettingsSchema.parse({});
}
export function savePullRequestHookSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): PullRequestHookSettings {
  if (startedWithShortLivedKey()) throw new Error("A short-lived key cannot change how work is sent to GitHub. Do that in the app window.");
  const value = PullRequestHookSettingsSchema.parse({ ...pullRequestHookSettings(store, owner), ...(input as object) });
  store.save("settings", owner, KEY, value);
  return value;
}

type PullRequestGit = (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
export interface PullRequestDeps {
  store: Store;
  owner: string;
  files: WorkspaceFiles;
  git: PullRequestGit;
  policy: NetworkPolicy;
  registry: ToolRegistry;
  /** Runs a registered tool as the owner (the saved GitHub tools); the runtime's executeTool. */
  /** `runId` is the task whose own call got here; without one it is the hook working by itself. */
  runTool: (name: string, args: unknown, runId?: string) => Promise<unknown>;
  /** Integration review: Branch's own guard (src/never-break/protected.ts); a reason when a path may not be read. */
  guard?: (path: string) => string | null;
}
export interface OpenedPullRequest { repository: string; branch: string; base: string; files: string[]; pullRequest: unknown }

const protectedName = /^(main|master|develop|development|trunk|production|prod|staging|gh-pages)$|^release(s)?(\/|$)|^hotfix(es)?(\/|$)/i;
/** The one rule for where work may be sent: a fresh `branch/…` line that is not the base or the default. */
export function assertSafeHead(head: string, base: string, defaultBranch: string | null): void {
  if (!/^branch\/[A-Za-z0-9._-]{1,60}$/.test(head)) throw new Error(`"${head}" is not a line of work Branch made, so nothing was sent.`);
  if (head === base || head === defaultBranch || protectedName.test(head) || protectedName.test(head.slice("branch/".length)))
    throw new Error(`"${head}" is a shared branch, so nothing was sent.`);
  if (head.includes("..") || head.endsWith(".lock")) throw new Error(`"${head}" is not a usable branch name.`);
}

/** The GitHub repository behind a remote address, refusing an address that carries a password or token. */
export function githubRepositoryOf(address: string): { repo: string; https: URL } {
  const scp = /^git@github\.com:([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(address.trim());
  if (scp) return { repo: `${scp[1]}/${scp[2]}`, https: new URL(`https://github.com/${scp[1]}/${scp[2]}`) };
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw new Error("The remote is not an address Branch can read."); }
  if (url.password || (url.username && url.protocol !== "ssh:")) throw new Error("The remote address carries a sign-in. Remove it and let Git use this computer's own sign-in.");
  if (url.hostname.toLowerCase() !== "github.com") throw new Error("The remote is not on GitHub.");
  const parts = /^\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(url.pathname);
  if (!parts) throw new Error("The remote address does not name a GitHub repository.");
  return { repo: `${parts[1]}/${parts[2]}`, https: new URL(`https://github.com/${parts[1]}/${parts[2]}`) };
}

async function gitText(deps: PullRequestDeps, cwd: string, args: string[], signal: AbortSignal, timeoutMs = 30000, raw = false): Promise<string> {
  const outcome = await deps.git({ cwd, args, timeoutMs }, signal);
  if (outcome.status !== "completed") throw new Error(`Git stopped: ${(outcome.stderr || outcome.stdout).trim().split("\n")[0]?.slice(0, 200) ?? "no reason given"}`);
  return raw ? outcome.stdout : outcome.stdout.trim();
}

/** Where the work would go: the repository, the base and the remote's default branch. */
async function destination(deps: PullRequestDeps, cwd: string, settings: PullRequestHookSettings, signal: AbortSignal) {
  // Every address a push goes to (a remote may have several, and a push address of its own).
  const addresses = (await gitText(deps, cwd, ["remote", "get-url", "--push", "--all", settings.remote], signal)).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!addresses.length) throw new Error("The remote has no address.");
  const found = addresses.map(githubRepositoryOf);
  const { repo, https } = found[0]!;
  if (found.some((each) => each.repo.toLowerCase() !== repo.toLowerCase())) throw new Error("The remote sends to more than one repository, so nothing was sent.");
  await deps.policy.assertAllowed(https, "GitHub repository");
  const headRef = await gitText(deps, cwd, ["symbolic-ref", "--quiet", `refs/remotes/${settings.remote}/HEAD`], signal).catch(() => "");
  const defaultBranch = headRef ? headRef.replace(`refs/remotes/${settings.remote}/`, "") : null;
  return { repo, base: settings.base ?? defaultBranch ?? "main", defaultBranch };
}

/**
 * Commits the named files on a new `branch/<name>` line, sends it, and opens a draft pull request.
 * Every refusal is thrown with a plain reason; the caller records it.
 */
export async function pullRequestFromChanges(deps: PullRequestDeps, input: { name: string; title: string; summary: string; paths: string[] | null; signal: AbortSignal; runId?: string }): Promise<OpenedPullRequest> {
  if (startedWithShortLivedKey() || (input.runId && runOrigin(deps.store, input.runId).shortLivedKey))
    throw new Error("A short-lived key cannot send work to GitHub. Do that in the app window.");
  const settings = pullRequestHookSettings(deps.store, deps.owner);
  if (settings.mode === "off") throw new Error("Opening pull requests from changes is switched off. Turn it on in Settings → Developer → Pull requests from changes.");
  if (!deps.registry.names().includes("github.open_pull_request")) throw new Error("Connect GitHub first: GitHub is not set up with a saved token.");
  const cwd = await deps.files.checked(".", true);
  const where = await destination(deps, cwd, settings, input.signal);
  const head = `branch/${input.name}`;
  assertSafeHead(head, where.base, where.defaultBranch);
  const paths = input.paths ?? (await changedPaths(deps, cwd, input.signal));
  const visible = await sendablePaths(deps, cwd, paths);
  if (!visible.length) throw new Error("There are no changed files that may be sent.");
  await gitText(deps, cwd, ["switch", "--create", head], input.signal);
  // Names are taken literally (a "*" is a file called "*"), and only the named files are committed,
  // whatever else happened to be staged already.
  await gitText(deps, cwd, ["--literal-pathspecs", "add", "--", ...visible], input.signal);
  await gitText(deps, cwd, ["--literal-pathspecs", "commit", "--only", "--message", input.title.slice(0, 200), "--", ...visible], input.signal);
  // An explicit refspec: exactly this new line, to a branch of the same name, never anything else.
  await gitText(deps, cwd, ["push", "--set-upstream", settings.remote, `refs/heads/${head}:refs/heads/${head}`], input.signal, 180000);
  const pullRequest = await deps.runTool("github.open_pull_request", {
    repo: where.repo, title: input.title.slice(0, 200), body: input.summary.slice(0, 8000),
    base: where.base, head, changes: visible.slice(0, 20), draft: true,
    ...issueArgument(input.summary),
  }, input.runId);
  return { repository: where.repo, branch: head, base: where.base, files: visible, pullRequest };
}

const issueArgument = (text: string): { issue?: string } => {
  const link = issueLinksIn(text, 1).find((each) => each.tracker === "github");
  return link && link.tracker === "github" ? { issue: `${link.repo}#${link.number}` } : {};
};

/**
 * Integration review: the files that may leave this computer. Each goes through the same checks as the
 * assistant's own file tools (inside the workspace, no secret-looking name, no link, nothing
 * `.branchignore` hides) and Branch's own guard; a folder is never sent whole.
 */
async function sendablePaths(deps: PullRequestDeps, cwd: string, paths: readonly string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const path of paths) {
    if (!path || path.endsWith("/")) continue;
    const allowed = await deps.files.checked(path).then(() => true, () => false);
    if (!allowed || (await deps.files.hidden(path, false)) || deps.guard?.(path)) continue;
    const info = await lstat(join(cwd, path)).catch(() => null);
    if (info && !info.isFile()) continue;
    kept.push(path);
  }
  return kept;
}

async function changedPaths(deps: PullRequestDeps, cwd: string, signal: AbortSignal): Promise<string[]> {
  // Untrimmed: each line starts with two status letters, the first often a space.
  const text = await gitText(deps, cwd, ["status", "--porcelain=v1"], signal, 30000, true);
  return text.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1)!).filter((path) => !path.startsWith('"')).slice(0, 200);
}

/** The files this task changed, from its own log. */
function filesChangedBy(store: Store, runId: string): string[] {
  const paths = store.events(runId).filter((event) => event.kind === "file.changed")
    .map((event) => String((event.data as { path?: unknown }).path ?? "")).filter(Boolean);
  return [...new Set(paths)].slice(0, 200);
}

/** Writes to the task's log; a log that is already closed (the app shutting down) is not worth a crash. */
function note(deps: PullRequestDeps, runId: string, kind: string, data: Record<string, unknown>): void {
  try { deps.store.event(runId, kind, data); } catch { /* the app is closing */ }
}

/** Why a finished task's work is not sent by itself; null when it may be. Read from the task's own record. */
function skipReason(store: Store, runId: string): string | null {
  const origin = runOrigin(store, runId);
  if (startedWithShortLivedKey() || origin.shortLivedKey) return "The task was started with a short-lived key, so its work was not sent to GitHub.";
  if (origin.parentRunId) return "A specialist's part of a task is sent with the task it belongs to, not on its own.";
  if (origin.source !== "owner") return `The task was started by ${origin.source === "schedule" ? "a schedule" : origin.source === "trigger" ? "a trigger" : "another program"}, not by you, so its work was not sent to GitHub.`;
  if (origin.permissions && !origin.permissions.includes("github.manage")) return "The task was not allowed to publish (a message from a chat app, for one), so its work was not sent to GitHub.";
  return null;
}

/** "On": after a task that finished well and changed files, send those files and open a pull request. */
export function watchFinishedTasks(deps: PullRequestDeps, track: (work: () => Promise<unknown>) => void = (work) => void work()): () => void {
  return deps.store.onEvent((runId, kind, data) => {
    if (kind !== "run.finished" || data.status !== "completed") return;
    if (pullRequestHookSettings(deps.store, deps.owner).mode !== "on") return;
    const run = deps.store.run(runId);
    // A save from the window's editor or a single tool pressed by hand is not a task.
    if (run?.prompt.startsWith("Manual action:")) return;
    const paths = filesChangedBy(deps.store, runId);
    if (!paths.length) return;
    const skipped = skipReason(deps.store, runId);
    if (skipped) { note(deps, runId, "pull_request.skipped", { reason: skipped }); return; }
    const prompt = run?.prompt ?? "";
    const title = `Branch: ${prompt.split("\n")[0]!.trim().slice(0, 150) || "changes from a task"}`;
    const summary = `${prompt.trim().slice(0, 4000)}\n\nOpened by Branch when task ${runId.slice(0, 8)} finished.`;
    track(() => pullRequestFromChanges(deps, { name: `task-${runId.slice(0, 8)}`, title, summary, paths, signal: AbortSignal.timeout(300000) })
      .then((opened) => note(deps, runId, "pull_request.opened", { repository: opened.repository, branch: opened.branch, base: opened.base, files: opened.files.length }))
      .catch((error: unknown) => note(deps, runId, "pull_request.failed", { reason: error instanceof Error ? error.message.slice(0, 500) : "unknown" })));
  });
}

const toolName = "github.pull_request_from_changes";
/**
 * The tool is only offered while GitHub is set up (while `github.open_pull_request` exists), so a
 * computer without GitHub never grows a GitHub permission. Returns a function that stops watching.
 */
export function offerPullRequestFromChanges(deps: PullRequestDeps): () => void {
  const sync = () => {
    const github = deps.registry.names().includes("github.open_pull_request");
    const offered = deps.registry.names().includes(toolName);
    if (github && !offered) registerPullRequestFromChanges(deps);
    if (!github && offered) deps.registry.unregister(toolName);
  };
  sync();
  return deps.registry.onToolsChanged(sync);
}

export function registerPullRequestFromChanges(deps: PullRequestDeps): void {
  deps.registry.register({
    name: toolName, permission: "github.manage",
    description: "Put the files that changed on a new line of work (branch/<name>), send it to GitHub with this computer's own Git sign-in, and open a draft pull request. It never sends to a shared branch. Name an issue in the summary to link it.",
    parameters: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,50}$/, "Use lowercase letters, digits, dots, dashes and underscores"),
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(8000),
      paths: z.array(z.string().min(1).max(500).regex(/^(?!-)[^\\:\0]+$/)).max(200).optional(),
    }).strict(),
    target: (args) => `send changes to GitHub on branch/${String((args as { name?: unknown }).name ?? "")} and open a pull request`,
    execute: async (args, context: ToolContext) => {
      try {
        return await pullRequestFromChanges(deps, { ...args, paths: args.paths ?? null, signal: context.signal, ...(context.runId ? { runId: context.runId } : {}) });
      } catch (error) {
        if (context.runId) deps.store.event(context.runId, "pull_request.failed", { reason: error instanceof Error ? error.message.slice(0, 500) : "unknown" });
        throw error;
      }
    },
  });
}


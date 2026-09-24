import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { githubRepositoryOf } from "./pr-hook.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "./key-context.js";
import type { Store } from "./store.js";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import { explainGit } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Projects } from "./projects.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import type { WorkspaceFiles } from "./files.js";
import { worktreeScope } from "./coding/worktrees.js";

export const branchRepository = "stabrea/Branch-Agent";
const sourceFolder = "branch-agent-source";
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "Use lowercase letters, digits and dashes");
const baseSchema = z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).refine((value) => !value.includes("..") && !value.endsWith(".lock"));
const repositorySchema = z.string().url().default(`https://github.com/${branchRepository}.git`);

export interface SelfDevelopmentDeps {
  workspace: string;
  owner: string;
  projects: Projects;
  registry: ToolRegistry;
  policy: NetworkPolicy;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
  exists?: (path: string) => Promise<boolean>;
  store?: Store;
  runtime?: Pick<Runtime, "run">;
  files?: WorkspaceFiles;
}

const sourceSchema = z.object({ name: nameSchema, repository: repositorySchema, base: baseSchema.default("mac/cross-platform") }).strict();
const requestSchema = sourceSchema.extend({ goal: z.string().trim().min(10).max(1000) });
const requestTtl = 24 * 60 * 60 * 1000;

function requests(deps: SelfDevelopmentDeps): Store {
  if (!deps.store) throw new Error("Source-change requests need the persistent store.");
  deps.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS branch_source_requests (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, run_id TEXT NOT NULL,
    input TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL)`);
  return deps.store;
}

export function pendingBranchSourceChanges(deps: SelfDevelopmentDeps): Array<{ id: string; runId: string; name: string; goal: string; repository: string; base: string; expiresAt: string }> {
  const store = requests(deps);
  const rows = store.sqlite.prepare("SELECT id, run_id, input, expires_at FROM branch_source_requests WHERE owner = ? AND status = 'pending' AND expires_at > ? ORDER BY expires_at ASC LIMIT 100")
    .all(deps.owner, Date.now()) as Array<{ id: string; run_id: string; input: string; expires_at: number }>;
  return rows.map((row) => ({ id: row.id, runId: row.run_id, ...requestSchema.parse(JSON.parse(row.input)), expiresAt: new Date(row.expires_at).toISOString() }));
}

export function proposeBranchSourceChange(deps: SelfDevelopmentDeps, raw: unknown, context: ToolContext): { id: string; expiresAt: string; status: string } {
  const input = requestSchema.parse(raw);
  const store = requests(deps);
  if (!context.runId || store.run(context.runId)?.owner !== deps.owner) throw new Error("An owner's recorded run is required for a source-change proposal.");
  const origin = runOrigin(store, context.runId);
  if (origin.shortLivedKey || startedWithShortLivedKey()) throw new Error("A short-lived key cannot propose source changes.");
  if (origin.source !== "channel" || !startedFromChat(context, store)) throw new Error("This proposal tool is for chat-origin work only.");
  repositoryAddress(input.repository);
  const id = randomUUID(), expiresAt = Date.now() + requestTtl;
  store.sqlite.prepare("INSERT INTO branch_source_requests (id, owner, run_id, input, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, deps.owner, context.runId, JSON.stringify(input), expiresAt, "pending");
  return { id, expiresAt: new Date(expiresAt).toISOString(), status: "pending" };
}

export async function decideBranchSourceChange(deps: SelfDevelopmentDeps, id: string, decision: "approve" | "deny", signal: AbortSignal): Promise<Record<string, unknown>> {
  const store = requests(deps);
  const row = store.sqlite.prepare("SELECT * FROM branch_source_requests WHERE id = ? AND owner = ?").get(id, deps.owner) as
    { run_id: string; input: string; expires_at: number; status: string } | undefined;
  if (!row || row.status !== "pending") throw new Error("Source-change request is missing or already answered.");
  const status = row.expires_at <= Date.now() ? "expired" : decision === "deny" ? "denied" : "approved";
  // Consume before any asynchronous work, so concurrent approvals cannot start Git twice.
  if (store.sqlite.prepare("UPDATE branch_source_requests SET status = ? WHERE id = ? AND owner = ? AND status = 'pending'").run(status, id, deps.owner).changes !== 1)
    throw new Error("Source-change request is already answered.");
  if (status === "expired") throw new Error("Source-change request has expired.");
  if (status === "denied") return { id, status };
  const origin = store.run(row.run_id) && runOrigin(store, row.run_id);
  if (!origin || origin.source !== "channel" || origin.shortLivedKey) throw new Error("Source-change provenance is no longer valid.");
  const input = requestSchema.parse(JSON.parse(row.input));
  repositoryAddress(input.repository);
  const result = await prepareBranchSourceChange(deps, input, signal);
  if (!deps.runtime) return { id, status, goal: input.goal, result };
  const folder = String(result.folder);
  // An approved chat goal remains untrusted input. Only purpose-built, scoped file
  // tools are available; general files.write also includes unrelated mail/artifact tools.
  const permissions = ["branch.source_edit"];
  try {
    const task = await deps.runtime.run({
      prompt: `Owner-approved Branch Agent source editing task. Exact requested goal: ${input.goal}\n\nWork only in the isolated worktree. Use branch.source_list, branch.source_read and branch.source_write to make scoped changes. You have no shell, network, Git, account or publishing tools. Do not claim tests or a build ran; report changed files and hand off for separate owner-run verification and draft PR approval.`,
      source: "owner", signal, timeoutMs: 240_000, permissions,
      sourceWorktree: { scope: folder, workspace: join(deps.workspace, folder) },
    });
    const taskStatus = task.status === "completed" ? "review" : "failed";
    store.sqlite.prepare("UPDATE branch_source_requests SET status = ? WHERE id = ? AND status = 'approved'").run(taskStatus, id);
    return { id, status: taskStatus, goal: input.goal, result, taskRunId: task.id, taskStatus: task.status };
  } catch (error) {
    store.sqlite.prepare("UPDATE branch_source_requests SET status = ? WHERE id = ? AND status = 'approved'").run("failed", id);
    throw error;
  }
}

/** Editing surface for an owner-approved chat goal. No shell, Git, web, or account tools. */
export function registerSourceEditTools(deps: SelfDevelopmentDeps): void {
  if (!deps.files) return;
  const scoped = () => {
    if (!/^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9-]+$/.test(worktreeScope() ?? ""))
      throw new Error("Source editing requires an approved isolated worktree task.");
  };
  const path = z.string().min(1).max(500);
  deps.registry.register({ name: "branch.source_read", permission: "branch.source_edit", group: "code",
    description: "Read a source file in the isolated worktree (32 KiB maximum).",
    parameters: z.object({ path }).strict(), target: (a) => a.path,
    execute: async (a) => { scoped(); return deps.files!.read(a.path); } });
  deps.registry.register({ name: "branch.source_list", permission: "branch.source_edit", group: "code",
    description: "List entries in the isolated worktree.",
    parameters: z.object({ path: path.default(".") }).strict(), target: (a) => a.path,
    execute: async (a) => { scoped(); return deps.files!.list(a.path); } });
  deps.registry.register({ name: "branch.source_write", permission: "branch.source_edit", group: "code",
    description: "Write a source file in the isolated worktree (32 KiB maximum). Read existing files before replacing them.",
    parameters: z.object({ path, content: z.string().max(32768) }).strict(), target: (a) => a.path,
    execute: async (a, c) => { scoped();
      if (deps.files!.readFirst?.holds(c.runId)) await deps.files!.readFirst.require(c.runId, await deps.files!.checked(a.path), a.path);
      const result = await deps.files!.write(a.path, a.content, c.signal);
      deps.files!.readFirst?.noteWritten(c.runId, deps.files!.addressOf(a.path));
      return result;
    } });
}

const present = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function run(deps: SelfDevelopmentDeps, cwd: string, args: string[], signal: AbortSignal, timeoutMs = 60_000): Promise<string> {
  const outcome = await deps.git({ cwd, args, timeoutMs }, signal);
  if (outcome.status !== "completed") throw new Error(explainGit(outcome));
  return outcome.stdout.trim();
}

function repositoryAddress(input: string): { repo: string; url: URL } {
  const parsed = githubRepositoryOf(input);
  if (parsed.repo.split("/")[1]?.toLowerCase() !== "branch-agent")
    throw new Error("Use the official Branch-Agent repository or your own GitHub fork of it.");
  // Rebuild from the repository name so credentials or other URL parts supplied by a caller can
  // never survive into the clone command. Do not replace this with input sanitising.
  return { repo: parsed.repo, url: new URL(`https://github.com/${parsed.repo}.git`) };
}

function sourceChangeFolder(workspace: string, name: string): string {
  return join(workspace, sourceFolder, ".branch-worktrees", `self-${name}`);
}

async function ensureSource(deps: SelfDevelopmentDeps, repository: { repo: string; url: URL }, signal: AbortSignal): Promise<string> {
  const source = join(deps.workspace, sourceFolder);
  const exists = deps.exists ?? present;
  await deps.policy.assertAllowed(repository.url, "Branch Agent source repository");
  if (!(await exists(source))) {
    await run(deps, deps.workspace, ["clone", "--origin", "origin", repository.url.href, sourceFolder], signal, 180_000);
  }
  const origin = repositoryAddress(await run(deps, source, ["remote", "get-url", "origin"], signal));
  if (origin.repo.toLowerCase() !== repository.repo.toLowerCase())
    throw new Error(`The existing ${sourceFolder} belongs to ${origin.repo}, not ${repository.repo}.`);
  return source;
}

async function ensureUpstream(deps: SelfDevelopmentDeps, source: string, fork: boolean, signal: AbortSignal): Promise<string> {
  if (!fork) return "origin";
  const official = `https://github.com/${branchRepository}.git`;
  const current = await run(deps, source, ["remote", "get-url", "upstream"], signal).catch(() => "");
  if (current && githubRepositoryOf(current).repo.toLowerCase() !== branchRepository.toLowerCase())
    throw new Error(`The existing upstream remote is ${githubRepositoryOf(current).repo}, not ${branchRepository}.`);
  if (!current) await run(deps, source, ["remote", "add", "upstream", official], signal);
  return "upstream";
}

function projectInstructions(name: string, base: string): string {
  return [
    "You are modifying Branch Agent itself inside an isolated Git worktree.",
    "Never edit the installed application, its private data, credentials, or the protected source checkout.",
    "Keep the requested change scoped, preserve the Branch Grown Up design direction, and do not remove provider support or legal notices.",
    "Run the relevant focused tests and npm run build, then inspect git.diff before offering the result.",
    `When the owner asks for a pull request, use github.pull_request_from_changes with name ${name}, targetRepository ${branchRepository}, and base ${base}.`,
    "The pull-request summary must include a Why merge this section. Open a draft; never merge it or change a shared branch yourself.",
  ].join(" ");
}

export async function prepareBranchSourceChange(
  deps: SelfDevelopmentDeps,
  input: { name: string; repository: string; base: string },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const repository = repositoryAddress(input.repository);
  const source = await ensureSource(deps, repository, signal);
  const remote = await ensureUpstream(deps, source, repository.repo.toLowerCase() !== branchRepository.toLowerCase(), signal);
  await run(deps, source, ["fetch", remote, input.base], signal, 180_000);
  const copyName = `self-${input.name}`, branch = `branch/self-${input.name}`;
  const folder = `${sourceFolder}/.branch-worktrees/${copyName}`;
  const exists = deps.exists ?? present;
  if (!(await exists(sourceChangeFolder(deps.workspace, input.name))))
    await run(deps, source, ["worktree", "add", "-b", branch, `.branch-worktrees/${copyName}`, `${remote}/${input.base}`], signal);
  const projectId = `branch-agent-${input.name}`;
  const instructions = projectInstructions(input.name, input.base);
  deps.projects.save(deps.owner, { id: projectId, name: `Branch Agent: ${input.name}`, instructions,
    modelPreset: null, repository: branchRepository, folder, profile: null, knowledgeBases: [], branch: "" });
  if (!deps.runtime) deps.projects.setActive(deps.owner, { active: projectId });
  return { project: projectId, folder, branch, base: `${remote}/${input.base}`, pushRepository: repository.repo,
    pullRequestTarget: branchRepository, ready: true, instructions,
    note: "Work only in this isolated copy. The running app and its data are unchanged. Tests and owner review come before a draft pull request." };
}

const toolName = "branch.prepare_source_change";

function registerSelfDevelopment(deps: SelfDevelopmentDeps): void {
  deps.registry.register({
    name: toolName,
    permission: "git.remote",
    description: "Prepare a protected, isolated source worktree for changing Branch Agent itself. Use this before requests such as removing a Branch button. It can use the official repository or the owner's GitHub fork, never edits the installed app, and does not open or merge a pull request.",
    parameters: sourceSchema,
    target: (args) => sourceChangeFolder(deps.workspace, String(args.name)),
    execute: (input, context: ToolContext) => {
      if (startedWithShortLivedKey() || (context.source && context.source !== "owner") ||
        (deps.store && startedFromChat(context, deps.store)))
        throw new Error("Only the owner in the Branch app can prepare Branch Agent source changes.");
      return prepareBranchSourceChange(deps, input, context.signal);
    },
  });
}

function registerProposal(deps: SelfDevelopmentDeps): void {
  if (!deps.store) return;
  deps.registry.register({
    name: "branch.propose_source_change", permission: "branch.propose_source_change",
    description: "Request owner review in the Branch app before preparing an isolated Branch Agent source worktree. Does not run Git.",
    parameters: requestSchema,
    execute: async (input, context: ToolContext) => proposeBranchSourceChange(deps, input, context),
  });
}

/** The setup tool appears only while sending Git work to a remote is switched on. */
export function offerSelfDevelopment(deps: SelfDevelopmentDeps): () => void {
  const sync = () => {
    const remote = deps.registry.names().includes("git.push");
    const offered = deps.registry.names().includes(toolName);
    if (remote && !offered) registerSelfDevelopment(deps);
    if (!remote && offered) deps.registry.unregister(toolName);
  };
  if (deps.store) registerProposal(deps);
  sync();
  return deps.registry.onToolsChanged(sync);
}

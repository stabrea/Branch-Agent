import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { GitTools } from "./git.js";
import { repositoryName, repositoryPath, type GitHubAccess } from "./github.js";
import { pullRequestTemplate } from "./issue-context.js";
import { referenceToLink } from "./issue-tools.js";

/**
 * The version-control tools, in three groups so the owner can allow them separately: reading
 * (`git.read`), changing this computer's copy (`git.write`) and talking to a server
 * (`git.remote`, which is switched off until the owner turns it on). GitHub lives behind
 * `github.manage` and needs a saved token.
 */
const folder = z.string().min(1).max(200).regex(/^[^\\:\0-][^\\:\0]*$/, "Use a folder inside your workspace").default(".");
const branchName = z.string().min(1).max(100).regex(/^(?!-)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._/-]+$/, "Use letters, digits, dots, dashes and slashes");
const revisionRange = z.string().min(1).max(200).regex(/^(?!-)[A-Za-z0-9._/@^~-]+(\.{2,3}[A-Za-z0-9._/@^~-]+)?$/, "Use a commit, a branch, or a range such as main..mine");
const filePath = z.string().min(1).max(500).regex(/^(?!-)[^\\:\0]+$/, "Use a path inside the folder");
const copyName = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, dots, dashes and underscores").refine((v) => !v.includes(".."), "No .. in a name");
const remoteName = z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9._-]*$/, "Use a remote name such as origin").default("origin");
const title = z.string().trim().min(1).max(200);

/** Reading and changing the copy of the repository on this computer. */
export function registerGit(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.status", permission: "git.read",
    description: "Show what has changed in a repository folder since the last saved version, which line of work is active, and whether it is ahead of or behind the shared copy.",
    parameters: z.object({ folder }).strict(),
    execute: (input, context: ToolContext) => git.status(input.folder, context.signal),
  });
  registry.register({
    name: "git.diff", permission: "git.read",
    description: "Show the actual changed lines, either in the working folder or between two points such as main..mine. The text is capped; files hidden by .branchignore are left out.",
    parameters: z.object({ folder, range: revisionRange.optional(), staged: z.boolean().default(false) }).strict()
      .refine((input) => !(input.staged && input.range), "Ask either for what is staged or for a range, not both"),
    execute: (input, context: ToolContext) => git.diff(input, context.signal),
  });
  registry.register({
    name: "git.log", permission: "git.read",
    description: "List recent saved versions of a repository folder, newest first, with who saved each one and its summary line.",
    parameters: z.object({ folder, limit: z.number().int().min(1).max(100).default(20), path: filePath.optional() }).strict(),
    execute: (input, context: ToolContext) => git.log(input, context.signal),
  });
  registry.register({
    name: "git.branch", permission: "git.write",
    description: "List the separate lines of work in a repository, start a new one, or switch to an existing one.",
    parameters: z.object({ folder, action: z.enum(["list", "create", "switch"]).default("list"), name: branchName.optional() }).strict(),
    execute: (input, context: ToolContext) => git.branch(input, context.signal),
  });
  registry.register({
    name: "git.commit", permission: "git.write",
    description: "Save a version of the changed files with a short message describing them. Saves everything that changed unless you name paths. It refuses when nothing has changed and never rewrites an earlier saved version.",
    parameters: z.object({ folder, message: z.string().trim().min(1).max(2000), paths: z.array(filePath).max(50).optional() }).strict(),
    execute: (input, context: ToolContext) => git.commit(input, context.signal),
  });
  registry.register({
    name: "git.worktree", permission: "git.write",
    description: "Keep a parallel copy of the repository for an experiment. Copies live only in the .branch-worktrees folder inside the workspace, so they never spread elsewhere.",
    parameters: z.object({ folder, action: z.enum(["add", "remove", "list"]).default("list"), name: copyName.optional(), branch: branchName.optional() }).strict(),
    execute: (input, context: ToolContext) => git.worktree(input, context.signal),
  });
  registerWorktrees(registry, git);
  registerPlanBranches(registry, git);
}

/**
 * The same parallel copies, one tool per thing you might want to do, because "add", "list" and
 * "remove" behind one name is a step the model has to think about rather than read.
 */
function registerWorktrees(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.worktree_add", permission: "git.write",
    description: "Make a parallel copy of the repository for an experiment, on a line of work of its own. Copies live only in the .branch-worktrees folder inside the workspace.",
    parameters: z.object({ folder, name: copyName, branch: branchName.optional() }).strict(),
    target: (args) => `parallel copy ${args.name}`,
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "add" }, context.signal),
  });
  registry.register({
    name: "git.worktree_list", permission: "git.read",
    description: "The parallel copies of a repository that exist right now.",
    parameters: z.object({ folder }).strict(),
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "list" }, context.signal),
  });
  registry.register({
    name: "git.worktree_remove", permission: "git.write",
    description: "Remove a parallel copy of the repository and everything left in it.",
    parameters: z.object({ folder, name: copyName }).strict(),
    target: (args) => `remove parallel copy ${args.name}`,
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "remove" }, context.signal),
  });
}

/**
 * Plan branches: try something risky in a parallel copy, look at exactly what it changed, and only
 * then bring it back. The copy and its line of work are named after the plan, so nothing the owner
 * is working on is touched until the merge is asked for.
 */
function registerPlanBranches(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.plan_start", permission: "git.write",
    description: "Start trying a plan in a parallel copy of the repository, on a line of work named after it. Nothing the person is working on is touched.",
    parameters: z.object({ folder, name: copyName, from: branchName.optional() }).strict(),
    target: (args) => `try "${args.name}" in a parallel copy`,
    execute: (input, context: ToolContext) => git.planStart(input, context.signal),
  });
  registry.register({
    name: "git.plan_diff", permission: "git.read",
    description: "What trying a plan changed, compared with where it started. Look at this before merging it back.",
    parameters: z.object({ folder, name: copyName, against: branchName.optional() }).strict(),
    execute: (input, context: ToolContext) => git.planDiff(input, context.signal),
  });
  registry.register({
    name: "git.plan_merge", permission: "git.write",
    description: "Bring a plan's work back onto the line of work you are on, and put the parallel copy away. The person is asked first.",
    parameters: z.object({ folder, name: copyName, message: z.string().trim().max(200).optional(), remove: z.boolean().default(true) }).strict(),
    target: (args) => `merge "${args.name}" back into the current line of work`,
    execute: (input, context: ToolContext) => git.planMerge(input, context.signal),
  });
}

/** Sending and receiving work; registered only when the owner has switched remote access on. */
export function registerGitRemote(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.push", permission: "git.remote",
    description: "Send saved versions from this computer to the shared server. Sending to the branch everyone shares (main or master) stops and asks you first.",
    parameters: z.object({ folder, remote: remoteName, branch: branchName.optional(), confirmed: z.boolean().default(false) }).strict(),
    execute: (input, context: ToolContext) => git.push(input, context.signal),
  });
  registry.register({
    name: "git.pull", permission: "git.remote",
    description: "Bring down work from the shared server, only when it can be added cleanly on top of yours.",
    parameters: z.object({ folder, remote: remoteName, branch: branchName.optional() }).strict(),
    execute: (input, context: ToolContext) => git.pull(input, context.signal),
  });
}

/**
 * Opening a pull request. When the task names the issue it settles, the description is written
 * from the shared template so the issue is linked and closes itself when the work is merged; the
 * issue is read first, so its title goes in the description and a wrong reference is caught here
 * rather than after the pull request exists.
 */
async function openPullRequest(
  github: GitHubAccess,
  input: { repo: string; title: string; body?: string | undefined; base: string; head: string; issue?: string | undefined; changes?: string[] | undefined },
): Promise<unknown> {
  const { issue: reference, changes, ...rest } = input;
  if (!reference) return github.openPullRequest(rest);
  const link = referenceToLink(reference);
  if (link.tracker !== "github") throw new Error("A GitHub pull request can only close a GitHub issue; mention a Linear issue in the description instead");
  const issue = await github.getIssue({ repo: link.repo, number: link.number });
  const body = pullRequestTemplate({ issue, summary: input.body ?? input.title, ...(changes ? { changes } : {}) });
  return github.openPullRequest({ ...rest, body });
}

/**
 * Reading how a project on GitHub is doing, and putting a folder on GitHub for the first time.
 * Publishing creates the repository and then sends the work with the Git sign-in this computer
 * already has: no token is written into the repository's settings, and the person is asked first.
 * A GitHub App is deliberately not built — these tools use the owner's own personal access token.
 */
export function registerGitHubProject(registry: ToolRegistry, github: GitHubAccess, git?: GitTools): void {
  registry.register({
    name: "github.issues", permission: "github.manage",
    description: "List the issues on a GitHub repository, newest first, saying which of them are really pull requests.",
    parameters: z.object({ repo: repositoryPath, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    execute: (input) => github.listIssues(input),
  });
  registry.register({
    name: "github.checks", permission: "github.manage",
    description: "Whether the automatic checks passed on a branch or a saved version, and which ones did not.",
    parameters: z.object({ repo: repositoryPath, ref: revisionRange }).strict(),
    execute: (input) => github.checks(input),
  });
  registry.register({
    name: "github.release", permission: "github.manage",
    description: "The releases published for a GitHub repository, newest first, with their notes.",
    parameters: z.object({ repo: repositoryPath, limit: z.number().int().min(1).max(30).default(10) }).strict(),
    execute: (input) => github.releases(input),
  });
  if (git) registerPublish(registry, github, git);
}

function registerPublish(registry: ToolRegistry, github: GitHubAccess, git: GitTools): void {
  registry.register({
    name: "github.publish_repo", permission: "github.manage",
    description: "Put a folder on GitHub for the first time: make the repository (private unless you say otherwise) and send the work there. The person is asked before anything leaves this computer.",
    parameters: z.object({
      folder, name: repositoryName, description: z.string().max(350).optional(),
      private: z.boolean().default(true), branch: branchName.optional(), remote: remoteName,
    }).strict(),
    target: (args) => `publish ${args.folder} to GitHub as ${args.name}`,
    execute: async (input, context: ToolContext) => {
      const created = (await github.createRepo(input)) as { repository?: string; address?: string; private?: boolean };
      const url = `https://github.com/${String(created.repository ?? input.name)}.git`;
      const sent = await git.publish({ folder: input.folder, url, remote: input.remote, branch: input.branch }, context.signal);
      return { ...created, ...sent };
    },
  });
}

/** GitHub; registered only when the owner has set it up with a saved token. */
export function registerGitHub(registry: ToolRegistry, github: GitHubAccess, git?: GitTools): void {
  registerGitHubProject(registry, github, git);
  registry.register({
    name: "github.create_repo", permission: "github.manage",
    description: "Create a repository on GitHub under the owner's account. It is private unless you say otherwise.",
    parameters: z.object({ name: repositoryName, description: z.string().max(350).optional(), private: z.boolean().default(true) }).strict(),
    execute: (input) => github.createRepo(input),
  });
  registry.register({
    name: "github.open_pull_request", permission: "github.manage",
    description: "Open a pull request on GitHub so someone can review one line of work before it joins the shared branch. Name the issue it settles and the description is written from a template that links it, so the issue closes when the work is merged.",
    parameters: z.object({
      repo: repositoryPath, title, body: z.string().max(8000).optional(), base: branchName, head: branchName,
      /** The issue this settles: its web address, owner/name#12, or a Linear reference such as ENG-214. */
      issue: z.string().trim().min(1).max(500).optional(),
      /** One line per thing that changed, for the template's list. */
      changes: z.array(z.string().max(300)).max(20).optional(),
    }).strict(),
    execute: (input) => openPullRequest(github, input),
  });
  registry.register({
    name: "github.list_issues", permission: "github.manage",
    description: "List issues on a GitHub repository, newest first.",
    parameters: z.object({ repo: repositoryPath, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    execute: (input) => github.listIssues(input),
  });
  registry.register({
    name: "github.create_issue", permission: "github.manage",
    description: "Raise an issue on a GitHub repository.",
    parameters: z.object({ repo: repositoryPath, title, body: z.string().max(8000).optional() }).strict(),
    execute: (input) => github.createIssue(input),
  });
}

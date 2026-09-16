import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { GitTools } from "./git.js";
import { repositoryName, repositoryPath, type GitHubAccess } from "./github.js";

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

/** GitHub; registered only when the owner has set it up with a saved token. */
export function registerGitHub(registry: ToolRegistry, github: GitHubAccess): void {
  registry.register({
    name: "github.create_repo", permission: "github.manage",
    description: "Create a repository on GitHub under the owner's account. It is private unless you say otherwise.",
    parameters: z.object({ name: repositoryName, description: z.string().max(350).optional(), private: z.boolean().default(true) }).strict(),
    execute: (input) => github.createRepo(input),
  });
  registry.register({
    name: "github.open_pull_request", permission: "github.manage",
    description: "Open a pull request on GitHub so someone can review one line of work before it joins the shared branch.",
    parameters: z.object({ repo: repositoryPath, title, body: z.string().max(8000).optional(), base: branchName, head: branchName }).strict(),
    execute: (input) => github.openPullRequest(input),
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

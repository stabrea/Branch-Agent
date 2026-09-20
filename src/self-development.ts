import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { githubRepositoryOf } from "./pr-hook.js";
import { startedWithShortLivedKey } from "./key-context.js";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import { explainGit } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Projects } from "./projects.js";
import type { ToolRegistry } from "./registry.js";

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
  deps.projects.setActive(deps.owner, { active: projectId });
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
    parameters: z.object({ name: nameSchema, repository: repositorySchema, base: baseSchema.default("mac/cross-platform") }).strict(),
    target: (args) => sourceChangeFolder(deps.workspace, String(args.name)),
    execute: (input, context: ToolContext) => {
      if (startedWithShortLivedKey() || (context.source && context.source !== "owner"))
        throw new Error("Only the owner in the Branch app can prepare Branch Agent source changes.");
      return prepareBranchSourceChange(deps, input, context.signal);
    },
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
  sync();
  return deps.registry.onToolsChanged(sync);
}

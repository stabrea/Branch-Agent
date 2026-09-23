/**
 * Q12: the documented pull request step of a self-development task runs whole or not at all.
 * `github.pull_request_from_changes` pushes `branch/<name>` and then opens the draft with
 * `github.open_pull_request`. The contract must list both, and is asked about both before anything
 * is pushed. Real app, scripted model, a stand-in `git` first on PATH and a stand-in GitHub tool,
 * so nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { savePullRequestHookSettings } from "../dist/pr-hook.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const sha = "d".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const home = await mkdtemp(join(tmpdir(), "branch-self-pr-git-"));
const gitLog = join(home, "git.log");
const bin = join(home, "bin");
await mkdir(bin, { recursive: true });
await writeFile(join(bin, "git"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -c) shift 2;; --no-pager) shift; break;; *) break;; esac; done
echo "$*" >> '${gitLog}'
case "$1" in
  remote) echo https://github.com/stabrea/Branch-Agent.git; exit 0;;
  symbolic-ref) echo refs/remotes/origin/main; exit 0;;
  switch|push|--literal-pathspecs|merge-base) exit 0;;
  diff) printf 'src/ui/button.ts\\0'; exit 0;;
  ls-files) exit 0;;
  *) exit 1;;
esac
`);
await chmod(join(bin, "git"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
test.after(() => discardTemp(home));

async function branchWith(t, permissions) {
  await writeFile(gitLog, "");
  const root = await mkdtemp(join(tmpdir(), "branch-self-pr-"));
  let calls = 0;
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [{ id: "pr", name: "github.pull_request_from_changes", arguments: JSON.stringify({
      name: "self-remove-button", title: "Remove the button", summary: "Why merge this: the button is unused.", paths: ["src/ui/button.ts"] }) }] }
      : { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off" });
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  const opened = [];
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in for GitHub",
    parameters: z.object({}).passthrough(), execute: async (args) => { opened.push(args); return { number: 7, draft: args.draft }; } });
  app.store.projects.save(owner, { id: "branch-agent-remove-button", name: "Branch Agent: remove-button", instructions: "",
    modelPreset: null, repository: "stabrea/Branch-Agent", folder: worktree, profile: null, knowledgeBases: [], branch: "" });
  app.store.projects.setActive(owner, { active: "branch-agent-remove-button" });
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await writeFile(join(workspace, worktree, "src", "ui", "button.ts"), "export {};\n");
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions, expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "The button is gone",
    sideEffects: ["a draft pull request"], rollbackPlan: "Close the pull request and delete branch/self-remove-button" } });
  const run = await app.runtime.run({ prompt: "Open the pull request" });
  const failed = app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => event.data.error);
  return { app, owner, run, opened, failed, git: (await readFile(gitLog, "utf8")).split("\n").filter(Boolean) };
}

test("with both steps in the contract, the branch is pushed and the draft pull request opens", async (t) => {
  const { run, opened, failed, git } = await branchWith(t, ["files.write", "github.pull_request_from_changes", "github.open_pull_request"]);
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(failed, []);
  assert.ok(git.some((line) => line.startsWith("push")), git.join("\n"));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].head, "branch/self-remove-button");
  assert.equal(opened[0].draft, true);
});

test("with only the outer step in the contract, nothing is pushed and the refusal comes first", async (t) => {
  const { app, owner, opened, failed, git } = await branchWith(t, ["files.write", "github.pull_request_from_changes"]);
  assert.match(failed.join("\n"), /self-development contract: github\.open_pull_request is not one of the tools this contract allows/);
  assert.deepEqual(git.filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), [], "no branch was made, committed or pushed");
  assert.deepEqual(opened, []);
  const refused = app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused");
  assert.equal(refused.length, 1);
  assert.match(refused[0].subject, /^github\.open_pull_request in branch-agent-source\/\.branch-worktrees\/self-remove-button/);
});

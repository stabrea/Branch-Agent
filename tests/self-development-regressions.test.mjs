/**
 * Q12 regressions: NAS's three repros, pinned at the final head, now that never-break's broad
 * "branch-agent" pattern (removed in bfb78d57) no longer backs anything up. Each goes through the
 * real app with the approval policy wide open, so the self-development contract does the refusing.
 *   1. no project active, a glob naming the protected checkout: `for f in branch?agent-source/...`
 *   2. project `notes` active, a command whose cwd is the worktree or `branch-agent-source`
 *   3. the finish-of-task pull request hook with a changed file outside the contract
 * A stand-in `git` sits first on PATH so nothing reaches a network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { savePullRequestHookSettings } from "../dist/pr-hook.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { discardTemp } from "./temp-dir.mjs";

const sha = "f".repeat(40);
const worktree = "branch-agent-source/.branch-worktrees/self-remove-button";
const original = "export const main = 1;\n";
const home = await mkdtemp(join(tmpdir(), "branch-self-regressions-git-"));
const gitLog = join(home, "git.log");
await mkdir(join(home, "bin"), { recursive: true });
await writeFile(join(home, "bin", "git"), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -c) shift 2;; --no-pager) shift; break;; *) break;; esac; done
echo "$*" >> '${gitLog}'
case "$1" in
  remote) echo https://github.com/stabrea/Branch-Agent.git; exit 0;;
  symbolic-ref) echo refs/remotes/origin/main; exit 0;;
  switch|push|--literal-pathspecs|merge-base|log|ls-files) exit 0;;
  rev-parse) pwd -P; echo "$(pwd -P)/../../.git"; exit 0;;
  diff) printf 'src/ui/button.ts\\0package.json\\0'; exit 0;;
  *) exit 1;;
esac
`);
await chmod(join(home, "bin", "git"), 0o755);
process.env.PATH = `${join(home, "bin")}${delimiter}${process.env.PATH}`;
test.after(() => discardTemp(home));

async function realBranch(t, { project, calls }) {
  await writeFile(gitLog, "");
  const root = await mkdtemp(join(tmpdir(), "branch-self-regressions-"));
  let at = 0;
  const provider = { name: "scripted", async complete() {
    const call = calls[at++];
    return call ? { content: "", toolCalls: [{ id: `c${at}`, name: call.name, arguments: JSON.stringify(call.args) }] } : { content: "Done.", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, web: { allowPrivateAddresses: true } });
  const config = join(root, "integrations.json");
  await writeFile(config, JSON.stringify({ shell: { executables: { sh: { path: "/bin/sh", args: [] } }, timeoutMs: 10000 } }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  savePolicy(app.store, owner, { preset: "off", unmatchedCommands: "allow" });
  await mkdir(join(workspace, "branch-agent-source", "src"), { recursive: true });
  await writeFile(join(workspace, "branch-agent-source", "src", "main.ts"), original);
  await mkdir(join(workspace, worktree, "src", "ui"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  if (project) {
    app.store.projects.save(owner, { id: "active", name: "active", instructions: "", modelPreset: null, repository: "",
      folder: project, profile: null, knowledgeBases: [], branch: "" });
    app.store.projects.setActive(owner, { active: "active" });
  }
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "run-1", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/ui/**"], permissions: ["files.write", "shell.execute", "github.pull_request_from_changes", "github.open_pull_request"],
    expectedTests: ["tests/ui.test.mjs"], definitionOfDone: "done", sideEffects: [], rollbackPlan: "Remove the worktree" } });
  return { app, owner, workspace, run: () => app.runtime.run({ prompt: "Go" }),
    refusals: () => app.store.audit.list(owner, { action: "self_development.contract" }).filter((entry) => entry.outcome === "refused"),
    failed: (run) => app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => event.data.error),
    protectedFile: () => readFile(join(workspace, "branch-agent-source", "src", "main.ts"), "utf8") };
}

test("repro 1: a glob naming the protected checkout, with no project active, is refused and audited", { skip: process.platform === "win32" }, async (t) => {
  const branch = await realBranch(t, { project: null, calls: [{ name: "shell.execute",
    args: { executable: "sh", args: ["-c", "for f in branch?agent-source/src/main.ts; do echo PWNED >> $f; done"] } }] });
  const run = await branch.run();
  assert.match(branch.failed(run).join("\n"), /Refused by the self-development contract/);
  assert.equal(await branch.protectedFile(), original);
  assert.equal(branch.refusals().length, 1);
});

for (const cwd of [worktree, "branch-agent-source"]) {
  test(`repro 2: with notes active, a command with cwd ${cwd} is refused and audited`, { skip: process.platform === "win32" }, async (t) => {
    const branch = await realBranch(t, { project: "notes", calls: [{ name: "shell.execute", args: { executable: "sh", args: ["-c", "echo PWNED > marker.txt"], cwd } }] });
    const run = await branch.run();
    assert.match(branch.failed(run).join("\n"), /Refused by the self-development contract/);
    for (const folder of [cwd, join("notes", cwd), "notes"]) assert.equal(existsSync(join(branch.workspace, folder, "marker.txt")), false, folder);
    assert.equal(branch.refusals().length, 1);
  });
}

test("repro 3: the finish-of-task hook with a changed file outside the contract pushes nothing", async (t) => {
  const branch = await realBranch(t, { project: worktree, calls: [{ name: "files.write", args: { path: "src/ui/button.ts", content: "export {};\n" } }] });
  savePullRequestHookSettings(branch.app.store, branch.owner, { mode: "on" });
  const opened = [];
  branch.app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in for GitHub",
    parameters: z.object({}).passthrough(), execute: async (args) => { opened.push(args); return {}; } });
  const run = await branch.run();
  let outcome;
  for (let tries = 0; tries < 100 && !outcome; tries++) {
    outcome = branch.app.store.events(run.id).find((event) => /^pull_request\.(failed|opened)$/.test(event.kind));
    if (!outcome) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(outcome?.kind, "pull_request.failed");
  assert.match(outcome.data.reason, /outside the contract's allowed paths: package\.json/);
  assert.deepEqual((await readFile(gitLog, "utf8")).split("\n").filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
  assert.deepEqual(opened, []);
  assert.equal(branch.refusals().length, 1);
});

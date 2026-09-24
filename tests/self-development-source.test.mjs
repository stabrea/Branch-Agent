import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { offerSelfDevelopment, registerSourceEditTools, prepareBranchSourceChange, proposeBranchSourceChange, decideBranchSourceChange, pendingBranchSourceChanges, reviewedBranchSourceChanges, branchSourceDiff } from "../dist/self-development.js";
import { inWorktree } from "../dist/coding/worktrees.js";
import { Store } from "../dist/store.js";
import { offLimitsToShortLivedKeys, offLimitsToHousehold } from "../dist/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../dist/registry.js";
import { z } from "zod";

const completed = (stdout = "") => ({ status: "completed", stdout, stderr: "", exitCode: 0, command: "git" });

test("source editing tools are inert outside the approved worktree and expose no command capability", async () => {
  const registry = new ToolRegistry(), writes = [];
  const deps = { registry, files: { read: async (path) => ({ path, content: "old" }),
    list: async () => [], write: async (path, content) => { writes.push([path, content]); return { path }; } } };
  registerSourceEditTools(deps);
  const context = { runId: "task", source: "owner", signal: AbortSignal.timeout(1000),
    permissions: new Set(["branch.source_edit"]), budget: { step: () => {} } };
  assert.deepEqual(registry.descriptions(context.permissions).map((tool) => tool.name).sort(),
    ["branch.source_list", "branch.source_read", "branch.source_write"]);
  await assert.rejects(registry.execute("branch.source_write", { path: "src/a.ts", content: "new" }, context), /isolated worktree/);
  await inWorktree("branch-agent-source/.branch-worktrees/self-review", async () => {
    assert.deepEqual(await registry.execute("branch.source_read", { path: "src/a.ts" }, context), { path: "src/a.ts", content: "old" });
    await registry.execute("branch.source_write", { path: "src/a.ts", content: "new" }, context);
  });
  assert.deepEqual(writes, [["src/a.ts", "new"]]);
});

test("an owner's fork becomes an isolated Branch Agent project without touching the installed app", async () => {
  let source = false, copy = false, upstream = false;
  const calls = [], saved = [], active = [], sites = [];
  const deps = {
    workspace: "C:/owner/workspace", owner: "local",
    projects: { save: (_owner, project) => { saved.push(project); return project; }, setActive: (_owner, input) => { active.push(input); return input; } },
    registry: {}, policy: { assertAllowed: async (url) => { sites.push(url.href); } },
    exists: async (path) => path.endsWith("branch-agent-source") ? source : path.includes(".branch-worktrees") ? copy : false,
    git: async ({ cwd, args }) => {
      calls.push([cwd, ...args]);
      if (args[0] === "clone") { source = true; return completed(); }
      if (args.join(" ") === "remote get-url origin") return completed("https://github.com/alice/Branch-Agent.git\n");
      if (args.join(" ") === "remote get-url upstream") return upstream ? completed("https://github.com/stabrea/Branch-Agent.git\n") : { ...completed(), status: "failed", stderr: "missing" };
      if (args.join(" ").startsWith("remote add upstream")) { upstream = true; return completed(); }
      if (args[0] === "worktree") { copy = true; return completed(); }
      return completed();
    },
  };
  const input = { name: "remove-button", repository: "https://github.com/alice/Branch-Agent.git", base: "mac/cross-platform" };
  const result = await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));

  assert.equal(result.ready, true);
  assert.equal(result.pullRequestTarget, "stabrea/Branch-Agent");
  assert.match(result.instructions, /Run the relevant focused tests and npm run build/);
  assert.ok(calls.some((call) => call.includes("clone")), "the owner's fork is cloned into the workspace, not the installation");
  assert.ok(calls.some((call) => call.join(" ").includes("remote add upstream https://github.com/stabrea/Branch-Agent.git")));
  assert.ok(calls.some((call) => call.join(" ").includes("fetch upstream mac/cross-platform")));
  assert.ok(calls.some((call) => call.join(" ").includes("worktree add -b branch/self-remove-button .branch-worktrees/self-remove-button upstream/mac/cross-platform")));
  assert.match(saved[0].folder, /^branch-agent-source\/\.branch-worktrees\//);
  assert.match(saved[0].instructions, /Why merge this/);
  assert.deepEqual(active, [{ active: "branch-agent-remove-button" }]);
  assert.ok(sites.every((site) => site.startsWith("https://github.com/")));

  const before = calls.length;
  await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));
  assert.equal(calls.slice(before).some((call) => call.includes("clone") || call.includes("worktree")), false,
    "retrying reuses the protected source and isolated copy");
});

test("the special workflow refuses a repository that is not Branch-Agent", async () => {
  const deps = { workspace: "C:/owner/workspace", owner: "local", projects: {}, registry: {}, policy: {}, git: async () => completed() };
  await assert.rejects(
    prepareBranchSourceChange(deps, { name: "x", repository: "https://github.com/alice/unrelated.git", base: "main" }, AbortSignal.timeout(1000)),
    /official Branch-Agent repository or your own GitHub fork/,
  );
});

test("the self-development tool appears only while remote Git is enabled", () => {
  const registry = new ToolRegistry();
  const stop = offerSelfDevelopment({ workspace: "C:/owner/workspace", owner: "local", projects: {}, registry,
    policy: {}, git: async () => completed() });
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  registry.register({ name: "git.push", permission: "git.remote", description: "test", parameters: z.object({}), execute: async () => ({}) });
  assert.equal(registry.names().includes("branch.prepare_source_change"), true);
  assert.equal(registry.targetOf("branch.prepare_source_change", { name: "remove-button" }, {}),
    join("C:/owner/workspace", "branch-agent-source", ".branch-worktrees", "self-remove-button"));
  registry.unregister("git.push");
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  stop();
});

test("chat proposal persists without Git; denial, expiry and replay block preparation", async () => {
  const folder = mkdtempSync(join(tmpdir(), "branch-source-request-"));
  const store = new Store(join(folder, "branch.sqlite"));
  const calls = [];
  const registry = new ToolRegistry();
  const deps = { store, workspace: folder, owner: "local", registry,
    projects: { save: () => {}, setActive: () => {} }, policy: { assertAllowed: async () => {} },
    exists: async () => true,
    git: async ({ args }) => { calls.push(args); return completed(args[0] === "remote" ? "https://github.com/stabrea/Branch-Agent.git" : ""); } };
  registry.register({ name: "git.push", permission: "git.remote", description: "test", parameters: z.object({}), execute: async () => ({}) });
  const stop = offerSelfDevelopment(deps);
  const run = store.createRun("local", "proposal", undefined, false, "channel");
  store.event(run.id, "run.started", { source: "channel" });
  const input = { name: "proposal", goal: "Improve Branch Agent source-change workflow", repository: "https://github.com/stabrea/Branch-Agent.git", base: "mac/cross-platform" };
  const context = { runId: run.id, source: "channel", signal: AbortSignal.timeout(30000), permissions: new Set(["git.remote"]), budget: { step: () => {} } };
  await assert.rejects(registry.execute("branch.prepare_source_change", { name: input.name, repository: input.repository, base: input.base }, context), /Only the owner/);
  const first = proposeBranchSourceChange(deps, input, context);
  assert.equal(first.status, "pending");
  assert.deepEqual(pendingBranchSourceChanges(deps).map(({ id, name }) => ({ id, name })), [{ id: first.id, name: "proposal" }]);
  assert.equal(registry.permissionOf("branch.propose_source_change"), "branch.propose_source_change");
  assert.equal(calls.length, 0);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/branch/source-change"), /owner/);
  assert.match(offLimitsToShortLivedKeys("GET", "/api/branch/source-change"), /owner/);
  assert.ok(offLimitsToHousehold("GET", "/api/branch/source-change"));
  assert.ok(offLimitsToHousehold("POST", "/api/branch/source-change"));
  assert.deepEqual(await decideBranchSourceChange(deps, first.id, "deny", context.signal), { id: first.id, status: "denied" });
  await assert.rejects(decideBranchSourceChange(deps, first.id, "approve", context.signal), /already answered/);
  assert.equal(calls.length, 0);
  const expired = proposeBranchSourceChange(deps, input, context);
  store.sqlite.prepare("UPDATE branch_source_requests SET expires_at = 0 WHERE id = ?").run(expired.id);
  await assert.rejects(decideBranchSourceChange(deps, expired.id, "approve", context.signal), /expired/);
  assert.equal(calls.length, 0);
  const approved = proposeBranchSourceChange(deps, input, context);
  const result = await decideBranchSourceChange(deps, approved.id, "approve", context.signal);
  assert.equal(result.status, "approved");
  assert.ok(calls.some((args) => args[0] === "fetch"));
  await assert.rejects(decideBranchSourceChange(deps, approved.id, "approve", context.signal), /already answered/);
  stop(); store.close(); rmSync(folder, { recursive: true, force: true });
});

test("owner approval runs bounded coding in the isolated copy without publish permissions", async () => {
  const folder = mkdtempSync(join(tmpdir(), "branch-source-coding-"));
  const store = new Store(join(folder, "branch.sqlite"));
  const registry = new ToolRegistry();
  for (const permission of ["files.write", "terminal.execute", "github.manage", "git.remote"])
    registry.register({ name: `test.${permission}`, permission, description: "test", parameters: z.object({}), execute: async () => ({}) });
  const runs = [], active = [];
  const deps = { store, workspace: folder, owner: "local", registry,
    runtime: { run: async (options) => { runs.push(options); return { id: "coding-run", status: "completed" }; } },
    projects: { save: () => {}, setActive: (owner, choice) => active.push(choice) },
    policy: { assertAllowed: async () => {} }, exists: async () => true,
    git: async ({ args }) => completed(args.join(" ") === "remote get-url origin" ? "https://github.com/stabrea/Branch-Agent.git" : "") };
  const run = store.createRun("local", "request", undefined, false, "channel");
  store.event(run.id, "run.started", { source: "channel" });
  const input = { name: "coding", goal: "Improve the coding workflow safely", repository: "https://github.com/stabrea/Branch-Agent.git", base: "mac/cross-platform" };
  const proposal = proposeBranchSourceChange(deps, input, { runId: run.id, source: "channel" });
  const result = await decideBranchSourceChange(deps, proposal.id, "approve", AbortSignal.timeout(30000));
  assert.equal(result.status, "review");
  const [review] = reviewedBranchSourceChanges(deps);
  assert.equal(review.taskRunId, "coding-run");
  assert.equal(review.folder, "branch-agent-source/.branch-worktrees/self-coding");
  assert.match(review.summary, /completed/);
  assert.equal(review.status, "review");
  deps.exists = async () => false;
  await assert.rejects(branchSourceDiff(deps, proposal.id, AbortSignal.timeout(1000)), /missing/);
  deps.exists = async () => true;
  deps.git = async ({ args }) => completed(args[0] === "diff" ? "sample diff" : "");
  assert.deepEqual(await branchSourceDiff(deps, proposal.id, AbortSignal.timeout(1000)), { id: proposal.id, diff: "sample diff", truncated: false, files: "", filesTruncated: false });
  store.sqlite.prepare("UPDATE branch_source_requests SET worktree_folder = ? WHERE id = ?").run("../other", proposal.id);
  await assert.rejects(branchSourceDiff(deps, proposal.id, AbortSignal.timeout(1000)), /invalid/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, "owner");
  assert.equal(runs[0].timeoutMs, 240000);
  assert.equal(runs[0].sourceWorktree.scope, "branch-agent-source/.branch-worktrees/self-coding");
  assert.equal(runs[0].sourceWorktree.workspace, join(folder, runs[0].sourceWorktree.scope));
  assert.deepEqual(runs[0].permissions, ["branch.source_edit"]);
  assert.ok(!runs[0].permissions.includes("shell.execute"));
  assert.deepEqual(active, []);
  await assert.rejects(decideBranchSourceChange(deps, proposal.id, "approve", AbortSignal.timeout(1000)), /already answered/);
  store.close(); rmSync(folder, { recursive: true, force: true });
});

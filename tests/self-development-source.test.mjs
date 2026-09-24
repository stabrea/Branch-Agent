import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { offerSelfDevelopment, prepareBranchSourceChange } from "../dist/self-development.js";
import { ToolRegistry } from "../dist/registry.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const sha = "a".repeat(40);
const terms = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone", sideEffects: [], rollbackPlan: "Delete the worktree" };

const completed = (stdout = "") => ({ status: "completed", stdout, stderr: "", exitCode: 0, command: "git" });

test("an owner's fork becomes an isolated Branch Agent project without touching the installed app", async () => {
  let source = false, copy = false, upstream = false, pendingAtClone = false;
  const records = [];
  const calls = [], saved = [], active = [], sites = [];
  const deps = {
    workspace: "C:/owner/workspace", owner: "local",
    projects: { save: (_owner, project) => { saved.push(project); return project; }, setActive: (_owner, input) => { active.push(input); return input; } },
    registry: {}, policy: { assertAllowed: async (url) => { sites.push(url.href); } },
    contracts: new ContractBook(new DatabaseSync(":memory:")), store: { audit: { record: (_owner, entry) => { records.push(entry); } } },
    exists: async (path) => path.endsWith("branch-agent-source") ? source : path.includes(".branch-worktrees") ? copy : false,
    git: async ({ cwd, args }) => {
      calls.push([cwd, ...args]);
      if (args[0] === "clone") { source = true; pendingAtClone = records.some((entry) => entry.outcome === "pending"); return completed(); }
      if (args.join(" ") === "remote get-url origin") return completed("https://github.com/alice/Branch-Agent.git\n");
      if (args.join(" ") === "remote get-url upstream") return upstream ? completed("https://github.com/stabrea/Branch-Agent.git\n") : { ...completed(), status: "failed", stderr: "missing" };
      if (args.join(" ").startsWith("remote add upstream")) { upstream = true; return completed(); }
      if (args[0] === "worktree") { copy = true; return completed(); }
      if (args[0] === "rev-parse") return completed(`${sha}\n`);
      return completed();
    },
  };
  const input = { name: "remove-button", repository: "https://github.com/alice/Branch-Agent.git", base: "mac/cross-platform", contract: terms };
  const result = await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));

  assert.equal(result.ready, true);
  assert.equal(result.pullRequestTarget, "stabrea/Branch-Agent");
  assert.match(result.instructions, /Run the relevant focused tests and npm run build/);
  assert.ok(calls.some((call) => call.includes("clone")), "the owner's fork is cloned into the workspace, not the installation");
  assert.ok(calls.some((call) => call.join(" ").includes("remote add upstream https://github.com/stabrea/Branch-Agent.git")));
  assert.ok(calls.some((call) => call.join(" ").includes("fetch upstream mac/cross-platform")));
  assert.ok(calls.some((call) => call.join(" ").includes(`worktree add -b branch/self-remove-button .branch-worktrees/self-remove-button ${sha}`)),
    "the worktree is made at the exact commit the contract names");
  assert.ok(calls.some((call) => call.join(" ").includes("rev-parse --verify upstream/mac/cross-platform^{commit}")));
  assert.equal(result.contract.sourceSha, sha);
  assert.equal(pendingAtClone, true, "the proposed contract was written down as pending before anything was cloned");
  assert.match(records.find((entry) => entry.outcome === "pending").reason, /From alice\/Branch-Agent at mac\/cross-platform\. Paths src\/ui\/\*\*/);
  assert.equal(result.contract.worktreePath, "branch-agent-source/.branch-worktrees/self-remove-button");
  const contractAt = calls.findIndex((call) => call.includes("rev-parse")), worktreeAt = calls.findIndex((call) => call[1] === "worktree");
  assert.ok(contractAt >= 0 && contractAt < worktreeAt, "the contract is written before the worktree is made");
  assert.match(saved[0].folder, /^branch-agent-source\/\.branch-worktrees\//);
  assert.match(saved[0].instructions, /Why merge this/);
  assert.deepEqual(active, [{ active: "branch-agent-remove-button" }]);
  assert.ok(sites.every((site) => site.startsWith("https://github.com/")));

  const before = calls.length;
  await prepareBranchSourceChange(deps, input, AbortSignal.timeout(1000));
  await assert.rejects(prepareBranchSourceChange(deps, { ...input, contract: { ...terms, allowedPaths: ["**"] } }, AbortSignal.timeout(1000)),
    /already has a contract \(revision 1\)\. Different terms need branch\.widen_source_contract/, "wider terms are never silently reused");
  assert.equal(calls.slice(before).some((call) => call.includes("clone") || call.includes("worktree")), false,
    "retrying reuses the protected source and isolated copy");
});

test("the special workflow refuses a repository that is not Branch-Agent", async () => {
  const deps = { workspace: "C:/owner/workspace", owner: "local", projects: {}, registry: {}, policy: {}, git: async () => completed() };
  await assert.rejects(
    prepareBranchSourceChange(deps, { name: "x", repository: "https://github.com/alice/unrelated.git", base: "main", contract: terms }, AbortSignal.timeout(1000)),
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
  assert.equal(registry.names().includes("branch.widen_source_contract"), true);
  assert.equal(registry.targetOf("branch.prepare_source_change", { name: "remove-button" }, {}),
    join("C:/owner/workspace", "branch-agent-source", ".branch-worktrees", "self-remove-button"));
  registry.unregister("git.push");
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  assert.equal(registry.names().includes("branch.widen_source_contract"), false);
  stop();
});

test("Q187: a helper whose own context says owner, but whose task came from a chat, cannot prepare a source change", async () => {
  const registry = new ToolRegistry();
  const records = { chat: [{ kind: "run.started", data: { source: "channel" } }], mine: [{ kind: "run.started", data: { source: "owner" } }] };
  const store = { events: (runId) => records[runId] ?? [], run: () => undefined };
  const stop = offerSelfDevelopment({ workspace: "C:/owner/workspace", owner: "local", projects: {}, registry,
    policy: {}, git: async () => completed(), store, contracts: { current: () => null } });
  registry.register({ name: "git.push", permission: "git.remote", description: "test", parameters: z.object({}), execute: async () => ({}) });
  const input = { name: "x", repository: "https://github.com/alice/unrelated.git", base: "main", contract: terms };
  const call = (runId) => registry.execute("branch.prepare_source_change", input,
    { source: "owner", runId, owner: "local", permissions: new Set(["git.remote"]), signal: AbortSignal.timeout(1000), budget: { step: () => undefined, charge: () => undefined } });
  await assert.rejects(call("chat"), /Only the owner in the Branch app/, "the record leads back to a chat");
  await assert.rejects(call("mine"), (error) => !/Only the owner in the Branch app/.test(error.message), "control: the owner's own task gets past the check");
  stop();
});

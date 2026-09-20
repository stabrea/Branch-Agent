import test from "node:test";
import assert from "node:assert/strict";
import { offerSelfDevelopment, prepareBranchSourceChange } from "../dist/self-development.js";
import { ToolRegistry } from "../dist/registry.js";
import { z } from "zod";

const completed = (stdout = "") => ({ status: "completed", stdout, stderr: "", exitCode: 0, command: "git" });

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
  registry.unregister("git.push");
  assert.equal(registry.names().includes("branch.prepare_source_change"), false);
  stop();
});

/**
 * Q12: Branch's never-break check names its own service exactly. The owner's copy of Branch's source
 * (`branch-agent-source/...`) and the repository's name (`stabrea/Branch-Agent`) are not Branch's
 * service, so preparing a change to Branch is no longer refused as "stop Branch itself". Branch's
 * install folder, its service under every spelling the check knew, its process and its updater are
 * still refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
import { discardTemp } from "./temp-dir.mjs";

// The same areas the never-break tests use: a Linux install in /opt/branch, Branch's process 4242.
const areas = protectedAreas({ workspace: "/home/o/work", dataDir: "/home/o/.branch", installRoot: "/opt/branch",
  platform: "linux", selfPids: [4242, 4241] });
const check = (tool, args, target = "") => protectedTarget({ tool, readOnly: false, args, target }, areas);
const sh = (line) => check("shell.execute", { executable: "sh", args: ["-c", line] });
const stops = /stop, reinstall or update Branch itself/;
const worktree = "/home/o/work/branch-agent-source/.branch-worktrees/self-remove-button";
const contract = { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
  definitionOfDone: "The button is gone", sideEffects: [], rollbackPlan: "Remove the worktree" };

test("the owner's copy of Branch's source and the repository's name are not Branch's service", () => {
  assert.equal(check("branch.prepare_source_change", { name: "remove-button", repository: "https://github.com/stabrea/Branch-Agent.git",
    base: "mac/cross-platform", contract }, worktree), null, "the real prepare_source_change target shape");
  assert.equal(check("files.write", { path: `${worktree}/src/ui/button.ts`, content: "x" }), null);
  assert.equal(check("files.write", { path: "branch-agent-source/src/ui/button.ts", content: "x" }), null);
  assert.equal(check("github.pull_request_from_changes", { name: "self-remove-button", title: "Remove the button", summary: "Why merge this",
    targetRepository: "stabrea/Branch-Agent", base: "mac/cross-platform" }, "send changes to GitHub on branch/self-remove-button and open a pull request"), null);
  assert.equal(sh("git -C branch-agent-source/.branch-worktrees/self-remove-button status"), null);
  assert.equal(sh("npm test --prefix branch-agent-source"), null);
});

test("Branch's service, process, updater and install folder are still refused", () => {
  for (const line of [
    "systemctl --user stop branch-agent.service", "systemctl --user stop branch-agent", "launchctl bootout gui/501/com.keepoak.branch-agent",
    // Named only by the exact service name, with no service tool in front of it.
    "dbus-send --session --dest=org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager.StopUnit string:branch-agent.service string:replace",
    "rm ~/.config/systemd/user/branch-agent.service",
    "rm ~/Library/LaunchAgents/com.keepoak.branch-agent.plist",
    "node dist/cli.js daemon uninstall", "branch update", "pkill -f cli.js", "kill -9 4242",
  ]) assert.match(sh(line) ?? "", stops, line);
  assert.match(check("files.delete", { path: "/opt/branch/dist/cli.js" }) ?? "", /Branch's own files/, "the install folder");
  assert.match(check("files.write", { path: "/home/o/.branch/gateway.json", content: "{}" }) ?? "", /gateway's settings|Branch's own files/);
});

test("in the real app, preparing a change to Branch is no longer refused by the never-break check", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-self-never-break-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  app.registry.register({ name: "git.push", permission: "git.remote", description: "test double", parameters: z.object({}).passthrough(),
    execute: async () => ({}) });
  const run = app.store.createRun(app.runtime.owner, "change Branch");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  const verdict = app.runtime.checkPolicy("branch.prepare_source_change", { name: "remove-button", contract }, context, "fp-prepare");
  assert.notEqual(verdict.decision, "deny", verdict.reason);
  assert.doesNotMatch(verdict.reason ?? "", stops);
});

test("a global reinstall or removal of Branch through a package manager is refused, by name, tarball or folder", () => {
  for (const line of [
    "npm install -g branch-agent@latest", "npm i -g ./branch-agent-2.0.0.tgz", "pnpm add -g branch-agent@latest",
    "yarn global add branch-agent", "bun add -g branch-agent@2.0.0", "npm install -g ../branch-agent", "npm install branch-agent --global",
    "npm uninstall -g branch-agent", "npm update -g branch-agent",
    // The termux installer's own spelling: the package only through a variable, named earlier in the same command.
    'PACKAGE=./branch-agent-2.0.0.tgz; npm install -g "$PACKAGE"',
  ]) assert.match(sh(line) ?? "", stops, line);
  for (const line of ["npm install -g typescript", "npm install", "npm i -D @types/node", "npm test --prefix branch-agent-source"])
    assert.equal(sh(line), null, line);
});

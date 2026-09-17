import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, NetworkPolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  assertSafeHead, githubRepositoryOf, pullRequestFromChanges, pullRequestHookSettings,
  savePullRequestHookSettings, watchFinishedTasks,
} from "../dist/pr-hook.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

/* bucket-18 (A0300): pull requests opened from a task's changes. Git and GitHub are stand-ins. */

const scripted = () => ({ name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });

async function fixture(t, provider = scripted()) {
  const root = await mkdtemp(join(tmpdir(), "branch-pr-hook-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "data");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir, provider });
  const first = [];
  t.after(async () => { for (const close of first) await close(); await app.close(); await discardTemp(root); });
  return { app, workspace, dataDir, owner: app.runtime.owner, first };
}

/** A pretend Git: answers the questions, records every command, and can be told to fail one. */
function fakeGit(overrides = {}) {
  const calls = [];
  const answers = {
    "remote get-url": "git@github.com:acme/widgets.git",
    "symbolic-ref": "refs/remotes/origin/main",
    "status": " M src/a.ts\n?? notes.md\n",
    ...overrides,
  };
  const git = async (options) => {
    calls.push(options.args);
    const key = Object.keys(answers).find((prefix) => options.args.join(" ").startsWith(prefix));
    const answer = key === undefined ? "" : answers[key];
    if (answer instanceof Error) return { status: "failed", stdout: "", stderr: answer.message, exitCode: 1, command: "git" };
    return { status: "completed", stdout: answer, stderr: "", exitCode: 0, command: "git" };
  };
  return { git, calls };
}

/** Deps around a real app, with pretend Git and a pretend "open pull request" tool. */
function deps(app, git, options = {}) {
  const opened = [];
  if (!app.registry.names().includes("github.open_pull_request"))
    app.registry.register({
      name: "github.open_pull_request", permission: "github.manage", description: "stand-in",
      parameters: z.object({}).passthrough(), execute: async (args) => args,
    });
  return {
    opened,
    value: {
      store: app.store, owner: app.runtime.owner, files: app.files, git, registry: app.registry,
      policy: options.policy ?? new NetworkPolicy({ allowPrivateAddresses: true }),
      runTool: async (name, args) => { opened.push({ name, args }); return { number: 7, address: "https://github.com/acme/widgets/pull/7" }; },
    },
  };
}
const signal = () => AbortSignal.timeout(10000);

test("A0300 ships off: the tool refuses, nothing runs after a task, and the switch is saved", async (t) => {
  const { app, owner } = await fixture(t);
  assert.equal(pullRequestHookSettings(app.store, owner).mode, "off");
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  await assert.rejects(pullRequestFromChanges(d.value, { name: "x", title: "t", summary: "s", paths: ["a"], signal: signal() }), /switched off/);
  const stop = watchFinishedTasks(d.value);
  t.after(stop);
  const run = app.store.createRun(owner, "change a file");
  app.store.event(run.id, "file.changed", { path: "src/a.ts" });
  app.store.event(run.id, "run.finished", { status: "completed", output: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0, "Git was never asked anything");
  assert.equal(app.store.events(run.id).some((event) => event.kind.startsWith("pull_request.")), false);
  assert.throws(() => savePullRequestHookSettings(app.store, owner, { mode: "always" }));
  assert.equal(savePullRequestHookSettings(app.store, owner, { mode: "when-needed" }).mode, "when-needed");
});

test("A0300 on: a finished task's own files go to a new branch, are pushed by name and become one draft pull request", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "on" });
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const work = [];
  const stop = watchFinishedTasks(d.value, (job) => work.push(job()));
  t.after(stop);

  const run = app.store.createRun(owner, "Fix the widget total\nFixes https://github.com/acme/widgets/issues/12");
  app.store.event(run.id, "file.changed", { path: "src/a.ts" });
  app.store.event(run.id, "file.changed", { path: "src/a.ts" });
  app.store.event(run.id, "run.finished", { status: "completed", output: "" });
  await Promise.all(work);

  const head = `branch/task-${run.id.slice(0, 8)}`;
  const commands = calls.map((args) => args.join(" "));
  assert.ok(commands.includes(`switch --create ${head}`));
  assert.ok(commands.includes("add -- src/a.ts"), "only the file this task changed is committed, not the owner's other edits");
  assert.ok(commands.includes(`push --set-upstream origin refs/heads/${head}:refs/heads/${head}`), "the push names exactly the new branch");
  assert.equal(commands.filter((line) => line.startsWith("push")).length, 1);
  assert.equal(d.opened.length, 1);
  const args = d.opened[0].args;
  assert.equal(d.opened[0].name, "github.open_pull_request", "GitHub is reached only through the saved GitHub tool");
  assert.deepEqual([args.repo, args.base, args.head, args.draft, args.issue], ["acme/widgets", "main", head, true, "acme/widgets#12"]);
  assert.match(args.title, /^Branch: Fix the widget total$/);
  const opened = app.store.events(run.id).find((event) => event.kind === "pull_request.opened");
  assert.equal(opened.data.branch, head);

  // A failed task, or one that changed nothing, sends nothing.
  const failed = app.store.createRun(owner, "broken");
  app.store.event(failed.id, "file.changed", { path: "src/a.ts" });
  app.store.event(failed.id, "run.finished", { status: "failed", output: "" });
  const idle = app.store.createRun(owner, "just looking");
  app.store.event(idle.id, "run.finished", { status: "completed", output: "" });
  await Promise.all(work);
  assert.equal(d.opened.length, 1);
  assert.equal(commands.length, calls.length, "no Git command ran for either");
});

test("A0300 never sends to a shared or default branch", () => {
  for (const head of ["main", "branch/main", "branch/master", "branch/release", "branch/develop", "feature/x", "branch/a..b", "branch/x.lock"])
    assert.throws(() => assertSafeHead(head, "main", "main"), `${head} is refused`);
  assert.throws(() => assertSafeHead("branch/trunk-x", "branch/trunk-x", null), /shared branch/, "the base itself is refused");
  assert.throws(() => assertSafeHead("branch/stable", "main", "branch/stable"), /shared branch/, "the remote's default is refused");
  assert.doesNotThrow(() => assertSafeHead("branch/task-1234abcd", "main", "main"));
});

test("A0300 a failure is written to the task's log, and a base that is the new branch is refused before any push", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "on", base: "branch/task-00000000" });
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const work = [];
  const run = app.store.createRun(owner, "x");
  await assert.rejects(pullRequestFromChanges(d.value, { name: "task-00000000", title: "t", summary: "s", paths: ["src/a.ts"], signal: signal() }), /shared branch/);
  assert.equal(calls.some((args) => args[0] === "push" || args[0] === "switch"), false);

  savePullRequestHookSettings(app.store, owner, { mode: "on", base: "main" });
  const pushFails = fakeGit({ push: new Error("remote: Permission to acme/widgets denied") });
  const failing = deps(app, pushFails.git);
  t.after(watchFinishedTasks(failing.value, (job) => work.push(job())));
  app.store.event(run.id, "file.changed", { path: "src/a.ts" });
  app.store.event(run.id, "run.finished", { status: "completed", output: "" });
  await Promise.all(work);
  const failure = app.store.events(run.id).find((event) => event.kind === "pull_request.failed");
  assert.ok(failure, "the failure is in the log");
  assert.match(failure.data.reason, /Permission to acme\/widgets denied/);
  assert.equal(failing.opened.length, 0);
});

test("A0300 keys stay at the edge: a remote carrying a sign-in is refused, and the network rules decide first", async (t) => {
  assert.throws(() => githubRepositoryOf("https://x-access-token:ghp_SECRET@github.com/acme/widgets.git"), (error) => {
    assert.match(error.message, /carries a sign-in/);
    assert.equal(error.message.includes("ghp_SECRET"), false);
    return true;
  });
  assert.throws(() => githubRepositoryOf("https://gitlab.com/acme/widgets.git"), /not on GitHub/);
  assert.deepEqual(githubRepositoryOf("https://github.com/acme/widgets.git").repo, "acme/widgets");

  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  const leaky = fakeGit({ "remote get-url": "https://user:ghp_SECRET@github.com/acme/widgets.git" });
  await assert.rejects(pullRequestFromChanges(deps(app, leaky.git).value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal() }), /carries a sign-in/);
  assert.equal(leaky.calls.some((args) => args[0] === "push"), false);

  const { git, calls } = fakeGit();
  const blocked = deps(app, git, { policy: new NetworkPolicy({ allowPrivateAddresses: true, blockedHosts: ["github.com"] }) });
  await assert.rejects(pullRequestFromChanges(blocked.value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal() }), /blocked list/);
  assert.equal(calls.some((args) => args[0] === "push"), false);
  assert.equal(blocked.opened.length, 0);
});

test("A0300 a short-lived key can neither send work nor change the switch, directly or through a task", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "on" });
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const work = [];
  t.after(watchFinishedTasks(d.value, (job) => work.push(job())));
  await underShortLivedKey(async () => {
    await assert.rejects(pullRequestFromChanges(d.value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal() }), /short-lived key/);
    assert.throws(() => savePullRequestHookSettings(app.store, owner, { mode: "off" }), /short-lived key/);
    const run = app.store.createRun(owner, "x");
    app.store.event(run.id, "file.changed", { path: "src/a.ts" });
    app.store.event(run.id, "run.finished", { status: "completed", output: "" });
    assert.ok(app.store.events(run.id).some((event) => event.kind === "pull_request.skipped"), "the skip is logged");
  });
  await Promise.all(work);
  assert.equal(calls.length, 0);
  assert.equal(d.opened.length, 0);
});

test("A0300 the tool is only offered while GitHub is set up, so no GitHub permission appears without it", async (t) => {
  const { app } = await fixture(t);
  assert.equal(app.registry.names().includes("github.pull_request_from_changes"), false);
  assert.equal(app.registry.permissions().includes("github.manage"), false);
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in", parameters: z.object({}).passthrough(), execute: async () => ({}) });
  assert.equal(app.registry.names().includes("github.pull_request_from_changes"), true);
  app.registry.unregister("github.open_pull_request");
  assert.equal(app.registry.names().includes("github.pull_request_from_changes"), false);
});

test("A0300 over HTTP: a short-lived key is refused the switch, the tool, and the hook after its own task", async (t) => {
  let round = 0;
  const provider = { name: "scripted", async complete() {
    round += 1;
    if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
  const { app, owner, dataDir, first } = await fixture(t, provider);
  const server = await startServer(app, { dataDir, port: 0 });
  first.push(() => server.close());
  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 }).token;
  const call = (path, token, body) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const owned = await call("/api/developer/pull-requests", server.token, { mode: "on" });
  assert.equal(owned.status, 200);
  assert.equal((await owned.json()).mode, "on");
  const scripted = await call("/api/developer/pull-requests", key, { mode: "off" });
  assert.equal(scripted.status, 401);
  assert.match((await scripted.json()).error, /short-lived key/);
  assert.equal(pullRequestHookSettings(app.store, owner).mode, "on");

  // GitHub "set up": the stand-in makes the real tool appear, wired to the app's own Git and GitHub.
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in", parameters: z.object({}).passthrough(), execute: async () => assert.fail("GitHub was reached") });
  assert.ok(app.registry.names().includes("github.pull_request_from_changes"));
  const viaTool = await call("/api/action", key, { tool: "github.pull_request_from_changes", args: { name: "a", title: "t", summary: "s" } });
  assert.notEqual(viaTool.status, 200);
  assert.match(JSON.stringify(await viaTool.json()), /short-lived key/);

  const ran = await call("/api/run", key, { prompt: "write a note" });
  assert.equal(ran.status, 200);
  const run = await ran.json();
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.includes("file.changed"));
  assert.ok(kinds.includes("pull_request.skipped"), "the task a script started is never sent to GitHub");
  assert.equal(kinds.includes("pull_request.failed"), false);
});

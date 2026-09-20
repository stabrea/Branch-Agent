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
import { runOrigin, underShortLivedKey } from "../dist/key-context.js";
import { writeFile } from "node:fs/promises";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
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
  assert.ok(commands.includes("remote get-url --push --all origin"), "every push address is read, not only the fetch one");
  assert.ok(commands.includes("--literal-pathspecs add -- src/a.ts"), "only the file this task changed is added, not the owner's other edits");
  assert.ok(commands.includes("--literal-pathspecs commit --only --message Branch: Fix the widget total -- src/a.ts"),
    "only that file is committed, whatever else was staged");
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

test("A0300 a contributor can push to their fork and open the draft against upstream", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  const { git, calls } = fakeGit({ "remote get-url": "https://github.com/alice/Branch-Agent.git" });
  const d = deps(app, git);
  const opened = await pullRequestFromChanges(d.value, {
    name: "remove-button", title: "fix(ui): remove unused button",
    summary: "## Why merge this\nThe unused control confuses owners.", paths: ["src/a.ts"], signal: signal(),
    targetRepository: "stabrea/Branch-Agent", base: "mac/cross-platform",
  });
  assert.equal(opened.repository, "stabrea/Branch-Agent");
  assert.deepEqual(
    [d.opened[0].args.repo, d.opened[0].args.base, d.opened[0].args.head, d.opened[0].args.draft],
    ["stabrea/Branch-Agent", "mac/cross-platform", "alice:branch/remove-button", true],
  );
  assert.ok(calls.some((args) => args.join(" ") === "push --set-upstream origin refs/heads/branch/remove-button:refs/heads/branch/remove-button"));
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
  // The app's own watcher (real Git, no repository here) may log its failure first, so look at them all.
  const failures = app.store.events(run.id).filter((event) => event.kind === "pull_request.failed");
  assert.ok(failures.length, "the failure is in the log");
  assert.ok(failures.some((event) => /Permission to acme\/widgets denied/.test(event.data.reason)),
    `the push failure is logged: ${failures.map((event) => event.data.reason).join(" | ")}`);
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

/* ---- Integration review (bucket 18): holes found after the builder's round. ---- */

test("A0300 review: secrets, Branch's own files, folders and wildcards never leave in a pull request", async (t) => {
  const { app, owner, workspace } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "prog", "dist"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(workspace, ".env"), "TOKEN=1\n");
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const areas = protectedAreas({ workspace, dataDir: join(workspace, "..", "data"), installRoot: join(workspace, "prog") });
  d.value.guard = (path) => protectedTarget({ tool: "files.write", readOnly: false, args: { path }, target: path, workspace }, areas);
  const opened = await pullRequestFromChanges(d.value, { name: "fix", title: "t", summary: "s", signal: signal(),
    paths: [".env", "config/id_rsa", "keys/deploy.pem", "*", "src", "src/", "prog/dist/index.js", "src/a.ts"] });
  assert.deepEqual(opened.files, ["src/a.ts"]);
  const add = calls.find((args) => args.includes("add"));
  assert.deepEqual(add, ["--literal-pathspecs", "add", "--", "src/a.ts"]);
  const commit = calls.find((args) => args.includes("commit"));
  assert.deepEqual(commit.slice(-2), ["--", "src/a.ts"]);

  // Nothing left to send: nothing is switched, added or pushed.
  const none = fakeGit();
  await assert.rejects(pullRequestFromChanges(deps(app, none.git).value, { name: "fix2", title: "t", summary: "s", paths: [".env"], signal: signal() }), /no changed files/);
  assert.equal(none.calls.some((args) => args.includes("switch") || args.includes("push")), false);
  // Without paths, what `git status` lists goes through the same checks.
  const status = fakeGit({ status: " M .env\n?? src/\n M src/a.ts\n" });
  const fromStatus = await pullRequestFromChanges(deps(app, status.git).value, { name: "fix3", title: "t", summary: "s", paths: null, signal: signal() });
  assert.deepEqual(fromStatus.files, ["src/a.ts"]);
});

test("A0300 review: every push address must be the same GitHub repository", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "when-needed" });
  const elsewhere = fakeGit({ "remote get-url": "git@github.com:acme/widgets.git\nhttps://gitlab.example.com/acme/widgets.git\n" });
  await assert.rejects(pullRequestFromChanges(deps(app, elsewhere.git).value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal() }), /not on GitHub/);
  const twice = fakeGit({ "remote get-url": "git@github.com:acme/widgets.git\nhttps://github.com/evil/copy.git\n" });
  await assert.rejects(pullRequestFromChanges(deps(app, twice.git).value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal() }), /more than one repository/);
  for (const calls of [elsewhere.calls, twice.calls]) assert.equal(calls.some((args) => args.includes("push") || args.includes("switch")), false);
});

/** A model that waits for a signal before it answers, so a conversation can be kept busy. */
function gated() {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  let first = true;
  return { open: () => open(), provider: { name: "gated", async complete() {
    if (first) { first = false; await gate; }
    return { content: "Done.", toolCalls: [] };
  } } };
}
const startOf = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started")?.data ?? {};
const waitFor = async (check) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); return check(); };

test("A0300 review: a short-lived key's mark is kept on the task, so later work started from it is never sent", async (t) => {
  const model = gated();
  const { app, owner } = await fixture(t, model.provider);
  savePullRequestHookSettings(app.store, owner, { mode: "on" });
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const work = [];
  t.after(watchFinishedTasks(d.value, (job) => work.push(job())));

  // A follow-up queued with a short-lived key while the owner's task holds the conversation.
  const busy = app.runtime.run({ prompt: "owner's long task" });
  const ownerRun = await waitFor(() => [...app.store.sqlite.prepare("SELECT id, session_id FROM tasks WHERE prompt=?").all("owner's long task")][0]);
  underShortLivedKey(() => app.runtime.followUp(ownerRun.session_id, "script's follow-up"));
  model.open();
  await busy;
  const follow = await waitFor(() => app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt=?").get("script's follow-up"));
  assert.ok(await waitFor(() => app.store.events(follow.id).some((event) => event.kind === "run.finished")));
  assert.equal(startOf(app, follow.id).shortLivedKey, true, "the follow-up started outside the request still carries the mark");
  assert.equal(startOf(app, ownerRun.id).shortLivedKey, undefined, "the owner's own task is not marked");

  // A background specialist of a marked task, and a task continued from one, inherit it.
  const parent = app.store.createRun(owner, "marked parent");
  app.store.event(parent.id, "run.started", { parentRunId: null, source: "owner", shortLivedKey: true, permissions: [] });
  const child = await app.runtime.delegateBackground("help", app.runtime.context({ runId: parent.id }), [], "");
  assert.ok(await waitFor(() => startOf(app, child.childRunId).parentRunId === parent.id));
  assert.equal(startOf(app, child.childRunId).shortLivedKey, true);
  assert.equal(runOrigin(app.store, child.childRunId).shortLivedKey, true);

  // Afterwards, outside any request, the finished follow-up is skipped by what it recorded.
  app.store.event(follow.id, "file.changed", { path: "src/a.ts" });
  app.store.event(follow.id, "run.finished", { status: "completed", output: "" });
  await Promise.all(work);
  const skipped = app.store.events(follow.id).find((event) => event.kind === "pull_request.skipped");
  assert.match(skipped?.data.reason ?? "", /short-lived key/);
  // And the tool refuses for a task that recorded the mark.
  await assert.rejects(pullRequestFromChanges(d.value, { name: "a", title: "t", summary: "s", paths: ["x"], signal: signal(), runId: follow.id }), /short-lived key/);
  assert.equal(calls.length, 0);
  assert.equal(d.opened.length, 0);
});

test("A0300 review: a task queued with a short-lived key keeps the mark when the line starts it later", async (t) => {
  const model = gated();
  const { app, owner } = await fixture(t, model.provider);
  app.runQueue.configure(owner, { atOnce: 1 });
  app.runQueue.submit(owner, { prompt: "owner first" });
  const queued = underShortLivedKey(() => app.runQueue.submit(owner, { prompt: "script second" }));
  assert.equal(queued.status, "waiting");
  model.open();
  const second = await waitFor(() => app.runQueue.entry(owner, queued.id)?.runId);
  assert.ok(second);
  assert.ok(await waitFor(() => startOf(app, second).shortLivedKey === true), "started by the owner's finishing task, still marked");
  const first = app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt=?").get("owner first");
  assert.equal(startOf(app, first.id).shortLivedKey, undefined);
});

test("A0300 review: only the owner's own tasks that may publish are sent by themselves", async (t) => {
  const { app, owner } = await fixture(t);
  savePullRequestHookSettings(app.store, owner, { mode: "on" });
  const { git, calls } = fakeGit();
  const d = deps(app, git);
  const work = [];
  t.after(watchFinishedTasks(d.value, (job) => work.push(job())));
  const chat = await app.runtime.run({ prompt: "from a chat app", permissions: app.registry.permissions().filter((p) => p !== "github.manage") });
  const scheduled = await app.runtime.run({ prompt: "from a schedule", source: "schedule" });
  const triggered = await app.runtime.run({ prompt: "from a comment", source: "trigger" });
  assert.equal(startOf(app, scheduled.id).source, "schedule");
  const expected = [[chat, /not allowed to publish/], [scheduled, /a schedule/], [triggered, /a trigger/]];
  for (const [run] of expected) {
    app.store.event(run.id, "file.changed", { path: "src/a.ts" });
    app.store.event(run.id, "run.finished", { status: "completed", output: "" });
  }
  await Promise.all(work);
  for (const [run, reason] of expected)
    assert.match(app.store.events(run.id).find((event) => event.kind === "pull_request.skipped")?.data.reason ?? "", reason);
  assert.equal(calls.length, 0);
  assert.equal(d.opened.length, 0);
});

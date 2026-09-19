import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/coding-next: coding reliability, round 2 (docs/agents/STATUS-coding-next.md). Nothing here
 * starts Electron or a real program: every outside program is a fake that records what it was
 * handed, which is the only way to check the environment a child would have been given.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-next-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

const contextOf = (app, extra = {}) => ({
  owner: "local", workspace: app?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly what it was asked. */
function fakeWorld() {
  const calls = [];
  const probe = async () => ({ code: null, stdout: "", stderr: "", missing: true });
  const spawn = async (options) => {
    calls.push(options);
    return { status: "completed", exitCode: 0, stdout: "3\n", stderr: "", truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn };
}

/** Runs `work` as if inside the desktop app, where process.versions says which Electron it is. */
async function asDesktopApp(work) {
  Object.defineProperty(process.versions, "electron", { value: "99.0.0", configurable: true, enumerable: true });
  try { return await work(); } finally { delete process.versions.electron; }
}

// ------------------------------------------------------------------ 5. code.run runs as Node

test("5 runAsNode adds ELECTRON_RUN_AS_NODE only for this program, and only inside the desktop app", async () => {
  const { runAsNode } = await import("../dist/child-env.js");
  assert.deepEqual(runAsNode(process.execPath), {}, "plain Node needs nothing");
  await asDesktopApp(async () => {
    assert.deepEqual(runAsNode(process.execPath), { ELECTRON_RUN_AS_NODE: "1" });
    assert.deepEqual(runAsNode("C:/Python/python.exe"), {}, "another program is left alone");
  });
});

test("5 code.run inside the desktop app starts this program as Node, not a second app", async (t) => {
  const { app, workspace } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld();
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  await asDesktopApp(() => runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app)));
  const started = world.calls.at(-1);
  assert.equal(started.executable, process.execPath);
  assert.equal(started.env.ELECTRON_RUN_AS_NODE, "1", "without it the packaged app would start itself again");
  // Outside the desktop app nothing extra is handed on.
  await runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app));
  assert.equal(world.calls.at(-1).env.ELECTRON_RUN_AS_NODE, undefined);
});

// ------------------------------------------------------------------ 6. crash capture is a switch

test("6 crash capture ships off: a crash writes no note, and with the log off nothing at all", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-off-"));
  t.after(() => discardTemp(dir));
  assert.equal(DiagnosticLogSettingsSchema.parse({}).crashCapture, "off");
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({}) });
  log.write({ level: "info", component: "tasks", message: "step one" });
  log.crash("engine", new Error("boom"));
  assert.deepEqual(log.crashes(), []);
  assert.deepEqual(await readdir(dir).catch(() => []), [], "off writes no file");
  // With the log on, the crash is still an ordinary log line — just no crash note.
  const logged = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on" }) });
  logged.crash("engine", new Error("boom"));
  assert.equal(logged.crashes().length, 0);
  assert.match(logged.read()[0].message, /Crashed: Error: boom/);
  // On: the note is written.
  const on = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ crashCapture: "on" }) });
  on.crash("engine", new Error("boom"));
  assert.equal(on.crashes().length, 1);
});

test("6 saving the log's mode keeps crash capture; the switch file tells the desktop app at its next start", async (t) => {
  const { diagnosticApi } = await import("../dist/diagnostic-api.js");
  const { crashReporterPlan, crashCaptureMarked } = await import("../dist/diagnostic-log.js");
  const dataDir = await mkdtemp(join(tmpdir(), "branch-crash-mark-"));
  t.after(() => discardTemp(dataDir));
  const saved = new Map();
  const app = { version: "9", runtime: { owner: "me" }, store: {
    profiles: { requireOwner() {} },
    get: (_table, _owner, key) => saved.has(key) ? { data: saved.get(key) } : undefined,
    save: (_table, _owner, key, data) => { saved.set(key, data); },
  } };
  const post = (body) => diagnosticApi({ app, dataDir, installType: "x", startedAt: 0 }, "POST", "/api/diagnostics/log/settings",
    new URL("http://local/api/diagnostics/log/settings"), async () => body);
  assert.equal(crashReporterPlan(dataDir), null, "never switched on: the reporter is not started");
  assert.equal((await post({ crashCapture: "on" })).crashCapture, "on");
  assert.equal(crashCaptureMarked(dataDir), true);
  assert.equal(crashReporterPlan(dataDir).uploadToServer, false, "on: started, and still never uploads");
  const after = await post({ mode: "when-needed", keepDays: 7 });
  assert.equal(after.crashCapture, "on", "changing the log's mode must not switch crash capture off");
  assert.equal(after.maxMegabytes, 20);
  await post({ crashCapture: "off" });
  assert.equal(crashReporterPlan(dataDir), null);
});

test("6 Report a problem still works with crash capture off: it just has no crash files to offer", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { gatherReport } = await import("../dist/diagnostic-report.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-report-"));
  t.after(() => discardTemp(dir));
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({}) });
  log.crash("engine", new Error("boom"));
  const items = await gatherReport({ version: "9", dataDir: dir, installType: "x", log, logMode: "off",
    health: async () => ({ ok: true, items: [] }), settings: () => ({}), services: () => ({}), events: () => ({ events: [] }),
    crashDumpsDir: null, resolve: null });
  const crashes = items.find((item) => item.id === "crashes");
  assert.match(crashes.title, /0 noted, 0 crash files/);
});

// ------------------------------------------------------------------ 3. a local model's first reply

/** An OpenAI-shaped server on this computer that says nothing for `delay()` ms, then streams "hello". */
async function slowLocalServer(t, delay) {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    request.resume();
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, delay());
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("3 a model on this computer gets a longer first-reply wait, and the person is told it may be loading", async (t) => {
  const { app } = await fixture(t, { reliability: { stallRecovery: "fail" } });
  const { OpenAIProvider } = await import("../dist/providers.js");
  const endpoint = await slowLocalServer(t, () => 900);
  app.runtime.models.register({ id: "on-this-computer", name: "Local", model: "m",
    provider: new OpenAIProvider({ endpoint, model: "m", apiKey: "local" }) });
  // Shortened for the test (the shipped figures are 60 s and 300 s): silence for 300 ms is a stall,
  // except before a local model's first word, which may take 2 s.
  app.runtime.reliability.modelStallMs = 300;
  app.runtime.reliability.localFirstReplyMs = 2000;
  const run = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "hello");
  const loading = app.store.events(run.id).filter((event) => event.kind === "model.loading");
  assert.equal(loading.length, 1, "told once, while nothing had been heard");
  assert.match(loading[0].data.message, /loading into memory/);
  assert.ok(!app.store.events(run.id).some((event) => event.kind === "model.stalled"));

  // With the first-reply wait shorter than the load, it is a stall, as before.
  app.runtime.reliability.localFirstReplyMs = 500;
  const stalled = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  assert.equal(stalled.status, "failed");
  assert.ok(app.store.events(stalled.id).some((event) => event.kind === "model.stalled"));
});

test("3 a hosted model's wait is unchanged: its first silence is the ordinary stall time", async (t) => {
  const { app } = await fixture(t, { reliability: { stallRecovery: "fail" } });
  const slowHosted = { name: "hosted", async complete(request) {
    await new Promise((done, fail) => {
      const timer = setTimeout(done, 900);
      request.signal.addEventListener("abort", () => { clearTimeout(timer); fail(request.signal.reason); }, { once: true });
    });
    request.onTextDelta?.("late");
    return { content: "late", toolCalls: [] };
  } };
  app.runtime.models.register({ id: "hosted", name: "Hosted", provider: slowHosted, model: "h" });
  app.runtime.reliability.modelStallMs = 300;
  app.runtime.reliability.localFirstReplyMs = 5000;
  const run = await app.runtime.run({ prompt: "hi", model: "hosted", onTextDelta: () => undefined });
  assert.equal(run.status, "failed");
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.includes("model.stalled"));
  assert.ok(!kinds.includes("model.loading"), "a hosted model is never said to be loading");
});

test("3 the watchdog: the first window can be longer; after the first piece the ordinary clock runs", async () => {
  const { withStallWatchdog, StallError } = await import("../dist/reliability.js");
  const never = new AbortController().signal;
  const wait = (ms, signal) => new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
  });
  await assert.rejects(withStallWatchdog(never, 100, (signal) => wait(300, signal)), StallError);
  assert.equal(await withStallWatchdog(never, 100, async (signal) => { await wait(300, signal); return "ok"; }, { firstMs: 1000 }), "ok");
  // Once something was heard, a long silence is a stall again even though the first window was long.
  await assert.rejects(withStallWatchdog(never, 100, async (signal, touch) => { touch(); await wait(300, signal); }, { firstMs: 1000 }), StallError);
});

test("3 the owner's setting: localFirstReplySeconds overrides the launch figure; empty keeps it", async (t) => {
  const { app } = await fixture(t);
  const { saveKnobs } = await import("../dist/knobs/settings.js");
  const { localFirstReplyMs } = await import("../dist/knobs/apply.js");
  assert.equal(app.runtime.reliability.localFirstReplyMs, 300_000, "ships at 300 s");
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 300_000);
  saveKnobs(app.store, "local", "limits", { localFirstReplySeconds: 45 });
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 45_000);
  saveKnobs(app.store, "local", "limits", { localFirstReplySeconds: null });
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 300_000);
});

// ------------------------------------------------------------------ 2. unknown tool arguments

/** A provider driven by a script of answers, one per round; the last one repeats. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const toolMessages = (app, run) => app.store.messages(run.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));

test("2 clean: unknown keys are dropped, and only when what is left is a valid call", async (t) => {
  const { app } = await fixture(t);
  const clean = (name, args) => app.registry.clean(name, args);
  assert.deepEqual(clean("files.read", { path: "a.txt", format: "js" }), { args: { path: "a.txt" }, ignored: ["format"] });
  assert.deepEqual(clean("files.read", { path: "a.txt" }), { args: { path: "a.txt" }, ignored: [] }, "a clean call is untouched");
  // A wrong type or a missing field is left exactly as sent, so the call is refused as before.
  assert.deepEqual(clean("files.read", { path: 5, format: "js" }), { args: { path: 5, format: "js" }, ignored: [] });
  assert.deepEqual(clean("files.read", { format: "js" }), { args: { format: "js" }, ignored: [] });
  // Inside a list, and through files.edit's own argument names.
  const set = clean("code.change_set", { reason: "r", edits: [{ path: "a", find: "x", replace: "y", line: 3 }], why: "?" });
  assert.deepEqual(set.ignored.sort(), ["edits.0.line", "why"]);
  assert.deepEqual(set.args, { reason: "r", edits: [{ path: "a", find: "x", replace: "y" }] });
  const edit = clean("files.edit", { file_path: "a", old_string: "x", new_string: "y", mode: "fast" });
  assert.deepEqual(edit.ignored, ["mode"]);
  assert.equal(edit.args.old_string, "x", "the other agents' names still reach files.edit's own mapping");
});

test("2 a call with an extra key runs, and the model is told in one line what was ignored", async (t) => {
  const provider = scripted([call("files.read", { path: "notes.txt", format: "text" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "hello");
  const run = await app.runtime.run({ prompt: "read notes.txt" });
  assert.equal(run.status, "completed", run.output);
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.content, "hello");
  assert.equal(answer.note, "Ignored an argument this tool does not take: format.");
  assert.deepEqual(app.store.events(run.id).find((event) => event.kind === "tool.arguments_ignored").data.keys, ["format"]);
});

test("2 a wrong type is still refused, extra key or not", async (t) => {
  const provider = scripted([call("files.read", { path: 42, format: "text" }), say("done")]);
  const { app } = await fixture(t, { provider });
  const run = await app.runtime.run({ prompt: "read" });
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, false);
  assert.match(answer.error, /path/);
  assert.equal(answer.note, undefined);
});

test("2 an unknown key cannot steer the permission check: the rule sees the cleaned call", async (t) => {
  // files.write takes no `url`. Were the raw arguments judged, the target would be the url's host
  // (policyTarget reads `url` before `path`) and the owner's refusal for this file would be missed.
  const provider = scripted([call("files.write", { path: "keep.txt", content: "overwritten", url: "https://trusted.example/" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  const { addPolicyRule } = await import("../dist/policy.js");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "keep.txt"), "original");
  addPolicyRule(app.store, "local", { tool: "files.write", match: "keep.txt", decision: "deny", remember: "always" });
  const run = await app.runtime.run({ prompt: "write" });
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "original");
  const denied = app.store.events(run.id).find((event) => event.kind === "policy.denied");
  assert.equal(denied?.data.target, "keep.txt");
});

// ------------------------------------------------------------------ 1. read before edit

/** A workspace with `a.txt` in it, the read-before-edit switch set to `mode`, and a scripted model. */
async function readFirstFixture(t, steps, mode = "on") {
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "a.txt"), "one\n");
  saveCodingMode(app.store, "local", "read-first", mode);
  return { app, workspace };
}
const fileText = async (workspace, name) => (await import("node:fs/promises")).readFile(join(workspace, name), "utf8");
const edit = (find, replace) => call("files.edit", { path: "a.txt", find, replace });

test("1 read-first ships off: an edit to an unread file goes through as before", async (t) => {
  const { codingMode } = await import("../dist/coding/settings.js");
  const { app, workspace } = await readFirstFixture(t, [edit("one", "two"), say("done")], "off");
  assert.equal(codingMode({ get: () => undefined }, "local", "read-first"), "off");
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(toolMessages(app, run)[0].ok, true);
  assert.equal(await fileText(workspace, "a.txt"), "two\n");
});

test("1 read-first on: an unread file is refused, in a sentence that says to read it first", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    edit("one", "two"),
    call("files.write", { path: "a.txt", content: "whole\n" }),
    call("files.patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n" }),
    call("code.change_set", { reason: "r", edits: [{ path: "a.txt", find: "one", replace: "two" }] }),
    say("done")]);
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.equal(answers.length, 4);
  for (const answer of answers) {
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.match(answer.error, /read "a\.txt" with files\.read first/);
  }
  assert.equal(await fileText(workspace, "a.txt"), "one\n", "nothing was changed");
});

test("1 read-first on: after a read the edit goes through, and the task's own change counts as read", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }), edit("one", "two"), edit("two", "three"),
    call("files.write", { path: "a.txt", content: "four\n" }), say("done")]);
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "a.txt"), "four\n");
});

test("1 read-first on: a change made by someone else after the read is refused until it is read again", async (t) => {
  let workspaceDir = "";
  const { writeFile } = await import("node:fs/promises");
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }),
    async () => { await writeFile(join(workspaceDir, "a.txt"), "one\nadded by a person\n"); return edit("one", "two")(); },
    call("files.read", { path: "a.txt" }), edit("one", "two"), say("done")]);
  workspaceDir = workspace;
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.equal(answers[1].ok, false);
  assert.match(answers[1].error, /has changed since this task last read it/);
  assert.equal(answers[3].ok, true, "read again, the edit goes through");
  assert.equal(await fileText(workspace, "a.txt"), "two\nadded by a person\n");
});

test("1 read-first on: a new file needs no read", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("files.write", { path: "new.txt", content: "fresh\n" }),
    call("files.edit", { path: "made.txt", find: "", replace: "made\n" }),
    call("code.patch", { patch: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch\n" }),
    say("done")]);
  const run = await app.runtime.run({ prompt: "make files" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "new.txt"), "fresh\n");
  assert.equal(await fileText(workspace, "made.txt"), "made\n");
  assert.equal(await fileText(workspace, "added.txt"), "added\n");
});

test("1 read-first on: a file tidied after the task's own edit (format-on-edit) still counts as read", async (t) => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }), edit("one", "two"), edit("TWO", "three"), say("done")]);
  // Stands in for a formatter run after every edit (src/coding/format-on-edit.ts), which rewrites the file.
  const before = app.registry.afterTool;
  app.registry.afterTool = async (name, args, result, context) => {
    if (name === "files.edit") await writeFile(join(workspace, "a.txt"), (await readFile(join(workspace, "a.txt"), "utf8")).toUpperCase());
    return before ? before(name, args, result, context) : result;
  };
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "a.txt"), "THREE\n");
});

// ------------------------------------------------------------------ 4. "Let Branch run this project's tests?"

/** A Node project with one passing test, the script switch left off (as shipped), and a scripted model. */
async function testsFixture(t, steps) {
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  await writeFile(join(workspace, "test", "a.test.mjs"), 'import test from "node:test";\ntest("adds", () => {});\n');
  return { app, workspace };
}
const asked = (app, run) => app.store.events(run.id).filter((event) => event.kind === "policy.ask");
const ranTests = (app, run) => app.store.events(run.id).some((event) => event.kind === "code.check");

test("4 the tests are not run until the person says yes; Once lets the next run go and then asks again", async (t) => {
  const check = call("code.check", {});
  const { app, workspace } = await testsFixture(t, [check, check, say("done"), check]);
  const first = await app.runtime.run({ prompt: "fix it" });
  assert.equal(first.status, "needs_input");
  assert.equal(ranTests(app, first), false, "nothing ran before the answer");
  const [question] = asked(app, first);
  assert.equal(question.data.kind, "project-tests");
  assert.equal(question.data.name, "code.tests");
  assert.equal(question.data.target, workspace);
  assert.match(question.data.question, /^Let Branch run this project's tests\?/);
  app.runtime.approve(first.sessionId, "allow", "never");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.equal(ranTests(app, second), true);
  const [answer] = toolMessages(app, second).slice(-1);
  assert.equal(answer.result.ran, true);
  assert.equal(answer.result.ok, true, answer.result.output);
  const third = await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
  assert.equal(third.status, "needs_input", "Once was used up");
});

test("4 Always for this folder is kept: later conversations run the tests without asking", async (t) => {
  const check = call("code.check", {});
  const { app, workspace } = await testsFixture(t, [check, check, say("done"), check, say("done")]);
  const first = await app.runtime.run({ prompt: "fix it" });
  app.runtime.approve(first.sessionId, "allow", "always");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests" && rule.match === workspace && rule.decision === "allow"));
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(ranTests(app, second), true);
  const elsewhere = await app.runtime.run({ prompt: "a new conversation" });
  assert.equal(elsewhere.status, "completed", elsewhere.output);
  assert.equal(asked(app, elsewhere).length, 0);
  assert.equal(ranTests(app, elsewhere), true);
});

test("4 No is remembered for the conversation: the task is told, and not asked again", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, check, say("done")]);
  const first = await app.runtime.run({ prompt: "fix it" });
  app.runtime.approve(first.sessionId, "deny", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.equal(asked(app, second).length, 0);
  assert.equal(ranTests(app, second), false);
  const [answer] = toolMessages(app, second).slice(-1);
  assert.equal(answer.result.ran, false);
  assert.match(answer.result.note, /chose not to let Branch run this project's tests/);
});

test("4 Always cannot be given from a chat app or for a task a chat app started; Once still can", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check]);
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", undefined, "telegram"), /Only the owner, in the app/);
  const fromChat = await app.runtime.run({ prompt: "fix it", source: "channel" });
  assert.equal(fromChat.status, "needs_input");
  assert.throws(() => app.runtime.approve(fromChat.sessionId, "allow", "always"), /standing yes|Only the owner/);
  app.runtime.approve(fromChat.sessionId, "allow", "never");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(!readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests"), "no standing rule was written");
});

test("4 Lockdown refuses without asking; the script switch on runs the tests as before", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, say("done"), check, say("done")]);
  app.store.save("settings", "local", "lockdown", { on: true });
  const locked = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, locked).length, 0, "not asked");
  assert.equal(ranTests(app, locked), false);
  app.store.save("settings", "local", "lockdown", { on: false });
  const { saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const scripts = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, scripts).length, 0, "the owner already said yes to running scripts");
  assert.equal(ranTests(app, scripts), true);
});

test("1 read-first on: a file the task had tidied with code.format still counts as read", async (t) => {
  const { app, workspace } = await fixture(t);
  const { EditChecks } = await import("../dist/coding/format-on-edit.js");
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "..", "bin"), { recursive: true });
  const formatter = join(workspace, "..", "bin", "fmt");
  await writeFile(formatter, "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(workspace, "src", "a.ts"), "const  a =  1;\n");
  saveCodingMode(app.store, "local", "read-first", "on");
  saveCodingMode(app.store, "local", "format-on-edit", "on");
  // A formatter that squeezes spaces, started through a stand-in for the wall (no program runs).
  const runner = async (run) => {
    const file = run.args.at(-1);
    await writeFile(file, (await readFile(file, "utf8")).replace(/  +/g, " "));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const checks = new EditChecks({ store: app.store, owner: "local", files: app.coding["deps"].files, runner,
    areas: () => app.runtime.protectedAreas, servers: { enabled: () => false }, trusted: () => true,
    wall: () => ({ network: "none" }), walled: async (run, start) => run(start) });
  await checks.save({ formatters: { fmt: { path: formatter, args: ["{file}"], extensions: [".ts"] } } });
  const task = app.store.createRun("local", "tidy and edit");
  const context = contextOf(app, { runId: task.id, permissions: new Set(["files.read", "files.write"]) });
  await app.registry.execute("files.read", { path: "src/a.ts" }, context);
  // What code.format does, then what the registry does after every call.
  assert.equal((await checks.check("src/a.ts", context)).reformatted, true);
  await app.registry.afterWrites(context);
  const edited = await app.registry.execute("files.edit", { path: "src/a.ts", find: "a = 1", replace: "a = 2" }, context);
  assert.equal(edited.path, "src/a.ts");
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "const a = 2;\n");
});

// ------------------------------------------------------------------ integration review (adversarial)

test("review 5 every place that starts this program to run a script says to run it as Node", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
  walk("src");
  const starts = /(?:spawn|execFile|execFileSync|spawnSync|fork|runBenchmarkCommand)\(\s*process\.execPath|(?:executable|command):\s*process\.execPath/;
  // The Linux wall's door bridge: its environment is put together further down, in linuxWall.
  const bridge = (line) => line.includes("executable: process.execPath, args: [bridge,");
  assert.match(readFileSync(join("src", "sandbox-backends.ts"), "utf8"), /proxyEnvironment\([^\n]*runAsNode\(process\.execPath\)/);
  const missing = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!starts.test(line) || bridge(line)) return;
      const near = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
      if (!/runAsNode\(|ELECTRON_RUN_AS_NODE/.test(near)) missing.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(missing, [], "inside the desktop app these would open a second copy of the app");
});

test("review 2 a key that respells one the tool takes, or asks for nothing to really happen, is never dropped", async (t) => {
  const { app } = await fixture(t);
  const clean = (name, args) => app.registry.clean(name, args);
  for (const [name, args] of [
    ["code.patch", { patch: "x", dry_run: true }],
    ["code.change_set", { reason: "r", edits: [{ path: "a", find: "x", replace: "y" }], "dry-run": true }],
    ["files.write", { path: "a.txt", content: "x", preview: true }],
    ["files.edit", { path: "a.txt", find: "x", replace: "y", replace_all: true }],
  ]) assert.deepEqual(clean(name, args), { args, ignored: [] }, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(clean("files.read", { path: "a.txt", format: "js" }).ignored, ["format"], "a key that means nothing still goes");
});

test("review 2 a patch sent with dry_run is refused, not applied for real", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("code.patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n", dry_run: true }), say("done")], "off");
  const run = await app.runtime.run({ prompt: "show me the change" });
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(await fileText(workspace, "a.txt"), "one\n");
});

test("review 2 the question shows the call as it will run, without the ignored key; the yes stays bound to what was sent", async (t) => {
  const sent = { path: "keep.txt", content: "new", format: "markdown" };
  const provider = scripted([call("files.write", sent), say("done")]);
  const { app } = await fixture(t, { provider });
  const { addPolicyRule } = await import("../dist/policy.js");
  const { argumentFingerprint } = await import("../dist/runtime.js");
  addPolicyRule(app.store, "local", { tool: "files.write", match: "keep.txt", decision: "ask", remember: "never" });
  const run = await app.runtime.run({ prompt: "write" });
  assert.equal(run.status, "needs_input");
  const [question] = asked(app, run);
  assert.deepEqual(JSON.parse(question.data.bytes), { path: "keep.txt", content: "new" });
  assert.equal(question.data.fingerprint, argumentFingerprint(JSON.stringify(sent)));
});

test("review 4 a plain yes with no choice made is Once; carrying a workflow on never writes a standing rule", async (t) => {
  const { app, workspace } = await testsFixture(t, [call("code.check", {})]);
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, run)[0].data.remember, "never", "the terminal's y and other defaults answer Once");
  const flow = app.workflows.create("local", { name: "check it", steps: [{ name: "tests", kind: "tool", tool: "code.check", args: {} }] });
  const waiting = await app.workflows.run("local", flow.id);
  assert.equal(waiting.status, "waiting_approval");
  const done = await app.workflows.resume("local", flow.id);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.match(done.state[0].output, /"ran":true/, "the pass let the tests run once");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(!readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests"), "no standing rule");
  const { projectTestsVerdict } = await import("../dist/coding/project-tests.js");
  const host = { store: app.store, owner: "local", approvals: app.runtime.approvals, sessionId: "somewhere-else" };
  assert.equal(projectTestsVerdict(host, workspace), "ask");
  assert.throws(() => app.runtime.grantApproval("wf", { tool: "code.tests", target: workspace, label: "x", source: "schedule" }, "always"));
});

test("review 4 a dry run (plan) never runs the tests and never asks", async (t) => {
  const { app } = await testsFixture(t, [call("code.check", {}), say("done")]);
  const run = await app.runtime.run({ prompt: "plan it", dryRun: true });
  assert.equal(asked(app, run).length, 0);
  assert.equal(ranTests(app, run), false);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "tool.simulated"));
});

test("review 1 with the switch off the guard is never consulted", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [edit("one", "two"),
    call("files.write", { path: "a.txt", content: "three\n" }), say("done")], "off");
  const guard = app.coding["deps"].files.readFirst;
  guard.require = async () => { throw new Error("looked at while off"); };
  const run = await app.runtime.run({ prompt: "change it" });
  assert.ok(toolMessages(app, run).every((answer) => answer.ok), JSON.stringify(toolMessages(app, run)));
  assert.equal(await fileText(workspace, "a.txt"), "three\n");
});

test("review 6 a missing or damaged switch file means off, and a late crash still never throws", async (t) => {
  const { DiagnosticLog, crashReporterPlan, crashCaptureMarked } = await import("../dist/diagnostic-log.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dataDir = await mkdtemp(join(tmpdir(), "branch-crash-bad-"));
  t.after(() => discardTemp(dataDir));
  assert.equal(crashCaptureMarked(dataDir), false);
  await mkdir(join(dataDir, "logs"), { recursive: true });
  for (const bad of ["{not json", JSON.stringify({ crashCapture: "yes" }), JSON.stringify("on"), ""]) {
    await writeFile(join(dataDir, "logs", "crash-capture.json"), bad);
    assert.equal(crashReporterPlan(dataDir), null, bad);
    const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => { throw new Error("database is not open"); } });
    assert.doesNotThrow(() => log.crash("engine", new Error("late")));
    assert.equal(log.crashes(5).length, 0, bad);
  }
});

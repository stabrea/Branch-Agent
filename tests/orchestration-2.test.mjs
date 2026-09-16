import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const kinds = (app, runId) => app.store.events(runId).map((e) => e.kind);
const data = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);

/** A provider whose answer is chosen from the system prompt and the last message of the request. */
function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0].content;
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const last = request.messages.at(-1);
    return reply({ system, user, last, request });
  } };
  return provider;
}
async function fixture(t, reply = () => say("done"), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-orch2-"));
  const provider = scripted(reply);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => {
    await app.processes.stopAll().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, provider, root };
}
async function served(t, reply, options = {}) {
  const made = await fixture(t, reply, options);
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (path, body, method) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { ...made, api, server };
}
/** An evaluated, promoted specialist the runtime will delegate to, with a working style. */
async function specialist(app, name, style, permissions = ["files.read"]) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", {
    name, style, instructions: `You are the ${name}.`, permissions,
    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
  }, context);
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}
/** A context bound to a real task, so tools that need a conversation have one. */
function taskContext(app, prompt = "a task", temporary = false) {
  const run = app.store.createRun(app.runtime.owner, prompt, undefined, temporary);
  return { run, context: app.runtime.context({ runId: run.id }) };
}

// ---------------------------------------------------------------- O1: styles

test("a react specialist thinks one line at a time: the line is on the task, not in the answer", async (t) => {
  const { app } = await fixture(t, ({ system }) => {
    if (/You are the thinker/.test(system)) return say("Thought: I will look at the note first.\nThe note says ready.");
    return say("parent done");
  });
  const id = await specialist(app, "thinker", "react");
  const { context } = taskContext(app);
  const { run } = await app.knowledge.delegate(context, id, "read the note");
  assert.equal(run.status, "completed");
  assert.equal(run.output, "The note says ready.", "the thinking line never reaches the answer");
  assert.deepEqual(data(app, run.id, "react.scratch").map((d) => d.text), ["I will look at the note first."]);
  assert.equal(data(app, run.id, "specialist.style")[0].style, "react");
  const kept = app.store.messages(run.sessionId).filter((m) => m.role === "assistant");
  assert.match(kept.at(-1).content, /Thought:/, "the transcript still holds the trail the model left");
});

test("a critic specialist may look but not change, whatever it was given permission for", async (t) => {
  const { app } = await fixture(t, ({ system, user }) => {
    if (/You are the reviewer/.test(system) && /review the note/.test(user))
      return call("files.write", { path: "note.txt", content: "changed" });
    return say("ready");
  });
  const id = await specialist(app, "reviewer", "critic", ["files.read", "files.write"]);
  const { context } = taskContext(app);
  const { run } = await app.knowledge.delegate(context, id, "review the note");
  const failures = data(app, run.id, "tool.failed");
  assert.match(failures[0].error, /Permission denied: files\.write/);
  assert.equal(await readFile(join(app.runtime.workspace, "note.txt"), "utf8").catch(() => null), null);
});

test("a plan-execute specialist plans its own sub-task and works through the steps", async (t) => {
  const { app } = await fixture(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Read it"},{"title":"Say what it said"}]}');
    if (/You are the worker/.test(system)) {
      if (/^Step 1 of 2/.test(user)) return say("I read it.");
      if (/^Step 2 of 2/.test(user)) return say("It said ready.");
      return say("Both steps are done: it said ready.");
    }
    return say("parent done");
  });
  const id = await specialist(app, "worker", "plan-execute");
  const { context } = taskContext(app);
  const { run } = await app.knowledge.delegate(context, id, "read the note and say what it said");
  assert.equal(run.output, "Both steps are done: it said ready.");
  assert.deepEqual(data(app, run.id, "plan.created")[0].steps, ["Read it", "Say what it said"]);
  assert.equal(data(app, run.id, "plan.step.finished").length, 2);
});

test("a researcher opens the looking-things-up toolboxes and a coder the code ones, before the first round", async (t) => {
  const { app } = await fixture(t, () => say("done"));
  for (const [name, style, expected] of [["finder", "researcher", "web"], ["builder", "coder", "git"]]) {
    const id = await specialist(app, name, style, ["files.read", "web.read", "git.read"]);
    const { context } = taskContext(app);
    const { run } = await app.knowledge.delegate(context, id, "have a look");
    const preselected = data(app, run.id, "catalog.preselected")[0];
    assert.ok(preselected.style.includes(expected), `${style} opens ${expected}: got ${JSON.stringify(preselected.style)}`);
  }
});

// ------------------------------------------------- O2: patches and change sets

const patchFor = (path, before, after) => [
  `--- a/${path}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,
  ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`), "",
].join("\n");

test("code.patch shows the whole change first, then writes it all at once and keeps every file's history", async (t) => {
  const { app } = await fixture(t);
  const workspace = app.runtime.workspace;
  await writeFile(join(workspace, "one.txt"), "first\n");
  await writeFile(join(workspace, "two.txt"), "second\n");
  const patch = patchFor("one.txt", ["first"], ["FIRST"]) + patchFor("two.txt", ["second"], ["SECOND"]);
  const { context, run } = taskContext(app);
  const preview = await app.registry.execute("code.patch", { patch, dryRun: true }, context);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.files.map((f) => f.path), ["one.txt", "two.txt"]);
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "a dry run writes nothing");
  const applied = await app.registry.execute("code.patch", { patch }, context);
  assert.equal(applied.applied, true);
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "FIRST\n");
  assert.equal(await readFile(join(workspace, "two.txt"), "utf8"), "SECOND\n");
  assert.deepEqual(data(app, run.id, "code.changed")[0].files, ["one.txt", "two.txt"]);
  const history = await app.registry.execute("files.history", { path: "one.txt" }, context);
  assert.ok(history.length >= 1, "the earlier text is kept so the change can be put back");
  const back = await app.registry.execute("files.restore", { versionId: history[0].id }, context);
  assert.equal(back.restored, true);
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "one file of the set can be put back on its own");
});

test("code.patch refuses a part that does not fit and a file that is not text, and changes nothing", async (t) => {
  const { app } = await fixture(t);
  const workspace = app.runtime.workspace;
  await writeFile(join(workspace, "one.txt"), "first\n");
  await writeFile(join(workspace, "two.txt"), "second\n");
  const { context } = taskContext(app);
  const wrong = patchFor("one.txt", ["first"], ["FIRST"]) + patchFor("two.txt", ["nothing like this"], ["x"]);
  await assert.rejects(() => app.registry.execute("code.patch", { patch: wrong }, context), /does not match the file/);
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "the first file was never written");
  await writeFile(join(workspace, "picture.dat"), Buffer.from([0x50, 0x00, 0x4e, 0x47]));
  await assert.rejects(
    () => app.registry.execute("code.patch", { patch: patchFor("picture.dat", ["P NG"], ["x"]) }, context),
    /not a text file|does not match/);
});

test("a change set names its files for one approval, is all-or-nothing, and reports the project's check", async (t) => {
  const { app } = await fixture(t);
  const workspace = app.runtime.workspace;
  await writeFile(join(workspace, "a.txt"), "keep alpha\n");
  await writeFile(join(workspace, "b.txt"), "keep beta\n");
  const edits = [{ path: "a.txt", find: "alpha", replace: "ALPHA" }, { path: "b.txt", find: "beta", replace: "BETA" }];
  const { context } = taskContext(app);
  const target = app.registry.targetOf("code.change_set", { reason: "tidy up", edits, dryRun: false }, context);
  assert.equal(target, "2 files: a.txt, b.txt", "the person is told which files before they say yes");
  // A check that always passes, run through the app's own Node so nothing else has to be installed.
  await writeFile(join(workspace, "ok.mjs"), "process.exit(0)\n");
  app.store.save("settings", app.runtime.owner, "code-check",
    { enabled: true, command: process.execPath, args: ["--check", join(workspace, "ok.mjs")], timeoutMs: 20000 });
  const result = await app.registry.execute("code.change_set", { reason: "tidy up", edits }, context);
  assert.equal(result.applied, true);
  assert.equal(result.check.ran, true);
  assert.equal(result.check.ok, true, `check said: ${JSON.stringify(result.check)}`);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "keep ALPHA\n");
  await assert.rejects(
    () => app.registry.execute("code.change_set", { reason: "again", edits: [{ path: "a.txt", find: "ALPHA", replace: "x" }, { path: "b.txt", find: "missing", replace: "y" }] }, context),
    /contains that text 0 time/);
  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "keep ALPHA\n", "nothing was written when one edit did not fit");
});

test("what the project's check said reaches the assistant's next round", async (t) => {
  let asked = 0;
  const { app } = await fixture(t, ({ last }) => {
    if (last.role === "tool") { asked++; return say(`the check said: ${JSON.parse(last.content).result.check.ok}`); }
    return call("code.patch", { patch: patchFor("one.txt", ["first"], ["FIRST"]) });
  });
  await writeFile(join(app.runtime.workspace, "one.txt"), "first\n");
  app.store.save("settings", app.runtime.owner, "code-check",
    { enabled: true, command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 20000 });
  const run = await app.runtime.run({ prompt: "change the file" });
  assert.equal(asked, 1);
  assert.equal(run.output, "the check said: false");
  assert.equal(data(app, run.id, "code.check")[0].ok, false);
});

// --------------------------------------------- O3: programs left running

async function allowNode(app, alias = "node") {
  app.store.save("settings", app.runtime.owner, "background-processes",
    { programs: { [alias]: { path: process.execPath, args: [] } }, maxRunning: 3, maxMinutes: 5,
      maxMemoryMb: 512, maxCpuSeconds: 60, bufferBytes: 4096 });
}
const ticker = ["-e", "setInterval(() => console.log('tick'), 40)"];

test("a program started in the background outlives its tool call, is listed, read and stopped", async (t) => {
  const { app } = await fixture(t);
  await allowNode(app);
  const { context, run } = taskContext(app);
  const started = await app.registry.execute("process.start", { program: "node", args: ticker, name: "the ticker" }, context);
  t.after(() => app.processes.stop(started.id).catch(() => undefined));
  assert.equal(started.status, "running");
  assert.ok(started.pid, "it really started");
  await delay(250);
  const listed = await app.registry.execute("process.list", {}, context);
  assert.equal(listed.processes.filter((p) => p.status === "running").length, 1, "it is still going after the tool call ended");
  const read = await app.registry.execute("process.read", { id: started.id }, context);
  assert.match(read.output, /tick/);
  const stopped = await app.registry.execute("process.stop", { id: started.id }, context);
  assert.equal(stopped.status, "stopped");
  await delay(100);
  assert.equal(app.processes.list({ active: true }).length, 0);
  assert.deepEqual(data(app, run.id, "process.started").map((d) => d.name), ["the ticker"]);
});

test("a program is stopped when its conversation is thrown away, and when the app closes", async (t) => {
  const { app } = await fixture(t);
  await allowNode(app);
  const { context: temporaryContext, run: temporaryRun } = taskContext(app, "temporary task", true);
  const inSession = await app.registry.execute("process.start", { program: "node", args: ticker, name: "first" }, temporaryContext);
  app.store.finish(temporaryRun.id, "completed", "done");
  app.store.discardSession(app.runtime.owner, temporaryRun.sessionId);
  const stateOf = (id) => app.processes.list().find((p) => p.id === id).status;
  for (let at = 0; at < 200 && stateOf(inSession.id) === "running"; at++) await delay(25);
  assert.equal(stateOf(inSession.id), "stopped", "it went with the conversation");
  const { context } = taskContext(app);
  const second = await app.registry.execute("process.start", { program: "node", args: ticker, name: "second" }, context);
  await app.close();
  assert.deepEqual(app.processes.list(), [], "closing the app leaves nothing behind at all");
  const alive = () => { try { process.kill(second.pid, 0); return true; } catch { return false; } };
  for (let at = 0; at < 200 && alive(); at++) await delay(25);
  assert.equal(alive(), false, "and the program itself really is gone");
});

test("only programs the owner allowed may be started, and only so many at once", async (t) => {
  const { app } = await fixture(t);
  const { context } = taskContext(app);
  await assert.rejects(() => app.registry.execute("process.start", { program: "node", args: [] }, context), /not one of the programs/);
  app.store.save("settings", app.runtime.owner, "background-processes",
    { programs: { node: { path: process.execPath, args: [] } }, maxRunning: 1, maxMinutes: 5, bufferBytes: 2048 });
  const first = await app.registry.execute("process.start", { program: "node", args: ticker, name: "one" }, context);
  t.after(() => app.processes.stop(first.id).catch(() => undefined));
  await assert.rejects(() => app.registry.execute("process.start", { program: "node", args: ticker }, context), /already running/);
});

// --------------------------------- O4: deferred calls and finding a tool

test("a tool may hand its work over and finish later through the follow-up queue", async (t) => {
  let round = 0;
  const { app } = await fixture(t, ({ user }) => {
    if (/handed over earlier has finished/.test(user)) return say(`they did it: ${user.split("What came of it: ")[1]}`);
    round++;
    if (round === 1) return call("user.task", { description: "sign the form" });
    return say("I have asked them and carried on.");
  });
  const run = await app.runtime.run({ prompt: "get the form signed" });
  assert.equal(run.output, "I have asked them and carried on.", "the task did not wait");
  const handed = data(app, run.id, "tool.deferred");
  assert.equal(handed.length, 1);
  assert.equal(handed[0].description, "sign the form");
  const waiting = app.runtime.deferrals.list({ waiting: true });
  assert.equal(waiting.length, 1);
  const settled = app.runtime.settleDeferred(waiting[0].id, "signed and posted");
  assert.equal(settled.sessionId, run.sessionId);
  for (let at = 0; at < 100 && app.store.runs(app.runtime.owner).length < 2; at++) await delay(20);
  const follow = app.store.runs(app.runtime.owner).find((r) => r.id !== run.id);
  for (let at = 0; at < 100 && follow.status === "running"; at++) await delay(20);
  assert.match(app.store.run(follow.id).output, /signed and posted/);
  assert.equal(app.runtime.deferrals.list({ waiting: true }).length, 0);
});

test("tools.search finds a tool inside a toolbox that is still closed", async (t) => {
  let found;
  const { app } = await fixture(t, ({ last }) => {
    if (last.role === "tool") { found = JSON.parse(last.content); return say("found it"); }
    return call("tools.search", { query: "save a version of the code" });
  });
  const run = await app.runtime.run({ prompt: "tell me about the weather" });
  assert.equal(run.output, "found it");
  const names = found.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("git.commit"), `expected git.commit among ${JSON.stringify(names)}`);
  assert.equal(found.result.tools.find((tool) => tool.name === "git.commit").group, "git");
  assert.equal(data(app, run.id, "catalog.searched")[0].query, "save a version of the code");
});

// ------------------------------------------------------------ O6: code.run

test("code.run runs a small script under its limits, and refuses until the owner allows it", async (t) => {
  const { app } = await fixture(t);
  const { context } = taskContext(app);
  await assert.rejects(() => app.registry.execute("code.run", { language: "javascript", source: "console.log(1)" }, context),
    /switched off/);
  app.store.save("settings", app.runtime.owner, "code-run",
    { enabled: true, python: "", network: false, timeoutMs: 8000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 2048 });
  const result = await app.registry.execute("code.run", { language: "javascript", source: "console.log(6 * 7)" }, context);
  assert.equal(result.status, "completed");
  assert.match(result.output, /42/);
  assert.equal(result.network, false);
  await assert.rejects(() => app.registry.execute("code.run", { language: "python", source: "print(1)" }, context), /No Python/);
  const slow = await app.registry.execute("code.run",
    { language: "javascript", source: "const until = Date.now() + 30000; while (Date.now() < until) {}" }, context);
  assert.notEqual(slow.status, "completed", "a script that will not stop is stopped for it");
});

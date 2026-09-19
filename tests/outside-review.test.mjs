/**
 * mac7/outside-review: the adversarial review of mac7/outside-resume, and the hole it left.
 *
 * - A message one Trunk queues for another (and the reply, and the second try) starts as the task that
 *   queued it: a task from outside stays held as that, and a Trunk kept to fewer tools cannot reach
 *   more through another Trunk.
 * - An outside task cut off by its allowance holds the owner's next message like one interrupted.
 * - The pieces of outside-resume no test there tells apart: the choke point in checkPolicy, the
 *   record read in Runtime.policy, the workflows.resume tool, and a flow copied from an earlier step.
 * - The window says why a conversation carried on from outside asks first (the mode chip's view).
 * A stand-in model and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { fixture as trunksFixture, on, call } from "./trunks-helpers.mjs";
import { TrunkMessages } from "../dist/trunks/messages.js";
import { conversationModeApi } from "../dist/conversation-mode-api.js";

const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;
const writeCall = (path) => call("files.write", { path, content: "x" }, `w-${path}`);
const exists = (app, path) => existsSync(join(app.runtime.workspace, path));

/** Waits for a task in this conversation whose message starts with `prefix` to have settled. */
async function settledIn(app, sessionId, prefix, seen = new Set()) {
  for (let i = 0; i < 400; i++) {
    const run = app.store.runs(app.runtime.owner).find((r) => r.sessionId === sessionId && r.prompt.startsWith(prefix) && !seen.has(r.id));
    if (run && run.status !== "running") return run;
    await delay(10);
  }
  throw new Error(`no settled task in that conversation began "${prefix}"`);
}
/** Sends a trunk.message as the given task of `from`, the way the tool is called in that Trunk's chat. */
function send(app, from, runId, to, message) {
  return app.registry.execute("trunk.message", { to, message }, { ...app.runtime.context({ runId }), agent: `trunk:${from.id}` });
}
/** Ann and Ben; Ben writes a file when a message from Ann arrives, Ann writes one when Ben's reply does. */
async function twoTrunks(t) {
  const rules = [({ system, last }) => {
    const text = String(last?.content ?? "");
    if (last?.role === "tool") return "Noon.";
    if (/\nYou are Ben \(@ben\)/.test(system) && text.startsWith("Message from Ann")) return writeCall("ben.txt");
    if (/\nYou are Ann \(@ann\)/.test(system) && text.startsWith("Reply from Ben")) return writeCall("ann.txt");
    return null;
  }];
  const { app } = await trunksFixture(t, rules);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  return { app, ann, ben };
}

test("a Trunk's message sent by a task from outside is read as that task, held to Ask before changes", async (t) => {
  const { app, ann, ben } = await twoTrunks(t);
  // A remote Trunk's message lands in Ann's conversation as source "a2a" (src/reach/trunk-roster.ts).
  const outside = await app.runtime.run({ prompt: "hello", sessionId: ann.chatSessionId, source: "a2a" });
  await send(app, ann, outside.id, "@ben", "Please write it down.");
  const read = await settledIn(app, ben.chatSessionId, "Message from Ann");
  assert.equal(read.status, "needs_input", "Ben's write waits for the owner, even under No approvals");
  assert.equal(started(app, read.id).source, "a2a");
  assert.equal(started(app, read.id).originFrom, outside.id);
  assert.equal(exists(app, "ben.txt"), false);
  assert.throws(() => app.runtime.approve(ben.chatSessionId, "allow", "always"), /did not start yourself/);
});

test("a Trunk's message sent by the owner's own task is the owner's own, as before", async (t) => {
  const { app, ann, ben } = await twoTrunks(t);
  const mine = await app.runtime.run({ prompt: "hello", sessionId: ann.chatSessionId });
  await send(app, ann, mine.id, "@ben", "Please write it down.");
  const read = await settledIn(app, ben.chatSessionId, "Message from Ann");
  assert.equal(read.status, "completed");
  assert.equal(started(app, read.id).source, "owner");
  assert.equal(started(app, read.id).originFrom, undefined);
  assert.ok(exists(app, "ben.txt"));
});

test("a Trunk kept to fewer tools cannot reach more through another Trunk, either way round", async (t) => {
  const { app, ann, ben } = await twoTrunks(t);
  // Ann may only look and send messages; Ben has the owner's ordinary set.
  app.trunks.edit(ann.id, { permissions: ["files.read", "trunks.message"] });
  const narrow = await app.runtime.run({ prompt: "hello", sessionId: ann.chatSessionId });
  assert.deepEqual(started(app, narrow.id).permissions, ["files.read", "trunks.message"]);
  await send(app, ann, narrow.id, "@ben", "Please write it down.");
  const read = await settledIn(app, ben.chatSessionId, "Message from Ann");
  assert.ok(!started(app, read.id).permissions.includes("files.write"), "Ben reads Ann's message with no more than Ann's tools");
  assert.equal(exists(app, "ben.txt"), false);
  const first = await settledIn(app, ann.chatSessionId, "Reply from Ben"); // Ben's answer comes back to Ann
  // The other way: Ben may only look; his reply reaches Ann with no more than his tools.
  app.trunks.edit(ann.id, { permissions: [] });
  app.trunks.edit(ben.id, { permissions: ["files.read"] });
  const full = await app.runtime.run({ prompt: "hello again", sessionId: ann.chatSessionId });
  assert.ok(started(app, full.id).permissions.includes("files.write"), "Ann has her ordinary tools again");
  await send(app, ann, full.id, "@ben", "What time?");
  const answered = await settledIn(app, ben.chatSessionId, "Message from Ann (@ann):\nWhat time?");
  assert.deepEqual(started(app, answered.id).permissions, ["files.read"]);
  const reply = await settledIn(app, ann.chatSessionId, "Reply from Ben", new Set([first.id]));
  assert.ok(!started(app, reply.id).permissions.includes("files.write"), "Ann reads Ben's reply with no more than Ben's tools");
  assert.equal(started(app, reply.id).originFrom, undefined, "the owner's own work stays the owner's");
  assert.equal(exists(app, "ann.txt"), false);
});

test("the second try and the failure notice each carry the task behind them", async (t) => {
  const { app } = await trunksFixture(t);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.messages.close(); // only the copy under test follows the tasks
  const sent = [];
  const messages = new TrunkMessages(app.store, app.runtime.owner, app.trunks.records,
    { followUp: (sessionId, prompt, _person, carry) => { sent.push({ sessionId, prompt, carry }); return { id: "q", position: 1, queued: 1 }; } });
  t.after(() => messages.close());
  const own = await app.runtime.run({ prompt: "hi", sessionId: ann.chatSessionId, source: "schedule" });
  messages.send({ ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` }, { to: "ben", message: "ping" });
  const recorded = started(app, own.id).permissions;
  assert.deepEqual(sent[0].carry, { originFrom: own.id, permissions: recorded });
  const fail = (output) => {
    const run = app.store.createRun(app.runtime.owner, sent.at(-1).prompt, ben.chatSessionId);
    app.store.event(run.id, "run.started", {});
    app.store.event(run.id, "run.finished", { status: "failed", output });
    return run;
  };
  fail("The provider said 429: rate limit reached");
  assert.deepEqual(sent[1].carry, { originFrom: own.id, permissions: recorded }, "the second try is still Ann's task's");
  const last = fail("The provider said 429: rate limit reached");
  assert.equal(sent[2].sessionId, ann.chatSessionId);
  // The notice is written by the task that failed; one with no tools on record passes on none.
  assert.deepEqual(sent[2].carry, { originFrom: last.id, permissions: [] });
});

test("an outside task in the owner's conversation that ran out of its allowance holds the owner's next message", async (t) => {
  const { app } = await trunksFixture(t, [({ last }) => (String(last?.content ?? "") === "write it" ? writeCall("cut.txt") : null)]);
  const mine = await app.runtime.run({ prompt: "hello" });
  const joined = await app.runtime.run({ prompt: "hello", sessionId: mine.sessionId, source: "a2a" });
  app.store.sqlite.prepare("UPDATE tasks SET status='budget_exceeded' WHERE id=?").run(joined.id);
  const next = await app.runtime.run({ prompt: "write it", sessionId: mine.sessionId });
  assert.equal(next.status, "needs_input", "carrying on what the other program was cut off in");
  assert.equal(started(app, next.id).source, "a2a");
  assert.equal(exists(app, "cut.txt"), false);
});

test("checkPolicy holds a hand-built context to its task's record (the choke point on its own)", async (t) => {
  const { app } = await trunksFixture(t);
  // A reading tool of the owner's mail: under No approvals the owner reads it freely; work from
  // outside is asked about first (src/personal/guard.ts), which only the source says.
  if (!app.registry.names().includes("gmail.search"))
    app.registry.register({ name: "gmail.search", permission: "files.read", description: "stand-in",
      parameters: z.object({}).passthrough(), execute: async () => ({ ok: true }) });
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  const mine = await app.runtime.run({ prompt: "hello" });
  assert.equal(app.runtime.checkPolicy("gmail.search", {}, app.runtime.context({ runId: trigger.id })).decision, "ask");
  assert.equal(app.runtime.checkPolicy("gmail.search", {}, app.runtime.context({ runId: mine.id })).decision, "allow");
});

test("Runtime.policy holds a task from outside by its record, whatever source it is asked with", async (t) => {
  const { app } = await trunksFixture(t);
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  const mine = await app.runtime.run({ prompt: "hello" });
  assert.deepEqual(app.runtime.policy("owner", trigger.id).rules, app.runtime.policy("trigger").rules);
  assert.notDeepEqual(app.runtime.policy("owner", trigger.id).rules, app.runtime.policy("owner").rules);
  assert.deepEqual(app.runtime.policy("owner", mine.id).rules, app.runtime.policy("owner").rules);
});

test("the workflows.resume tool, called by a task from outside, carries the workflow on as that task", async (t) => {
  const { app } = await trunksFixture(t);
  const owner = app.runtime.owner;
  const steps = [{ name: "Write", kind: "tool", tool: "files.write", args: { path: "resumed.txt", content: "x" } }];
  const flow = app.workflows.create(owner, { name: "Just write", steps });
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  const view = await app.registry.execute("workflows.resume", { id: flow.id }, app.runtime.context({ runId: trigger.id }));
  assert.equal(view.status, "waiting_approval");
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = app.workflows.create(owner, { name: "Mine", steps: [{ ...steps[0], args: { path: "mine.txt", content: "x" } }] });
  assert.equal((await app.registry.execute("workflows.resume", { id: own.id }, app.runtime.context({ runId: mine.id }))).status, "completed");
});

test("a flow copied from an earlier step of a run a schedule set going is held as that run", async (t) => {
  const { app } = await trunksFixture(t);
  app.flowsBoards.setMode("time-travel", { mode: "on" });
  app.registry.register({ name: "tests.look", permission: "files.read", description: "stand-in look",
    parameters: z.object({}).passthrough(), execute: async () => ({ ok: true }) });
  const definition = { name: "Look then write", input: {}, state: { seen: "text", out: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "Look", kind: "tool", tool: "tests.look", args: {}, input: {}, output: { seen: "text" } },
      { id: "b", name: "Write", kind: "tool", tool: "files.write", args: { path: "copy.txt", content: "x" }, input: {}, output: { out: "text" } },
    ],
    edges: [{ from: "a", to: "b" }] };
  const graph = app.flows.saveGraph(definition);
  const { runId, compiled } = app.flows.graphs.begin({ ...definition, id: graph.id }, {}, { source: "schedule" });
  assert.equal((await app.flows.graphs.work(runId, compiled, { source: "schedule" })).status, "waiting_approval");
  const copy = app.flowsBoards.timeTravel.fork(runId, { seq: 1 });
  assert.equal((await app.flowsBoards.timeTravel.settled(copy.runId)).status, "waiting_approval", "the copy's write waits too");
  assert.equal(exists(app, "copy.txt"), false);
});

test("the mode chip's view says when a conversation carries on work from outside", async (t) => {
  const { app } = await trunksFixture(t);
  const view = (sessionId) => conversationModeApi(app, "GET", new URL(`http://local/api/conversation-mode?sessionId=${sessionId}`), async () => ({}));
  const chat = await app.runtime.run({ prompt: "hello", source: "channel" });
  const mine = await app.runtime.run({ prompt: "hello" });
  assert.equal((await view(chat.sessionId)).outside, "channel");
  // The owner's next message there is carried on as the chat's, and the view still says so.
  await app.runtime.run({ prompt: "and now?", sessionId: chat.sessionId });
  assert.equal((await view(chat.sessionId)).outside, "channel");
  assert.equal((await view(mine.sessionId)).outside, null);
  for (const lang of ["en", "fr"]) {
    const words = JSON.parse(readFileSync(new URL(`../public/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const key of ["mode.outsideNote", "mode.outside.chat", "mode.outside.trigger", "mode.outside.schedule", "mode.outside.program"])
      assert.ok(words[key], `${lang} has ${key}`);
    assert.match(words["mode.outsideNote"], /\{from\}/);
  }
});

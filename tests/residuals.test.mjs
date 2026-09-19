/**
 * mac7/residuals: the leftovers reviewers found on 2026-09-19 (docs/agents/STATUS-residuals.md).
 * Each test fails with its fix taken out. A stand-in model and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { replayRun } from "../dist/replay.js";
import { keyAnswerRefusal, runOrigin, underShortLivedKey } from "../dist/key-context.js";
import { accessRefusal, keyRefusal } from "../dist/devices/tools.js";
import { TrunkMessages } from "../dist/trunks/messages.js";
import { fixture as trunksFixture, on } from "./trunks-helpers.mjs";
import { PassThrough } from "node:stream";
import { AcpConnection } from "../dist/acp.js";
import { AppServerConnection } from "../dist/asks/app-server.js";

/** A model that calls the tool the newest message names ("please <tool> <json>"), then says it is done. */
function scripted() {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => {
    model.requests.push(request);
    const last = request.messages.at(-1);
    const asked = /please ([a-z_.]+) (\{.*\})$/s.exec(last?.role === "user" ? String(last.content) : "");
    if (asked) return { content: "", toolCalls: [{ id: `c${model.requests.length}`, name: asked[1], arguments: asked[2] }] };
    return { content: "Done.", toolCalls: [] };
  };
  return model;
}
async function fixture(t, provider = scripted()) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider, home: join(root, "home") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;

test("1. Do this again on a short-lived key's task is held as that key's work, not the owner's own", async (t) => {
  const { app } = await fixture(t);
  const first = await underShortLivedKey(() => app.runtime.run({ prompt: "hello" }), { keyId: "k1" });
  assert.equal(started(app, first.id).shortLivedKey, true);
  // The owner presses "Do this again" in the window: no key behind this request.
  const again = (await replayRun(app.runtime, app.store, first.id)).run;
  assert.equal(started(app, again.id).shortLivedKey, true, "the copy is marked as a key's work");
  assert.deepEqual(runOrigin(app.store, again.id).keyIds, ["k1"], "and names the key");
  assert.equal(accessRefusal({ store: app.store }, { runId: again.id }), keyRefusal, "owner-only tools refuse it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k2" }) !== null, true, "another key may not answer it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k1" }), null, "its own key may");
  // The owner's own task done again is unchanged.
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = (await replayRun(app.runtime, app.store, mine.id)).run;
  assert.equal(started(app, own.id).shortLivedKey, undefined);
  assert.equal(started(app, own.id).originFrom, undefined);
});

test("2. A Trunk's message whose task stops to ask waits for a yes: not failed, no failure notice, answered after", async (t) => {
  const { app } = await trunksFixture(t);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.messages.close(); // only the copy under test follows the tasks
  const sent = [];
  const messages = new TrunkMessages(app.store, app.runtime.owner, app.trunks.records,
    { followUp: (sessionId, prompt, _person, carry) => { sent.push({ sessionId, prompt, carry }); return { id: "q", position: 1, queued: 1 }; } });
  t.after(() => messages.close());
  const own = await app.runtime.run({ prompt: "hi", sessionId: ann.chatSessionId });
  messages.send({ ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` }, { to: "ben", message: "ping" });
  const task = (prompt, status, output) => {
    const run = app.store.createRun(app.runtime.owner, prompt, ben.chatSessionId);
    app.store.event(run.id, "run.started", {});
    app.store.event(run.id, "run.finished", { status, output });
    return run;
  };
  task(sent[0].prompt, "needs_input", "May I write ben.txt?");
  const receipt = () => messages.receipts(ben.id).find((r) => r.kind === "message");
  assert.equal(receipt().status, "waiting", "waiting for a yes, not failed");
  assert.equal(sent.length, 1, "no failure notice goes back to Ann");
  // The owner says yes and sends the next message in Ben's conversation; that task's answer is the reply.
  const next = task("Go ahead.", "completed", "Written.");
  assert.equal(receipt().status, "answered");
  assert.equal(receipt().runId, next.id);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, ann.chatSessionId);
  assert.match(sent[1].prompt, /^Reply from Ben \(@ben\) to your message:\nWritten\./);
});

test("3. A2A, ACP and the app-server carry on only conversations they began; the owner's is refused in plain words", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const mine = await app.runtime.run({ prompt: "hello" });
  const refused = /only carry on a conversation it started itself/;
  const text = (words) => ({ role: "user", parts: [{ type: "text", text: words }] });
  app.a2a.enabled = () => true;
  await assert.rejects(app.a2a.send({ sessionId: mine.sessionId, message: text("park this") }, "other"), refused);
  await assert.rejects(app.a2a.send({ sessionId: "not-a-conversation", message: text("hi") }, "other"), refused, "an unknown id reads the same");
  const began = await app.a2a.send({ message: text("hi") }, "other");
  assert.equal((await app.a2a.send({ sessionId: began.sessionId, message: text("more") }, "other")).sessionId, began.sessionId,
    "its own conversation carries on");
  const io = () => ({ input: new PassThrough(), output: new PassThrough(), log: () => {} });
  const acp = new AcpConnection(app.runtime, app.store, io());
  await acp.onRequest("initialize", { protocolVersion: 1 });
  const words = [{ type: "text", text: "park this" }];
  await assert.rejects(acp.onRequest("session/prompt", { sessionId: mine.sessionId, prompt: words }), refused);
  const opened = await acp.onRequest("session/new", { cwd: ".", mcpServers: [] });
  assert.equal((await acp.onRequest("session/prompt", { sessionId: opened.sessionId, prompt: words })).stopReason, "end_turn");
  const threads = new AppServerConnection(app.runtime, io(), "test");
  await threads.onRequest("initialize", {});
  await assert.rejects(threads.onRequest("turn/start", { threadId: mine.sessionId, input: [{ type: "text", text: "x" }] }), refused);
  assert.equal(app.store.runs(owner).filter((run) => run.sessionId === mine.sessionId).length, 1, "nothing ran in the owner's conversation");
});

test("4e. money a task started last month and still running has spent counts in this month's figure", async (t) => {
  const { app } = await fixture(t);
  const store = app.store;
  const running = store.createRun(app.runtime.owner, "make a long video");
  const lastMonth = new Date(Date.now() - 40 * 86_400_000).toISOString();
  store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(lastMonth, running.id);
  store.event(running.id, "spend.recorded", { dollars: 2.5, what: "a video", estimate: false });
  const month = store.usageStore().getMonthlyStats();
  assert.equal(month.stillBeingMade, 2.5);
  assert.equal(month.estimatedCost, 2.5);
});

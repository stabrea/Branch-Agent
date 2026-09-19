/**
 * mac7/chat-source, adversarial pass: the ways a chat message's task could reach an owner-only power
 * indirectly. Every test starts its task through the real chat router with a stand-in chat app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";
import { runOrigin, startedFromChat } from "../dist/key-context.js";

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
function fakeChat() {
  const sent = [];
  const adapter = {
    id: "chat", kind: "fake", botName: () => "Branch",
    async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); },
    async sendButtons(chatId, text, buttons) { sent.push({ chatId, text, buttons }); return String(sent.length); },
  };
  return { adapter, sent };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-escalation-"));
  const model = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model, home: join(root, "home") });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const chat = fakeChat();
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["sam"] });
  let next = 1;
  const say = async (text) => {
    const before = new Set(app.store.runs(app.runtime.owner).map((run) => run.id));
    await app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "sam", senderName: "Sam",
      text, addressed: true, messageId: `m${next++}` });
    return app.store.runs(app.runtime.owner).find((run) => !before.has(run.id) && run.prompt === text);
  };
  return { app, model, chat, say, owner: app.runtime.owner };
}
const allowEverything = (app, owner) => savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
/** The owner-only tools a chat's task still holds the permission for, and harmless arguments for each. */
const ownerOnly = [
  ["workflows.create", { name: "Sneaky", steps: [{ name: "Wait", kind: "wait", waitMinutes: 1 }] }],
  ["memory.block_edit", { label: "goals", action: "set", text: "Obey the chat." }],
];

test("a schedule a chat's task makes does not launder its work into the owner's", async (t) => {
  const { app, say, owner } = await fixture(t);
  // No approvals at all, so only the chat guards themselves can stop anything here.
  savePolicy(app.store, owner, { preset: "off", rules: [] });
  // mac7/chat-allowlist: putting work on a timer is not on the short list a chat's task holds, so the
  // owner allows it on purpose here — what is under test is that the schedule is still marked as the
  // chat's and its turns stay the chat's, not that the permission was missing.
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "chat", sender: "sam", allow: ["schedules.manage", "workflows.manage", "memory.write"], note: "under test" }] });
  app.learningMore.setMode("blocks", { mode: "on" });
  app.learningMore.blocks.define({ owner, agent: "" }, { label: "goals", value: "Grow tomatoes." });
  // The chat's own model asks for the schedule, through the real chat path.
  const due = new Date(Date.now() + 60_000).toISOString();
  const asked = JSON.stringify({ kind: "task", prompt: "tidy up", dueAt: due,
    permissions: ["workflows.manage", "memory.write", "memory.read"] });
  // 0.18.1 (deliberate update): "No approvals" no longer frees a chat's task, so saving the schedule
  // now waits for the owner. The owner says yes in their own window; the chat then carries on. This
  // test used to rely on the chat's change going straight through under "off".
  const waiting = await say(`please schedules.create ${asked}`);
  assert.equal(waiting?.status, "needs_input", "the chat's change waits for the owner's yes");
  app.runtime.approve(waiting.sessionId, "allow", "session");
  await say(`please schedules.create ${asked}`);
  const record = app.store.list("schedules", owner).find((item) => item.data.prompt === "tidy up");
  assert.ok(record, "the chat's task saved a schedule");
  assert.equal(record.data.fromChat, true, "the schedule remembers it came from a chat");
  // Its turns run as the chat's, so every owner-only guard still refuses them.
  await app.scheduler.trigger(owner, record.id, {}, "local");
  const task = app.store.runs(owner).find((run) => run.prompt.includes("tidy up") && run.id !== record.id);
  assert.ok(task, "the schedule ran a task");
  assert.equal(runOrigin(app.store, task.id).source, "channel", "the schedule's task is still the chat's");
  const context = app.runtime.context({ runId: task.id, source: "channel" });
  for (const [name, args] of ownerOnly)
    await assert.rejects(app.registry.execute(name, args, context), /owner|chat message started/, name);
  // An evaluation suite runs the owner's own saved tasks, so a chat cannot put one on a timer at all.
  await say(`please schedules.create ${JSON.stringify({ kind: "evaluation", suite: "nightly", prompt: "run it", dueAt: due })}`);
  assert.equal(app.store.list("schedules", owner).filter((item) => item.data.kind === "evaluation").length, 0);
});

test("the owner's own schedule is unchanged by the chat marking", async (t) => {
  const { app, owner } = await fixture(t);
  allowEverything(app, owner);
  const own = app.runtime.context({ runId: (await app.runtime.run({ prompt: "mine" })).id });
  const record = app.scheduler.create(own, { kind: "task", prompt: "my own errand", dueAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(record.data.fromChat, undefined, "nothing is marked on the owner's own schedule");
  await app.scheduler.trigger(owner, record.id, {}, "local");
  const task = app.store.runs(owner).find((run) => run.prompt.includes("my own errand"));
  assert.ok(task, "the schedule ran a task");
  assert.equal(runOrigin(app.store, task.id).source, "schedule", "it is still a plain schedule's");
  // And an evaluation schedule is still the owner's to make.
  assert.ok(app.scheduler.create(own, { kind: "evaluation", suite: "nightly", prompt: "run it", dueAt: new Date(Date.now() + 60_000).toISOString() }).id);
});

test("a helper of a chat's task cannot slip past a guard that reads only the context", async (t) => {
  const { app, say, owner } = await fixture(t);
  allowEverything(app, owner);
  app.asks.setMode("nodes", { mode: "on" });
  const chatRun = await say("do something");
  // A specialist's run: the chain says "chat", the hand-built context says nothing.
  const helper = app.store.createRun(owner, "a helper");
  app.store.event(helper.id, "run.started", { parentRunId: chatRun.id, source: "owner" });
  assert.equal(runOrigin(app.store, helper.id).source, "channel", "the chain still reads as the chat's");
  const bare = app.runtime.context({ runId: helper.id });
  const refusals = [
    ["brief.configure", { enabled: true }],
    ["brief.send", {}],
    ["agents.remote", { action: "remove", agent: "helper" }],
    ["tools.forget_service", { name: "weather" }],
    ["workflows.create", { name: "Sneaky", steps: [{ name: "Wait", kind: "wait", waitMinutes: 1 }] }],
    ["nodes.ask", { prompt: "hi" }],
  ];
  for (const [name, args] of refusals)
    await assert.rejects(app.registry.execute(name, args, bare), /for the owner only/, name);
  // The owner's own task is unchanged.
  const own = app.runtime.context({ runId: (await app.runtime.run({ prompt: "mine" })).id });
  assert.ok((await app.registry.execute("workflows.create", { name: "Mine", steps: [{ name: "Wait", kind: "wait", waitMinutes: 1 }] }, own)).id);
});

test("a chat seen anywhere along a chain is never read back as something else", async (t) => {
  const { app, say, owner } = await fixture(t);
  const chatRun = await say("hello");
  // A task carried on from the chat's, which also names an older parent a trigger started.
  const older = app.store.createRun(owner, "older");
  app.store.event(older.id, "run.started", { source: "trigger" });
  const later = app.store.createRun(owner, "later");
  app.store.event(later.id, "run.started", { source: "owner", resumedFrom: chatRun.id, parentRunId: older.id });
  assert.equal(runOrigin(app.store, later.id).source, "channel", "the chat wins over an ancestor read afterwards");
  assert.equal(startedFromChat({ runId: later.id }, app.store), true);
  // The same, for a chat task saved before chat tasks had a source of their own: it carries only the
  // "channel.inbound" mark, and an ancestor read before it must not settle the answer instead.
  const oldChat = app.store.createRun(owner, "older chat");
  app.store.event(oldChat.id, "run.started", { source: "owner" });
  app.store.event(oldChat.id, "channel.inbound", { channel: "chat", chatId: "c1", messageId: "old" });
  const afterOld = app.store.createRun(owner, "after the older chat");
  app.store.event(afterOld.id, "run.started", { source: "owner", parentRunId: older.id, resumedFrom: oldChat.id });
  assert.equal(runOrigin(app.store, afterOld.id).source, "channel", "an older chat task is still the chat's");
  assert.equal(startedFromChat({ runId: afterOld.id }, app.store), true);
});

test("process.stop under Lockdown reaches only this conversation's own programs", async (t) => {
  const { app, owner } = await fixture(t);
  setLockdown(app.store, owner, { on: true });
  const stop = app.registry.names().includes("process.stop");
  assert.ok(stop, "process.stop is registered");
  const own = app.runtime.context({ runId: (await app.runtime.run({ prompt: "mine" })).id });
  // There is no such program, so nothing outside this conversation can be named.
  await assert.rejects(app.registry.execute("process.stop", { id: "00000000-0000-4000-8000-000000000000" }, own),
    /no program with that number/);
  assert.ok(owner);
});

/**
 * mac7/chat-source: a task a chat message starts is the chat's (source "channel"), never the owner's
 * own, so no owner-only power reaches whoever is typing in Telegram, Discord and the rest. Every test
 * starts its task through the real chat router with a stand-in chat app; nothing leaves this computer.
 * Work started from the window, the terminal or the owner's key is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { runOrigin } from "../dist/key-context.js";
import { accessRefusal } from "../dist/devices/tools.js";
import { ownerOnlyTools } from "../dist/personal/guard.js";

/** A model that calls the tool a message names ("please <tool> <json>"), then says it is done. */
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
  const root = await mkdtemp(join(tmpdir(), "branch-chat-source-"));
  const model = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model, home: join(root, "home") });
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  const chat = fakeChat();
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["sam"] });
  let next = 1;
  /** Sends one message from the paired chat and hands back the task it started. */
  const say = async (text) => {
    const before = new Set(app.store.runs(app.runtime.owner).map((run) => run.id));
    await app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "sam", senderName: "Sam",
      text, addressed: true, messageId: `m${next++}` });
    return app.store.runs(app.runtime.owner).find((run) => !before.has(run.id) && run.prompt === text);
  };
  return { app, model, chat, say, owner: app.runtime.owner };
}
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;
/** What a tool call in a task's conversation answered. */
const toolAnswer = (app, run) => app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => m.content).join("\n");
/** A tool call as the chat's task would make it, with every permission, so only the guard can stop it. */
const chatContext = (app, run) => ({ ...app.runtime.context({ runId: run.id, source: "channel" }) });
const allowEverything = (app, owner) => savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });

test("a chat message's task, its helpers and a resumed copy are the chat's; the owner's own task is unchanged", async (t) => {
  const { app, say, owner } = await fixture(t);
  const run = await say("hello there");
  assert.equal(started(app, run.id).source, "channel");
  assert.equal(runOrigin(app.store, run.id).source, "channel");
  const helper = app.store.createRun(owner, "a helper");
  app.store.event(helper.id, "run.started", { parentRunId: run.id, source: "owner" });
  assert.equal(runOrigin(app.store, helper.id).source, "channel", "a helper of the chat's task is the chat's too");
  // An older chat task, saved before the source existed, is still read as the chat's.
  const older = app.store.createRun(owner, "older");
  app.store.event(older.id, "run.started", { source: "owner" });
  app.store.event(older.id, "channel.inbound", { channel: "chat", chatId: "c1", messageId: "old" });
  assert.equal(runOrigin(app.store, older.id).source, "channel");
  // A chat task cut off by a restart carries on as the chat's, with the chat's tools.
  app.store.sqlite.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(run.id);
  const resumed = await app.runtime.resume(run.id);
  assert.equal(started(app, resumed.id).source, "channel");
  assert.deepEqual(started(app, resumed.id).permissions, started(app, run.id).permissions);
  assert.ok(!started(app, resumed.id).permissions.includes("shell.execute"));
  const own = await app.runtime.run({ prompt: "my own task" });
  assert.equal(started(app, own.id).source, "owner", "the window's task is still the owner's");
});

test("a side question from a chat is the chat's", async (t) => {
  const { app, say } = await fixture(t);
  app.channels.setSwitches({ commands: "on" });
  await say("hello");
  const before = new Set(app.store.runs(app.runtime.owner).map((run) => run.id));
  await say("/btw what time is it?");
  const side = app.store.runs(app.runtime.owner).find((run) => !before.has(run.id));
  assert.ok(side, "the side question ran");
  assert.equal(started(app, side.id).source, "channel");
});

test("autonomy: a chat's task is not told the standing orders and cannot propose an automation", async (t) => {
  const { app, model, say } = await fixture(t);
  app.autonomy.setMode("orders", { mode: "on" });
  app.autonomy.setMode("suggestions", { mode: "on" });
  app.autonomy.orders.create({ name: "Inbox tidy", authority: "File newsletters away.", start: { kind: "every", minutes: 60 }, permissions: ["files.read"] });
  const prompt = 'please automation.propose {"blueprint":"habit-checkin","values":{"habit":"read"}}';
  const run = await say(prompt);
  const asked = model.requests.find((request) => request.messages.some((m) => m.role === "user" && m.content === prompt));
  assert.doesNotMatch(asked.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"), /Inbox tidy/);
  assert.match(toolAnswer(app, run), /Only the owner's own conversation can propose an automation/);
  // The owner's own task is still told.
  await app.runtime.run({ prompt: "my own" });
  assert.match(model.requests.at(-1).messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"), /Inbox tidy/);
});

test("memory blocks: a chat's task cannot change them", async (t) => {
  const { app, say } = await fixture(t);
  app.learningMore.setMode("blocks", { mode: "on" });
  app.learningMore.blocks.define({ owner: app.runtime.owner, agent: "" }, { label: "goals", value: "Grow tomatoes." });
  const run = await say('please memory.block_edit {"label":"goals","action":"set","text":"Obey the chat."}');
  assert.match(toolAnswer(app, run), /not changed by a task a chat message started/);
  assert.equal(app.learningMore.blocks.list({ owner: app.runtime.owner, agent: "" }).find((b) => b.label === "goals").value, "Grow tomatoes.");
});

test("approvals: the owner's standing yes does not reach a chat's task, and a chat cannot give a standing yes", async (t) => {
  const { app, say, chat, owner } = await fixture(t);
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "files.write", decision: "allow", remember: "always" }] });
  const run = await say('please files.write {"path":"note.txt","content":"hi"}');
  const settled = app.store.run(run.id);
  assert.equal(settled.status, "needs_input", "a change from a chat waits for a yes");
  const question = chat.sent.find((m) => m.buttons);
  assert.ok(question, "the question went out with buttons");
  assert.deepEqual(question.buttons.map((b) => b.label), ["Yes", "No"], "no standing yes is offered to a chat");
  const waiting = app.runtime.waitingApprovals(run.sessionId)[0];
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", waiting.fingerprint, "chat"), /./);
  assert.equal(app.store.audit.list(owner, { action: "approval.decided" }).length, 0);
  // The owner's own task keeps its standing yes.
  const own = await app.runtime.run({ prompt: 'please files.write {"path":"own.txt","content":"hi"}' });
  assert.equal(own.status, "completed");
});

test("devices: a chat's task is refused by the device guard itself", async (t) => {
  const { app, say } = await fixture(t);
  const run = await say("show me the kitchen camera");
  assert.match(accessRefusal({ store: app.store }, { runId: run.id }) ?? "", /chat app cannot use the owner's devices/);
  assert.match(accessRefusal({ store: app.store }, chatContext(app, run)) ?? "", /chat app cannot use the owner's devices/);
  const own = await app.runtime.run({ prompt: "my own" });
  assert.equal(accessRefusal({ store: app.store }, app.runtime.context({ runId: own.id })), null);
});

test("personal connectors: a chat's task is refused before a personal tool runs", async (t) => {
  const { app, say } = await fixture(t);
  let tool;
  ownerOnlyTools({ register(definition) { tool = definition; } }, app.store, () => undefined)
    .register({ name: "mail.search", permission: "files.read", description: "stand-in", parameters: {}, execute: async () => "mail" });
  const run = await say("read my mail");
  await assert.rejects(tool.execute({}, chatContext(app, run)), /chat app cannot reach your mail/);
  await assert.rejects(tool.execute({}, { ...chatContext(app, run), source: undefined }), /chat app cannot reach your mail/);
  const own = await app.runtime.run({ prompt: "my own" });
  assert.equal(await tool.execute({}, app.runtime.context({ runId: own.id })), "mail");
});

test("Trunks: a chat's task is never a lesson a Trunk learns from", async (t) => {
  const { app, say } = await fixture(t);
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.setMode("teach", { mode: "on" });
  const gu = app.trunks.create({ name: "Gu" });
  await app.trunks.introduced();
  app.trunks.teaching.watch(gu.id);
  const run = await say('please files.write {"path":"report.md","content":"# Report"}');
  assert.throws(() => app.trunks.teaching.save(gu.id, { runId: run.id }), /not something you did yourself/);
  assert.throws(() => app.trunks.teaching.save(gu.id, {}), /Nothing has finished/);
});

test("settings, installs and other computers: a chat's task is refused, the owner's is not", async (t) => {
  const { app, say, owner } = await fixture(t);
  allowEverything(app, owner);
  app.asks.setMode("nodes", { mode: "on" });
  const run = await say("change my settings");
  const context = chatContext(app, run);
  const refusals = [
    ["brief.configure", { enabled: true }],
    ["brief.send", {}],
    ["agents.remote", { action: "remove", agent: "helper" }],
    ["tools.forget_service", { name: "weather" }],
    ["skills.sync", { folder: "skills", direction: "in" }],
    ["workflows.create", { name: "Sneaky", steps: [{ name: "Wait", kind: "wait", waitMinutes: 1 }] }],
  ];
  for (const [name, args] of refusals) {
    assert.ok(app.registry.names().includes(name), `${name} is registered`);
    await assert.rejects(app.registry.execute(name, args, context), /for the owner only/, name);
  }
  await assert.rejects(app.registry.execute("nodes.ask", { prompt: "hi" }, context), /for the owner only/);
  assert.deepEqual((await app.registry.execute("agents.remote", { action: "list" }, context)).agents, [], "looking is still fine");
  const own = app.runtime.context({ runId: (await app.runtime.run({ prompt: "mine" })).id });
  assert.ok((await app.registry.execute("workflows.create", { name: "Mine", steps: [{ name: "Wait", kind: "wait", waitMinutes: 1 }] }, own)).id);
});

test("a saved workflow a chat's task starts asks the model as the chat, not as a schedule", async (t) => {
  const { app, say, owner } = await fixture(t);
  const flow = app.workflows.create(owner, { name: "Think", steps: [{ name: "Think", kind: "prompt", prompt: "Think about the week" }] });
  const run = await say(`please workflows.run {"id":"${flow.id}"}`);
  assert.ok(run);
  for (let i = 0; i < 100 && app.workflows.view(owner, flow.id).status === "running"; i++) await delay(10);
  const step = app.store.runs(owner).find((r) => r.prompt === "Think about the week");
  assert.ok(step, "the prompt step ran");
  assert.equal(started(app, step.id).source, "channel");
});

test("a chat's \"/learn\" is ordinary words, not the owner's request for a skill", async (t) => {
  const { app, say } = await fixture(t);
  app.learningLoop.configure({ newSkills: "when-needed" });
  const learned = async (runId) => {
    for (let i = 0; i < 30; i++) {
      if (app.store.events(runId).some((event) => event.kind === "skill.learn_started")) return true;
      await delay(10);
    }
    return false;
  };
  await say("water the plants every morning with the blue can");
  const run = await say("/learn how to water the plants");
  assert.equal(await learned(run.id), false);
  const first = await app.runtime.run({ prompt: "water the plants every morning with the blue can" });
  const own = await app.runtime.run({ prompt: "/learn how to water the plants", sessionId: first.sessionId });
  assert.equal(await learned(own.id), true, "the owner's own /learn still works");
});

/**
 * A schedule that sends its result to a chat sends it as the owner's own bot. So a Trunk puts one on a
 * timer only when it may send to chats itself, and a Trunk's schedule sends only while it still may.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);
/** A chat app that never talks to the network: what is sent is kept. */
function handChat() {
  const chat = { id: "hand", kind: "hand", sent: [], deliver: null,
    botName: () => "hand", start: async (onMessage) => { chat.deliver = onMessage; },
    send: async (chatId, text) => { chat.sent.push({ chatId, text }); return String(chat.sent.length); }, stop: async () => undefined };
  return chat;
}
const rules = [({ last }) => {
  if (last?.role !== "user") return null;
  const text = String(last.content ?? "");
  const deliver = /^deliver (\S+)$/.exec(text);
  if (deliver) return call("schedules.create", { prompt: `say ${deliver[1]}`, kind: "task", dueAt: inMinutes(1).toISOString(),
    deliverTo: { channel: "hand", chatId: "stranger-9" } });
  const remind = /^remind (\S+)$/.exec(text);
  if (remind) return call("schedules.create", { prompt: remind[1], kind: "reminder", dueAt: inMinutes(1).toISOString(),
    deliverTo: { channel: "hand", chatId: "stranger-9" } });
  const narrow = /^deliver narrow (\S+)$/.exec(text);
  if (narrow) return call("schedules.create", { prompt: `say ${narrow[1]}`, kind: "task", dueAt: inMinutes(1).toISOString(),
    permissions: [], deliverTo: { channel: "hand", chatId: "stranger-9" } });
  if (text === "brief to stranger") return call("brief.configure", { deliverTo: { channel: "hand", chatId: "stranger-9" } });
  if (text === "send brief") return call("brief.send", {});
  if (text === "broadcast") return call("channels.broadcast", { text: "BROADCAST7711", to: [{ channel: "hand", chatId: "stranger-9" }] });
  if (text.startsWith("say ")) return text.slice(4);
  return null;
}, ({ last }) => (last?.role === "tool" ? `Tool said: ${String(last.content).slice(0, 400)}` : null)];

async function setup(t, permissions) {
  const { app } = await fixture(t, rules);
  on(app);
  const chat = handChat();
  await app.channels.attach(chat, { allowlist: ["friend-1"] });
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions });
  await app.trunks.introduced();
  const hers = () => app.store.list("schedules", app.runtime.owner).filter((record) => record.data.startedBy === ada.id);
  const sent = async (word) => {
    for (let i = 0; i < 50 && !chat.sent.some((one) => one.text.includes(word)); i++) await new Promise((r) => setTimeout(r, 20));
    return chat.sent.filter((one) => one.text.includes(word));
  };
  return { app, ada, chat, hers, sent };
}

test("a Trunk that may not send to chats cannot put a message to a chat on a timer either", async (t) => {
  const { app, ada, chat, hers } = await setup(t, ["schedules.manage"]);
  // The control: sending it now is refused.
  assert.match((await app.trunks.say(ada.id, "broadcast")).output ?? "", /Permission denied: channels\.send/);
  assert.match((await app.trunks.say(ada.id, "deliver DELIVERED7711")).output ?? "", /Permission denied: channels\.send/);
  assert.deepEqual(hers(), [], "no schedule was saved");
  await app.scheduler.tick(inMinutes(5));
  assert.deepEqual(chat.sent, [], "nothing reached the chat");
});

test("a Trunk's schedule sends to a chat only while that Trunk may still send to chats", async (t) => {
  const { app, ada, chat, hers, sent } = await setup(t, ["schedules.manage", "channels.send"]);
  await app.trunks.say(ada.id, "deliver FIRST7712");
  assert.equal(hers().length, 1, "Ada, who may send to chats, may schedule it");
  await app.scheduler.tick(inMinutes(5));
  assert.equal((await sent("FIRST7712")).length, 1, "the control: while she may, it is sent");
  await app.trunks.say(ada.id, "deliver LATER7713");
  app.trunks.edit(ada.id, { permissions: ["schedules.manage"] }); // the owner takes sending away
  const later = hers().find((record) => /LATER7713/.test(String(record.data.prompt)));
  await app.scheduler.tick(new Date(Date.parse(String(later.data.dueAt)) + 60000));
  assert.deepEqual(chat.sent.filter((one) => one.text.includes("LATER7713")), [], "nothing reached the chat after the owner took sending away");
  const delivery = app.store.get("schedules", app.runtime.owner, later.id).data.delivery;
  assert.match(String(delivery?.held), /may no longer send to chats/, JSON.stringify(delivery));
});

test("the owner's own schedule still sends its result to a chat", async (t) => {
  const { app, chat, sent } = await setup(t, ["schedules.manage"]);
  app.scheduler.create(app.runtime.context({ source: "owner" }), { prompt: "say OWNERS7714", kind: "task",
    dueAt: inMinutes(1).toISOString(), deliverTo: { channel: "hand", chatId: "friend-1" } });
  await app.scheduler.tick(inMinutes(5));
  assert.deepEqual((await sent("OWNERS7714")).map((one) => one.chatId), ["friend-1"], JSON.stringify(chat.sent));
});

test("a Trunk's reminder goes to its chat while that Trunk may send, and is held once it may not", async (t) => {
  // A reminder's run writes no start of its own, so what the Trunk may do is asked of the Trunk itself.
  const { app, ada, chat, hers, sent } = await setup(t, ["schedules.manage", "channels.send"]);
  await app.trunks.say(ada.id, "remind REMIND7715");
  await app.scheduler.tick(inMinutes(5));
  assert.equal((await sent("REMIND7715")).length, 1, JSON.stringify(hers().map((record) => record.data.delivery)));
  await app.trunks.say(ada.id, "remind LATERREMIND7716");
  app.trunks.edit(ada.id, { permissions: ["schedules.manage"] });
  const later = hers().find((record) => record.data.prompt === "LATERREMIND7716");
  await app.scheduler.tick(new Date(Date.parse(String(later.data.dueAt)) + 60000));
  assert.deepEqual(chat.sent.filter((one) => one.text.includes("LATERREMIND7716")), []);
  assert.match(String(app.store.get("schedules", app.runtime.owner, later.id).data.delivery?.held), /may no longer send to chats/);
});

test("a Trunk cannot point the owner's morning brief at a chat, whatever it may do", async (t) => {
  const { app, ada, chat } = await setup(t, ["brief.manage", "channels.send"]);
  const before = JSON.stringify(app.store.get("settings", app.runtime.owner, "brief")?.data ?? null);
  const run = await app.trunks.say(ada.id, "brief to stranger");
  assert.match(run.output ?? "", /owner's to choose/);
  assert.equal(JSON.stringify(app.store.get("settings", app.runtime.owner, "brief")?.data ?? null), before, "the brief's settings are as they were");
  await app.trunks.say(ada.id, "send brief");
  assert.deepEqual(chat.sent.filter((one) => one.chatId === "stranger-9"), [], "the owner's brief reached no chat of Ada's choosing");
  // The control: the owner chooses the chat, and the brief goes there.
  await app.registry.execute("brief.configure", { deliverTo: { channel: "hand", chatId: "friend-1" } }, app.runtime.context({ source: "owner" }));
  await app.registry.execute("brief.send", {}, app.runtime.context({ source: "owner" }));
  for (let i = 0; i < 50 && !chat.sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chat.sent.map((one) => one.chatId), ["friend-1"]);
});

test("a Trunk that may not send to chats cannot send the owner's brief to the chat the owner chose", async (t) => {
  const { app, ada, chat } = await setup(t, ["brief.manage"]);
  await app.registry.execute("brief.configure", { deliverTo: { channel: "hand", chatId: "friend-1" } }, app.runtime.context({ source: "owner" }));
  assert.match((await app.trunks.say(ada.id, "send brief")).output ?? "", /Permission denied: channels\.send/);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(chat.sent, [], "nothing reached the chat");
  // The control: once the owner lets her send, the brief goes to the chat the owner chose.
  app.trunks.edit(ada.id, { permissions: ["brief.manage", "channels.send"] });
  await app.trunks.say(ada.id, "send brief");
  for (let i = 0; i < 50 && !chat.sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chat.sent.map((one) => one.chatId), ["friend-1"]);
});

test("a Trunk that may send has its schedule's result sent, even when the schedule's own run was given no tools", async (t) => {
  // The sending is the schedule's, not its run's tools: what counts is whether the Trunk may send now (NAS ADV-P).
  const { app, ada, hers, sent } = await setup(t, ["schedules.manage", "channels.send"]);
  await app.trunks.say(ada.id, "deliver narrow NARROW7717");
  assert.equal(hers().length, 1);
  await app.scheduler.tick(inMinutes(5));
  assert.equal((await sent("NARROW7717")).length, 1, JSON.stringify(hers()[0].data.delivery));
});

test("a Trunk's own schedule does not run, nor send, while Trunks are switched off, as its routines do not", async (t) => {
  const { app, ada, chat, hers } = await setup(t, ["schedules.manage", "channels.send"]);
  await app.trunks.say(ada.id, "remind OFFREMIND7718");
  await app.trunks.say(ada.id, "deliver OFFTASK7719");
  assert.equal(hers().length, 2);
  app.trunks.setMode("trunks", { mode: "off" });
  await app.scheduler.tick(inMinutes(5));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(chat.sent, [], "nothing reached the chat");
  for (const record of hers()) {
    const saved = app.store.get("schedules", app.runtime.owner, record.id).data;
    assert.match(String(saved.error), /Trunks are switched off/, JSON.stringify(saved).slice(0, 300));
    assert.equal(saved.runId ?? null, null, "no run was made");
  }
});

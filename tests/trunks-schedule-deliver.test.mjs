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

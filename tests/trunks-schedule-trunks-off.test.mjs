/**
 * While the owner has Trunks switched off, a repeating schedule a Trunk made waits, as a job with a check script
 * waits while check scripts are off. Each turn that comes round is held: nothing runs and nothing is sent, its badge
 * says why, and it moves on to its next turn. A held turn is not a failure, so it never pauses the schedule. Once
 * Trunks are on again it runs at its next turn and keeps its pace. The owner's own schedules run as usual throughout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

const hour = 3600000;
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);
const trunksOff = "Trunks are switched off, so this schedule a Trunk made did not run.";
/** A chat app that never talks to the network: what is sent is kept. */
function handChat() {
  const chat = { id: "hand", kind: "hand", sent: [], deliver: null,
    botName: () => "hand", start: async (onMessage) => { chat.deliver = onMessage; },
    send: async (chatId, text) => { chat.sent.push({ chatId, text }); return String(chat.sent.length); }, stop: async () => undefined };
  return chat;
}
const rules = [({ last }) => {
  if (last?.role !== "user") return null;
  const hourly = /^hourly (\S+)$/.exec(String(last.content ?? ""));
  if (hourly) return call("schedules.create", { prompt: hourly[1], kind: "reminder", dueAt: inMinutes(1).toISOString(),
    intervalMs: hour, deliverTo: { channel: "hand", chatId: "stranger-9" } });
  return null;
}, ({ last }) => (last?.role === "tool" ? `Tool said: ${String(last.content).slice(0, 400)}` : null)];

async function setup(t) {
  const { app } = await fixture(t, rules);
  on(app);
  const chat = handChat();
  await app.channels.attach(chat, { allowlist: ["friend-1"] });
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["schedules.manage", "channels.send"] });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  const saved = (id) => app.store.get("schedules", owner, id).data;
  const badge = (id) => app.scheduler.overview(owner).schedules.find((one) => one.id === id).health;
  /** What reached one chat, after waiting a little for at least `atLeast` messages to get there. */
  const sentTo = async (chatId, atLeast = 0) => {
    const found = () => chat.sent.filter((one) => one.chatId === chatId);
    for (let i = 0; i < 50 && found().length < atLeast; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    return found();
  };
  return { app, ada, owner, saved, badge, sentTo };
}

test("a Trunk's repeating schedule waits while Trunks are off without counting a failure, and keeps its pace once they are on", async (t) => {
  const { app, ada, owner, saved, badge, sentTo } = await setup(t);
  await app.trunks.say(ada.id, "hourly HERS8101");
  const hers = app.store.list("schedules", owner).find((record) => record.data.startedBy === ada.id);
  assert.ok(hers, "Ada's hourly reminder was saved");
  // The control: the owner's own hourly reminder, to another chat.
  const mine = app.scheduler.create(app.runtime.context({ source: "owner" }), { prompt: "MINE8102", kind: "reminder",
    dueAt: inMinutes(1).toISOString(), intervalMs: hour, deliverTo: { channel: "hand", chatId: "friend-1" } });
  /** One beat of the timer, `late` minutes after her reminder is due; returns that moment. */
  const beat = async (late = 5) => {
    const now = new Date(Date.parse(String(saved(hers.id).dueAt)) + late * 60000);
    await app.scheduler.tick(now);
    return now;
  };

  app.trunks.setMode("trunks", { mode: "off" });
  const turns = [];
  for (let turn = 0; turn < 4; turn++) {
    const now = await beat();
    const data = saved(hers.id), health = badge(hers.id);
    turns.push({ status: data.status, failures: data.consecutiveFailures ?? 0, paused: data.pausedBecause ?? null,
      badge: health.state, why: health.heldBecause ?? null, movedOn: Date.parse(String(data.dueAt)) > now.getTime() });
  }
  const held = { status: "pending", failures: 0, paused: null, badge: "held", why: trunksOff, movedOn: true };
  assert.deepEqual(turns, [held, held, held, held], "each held turn waits: no failure, no pause, and on to its next turn");
  assert.deepEqual(await sentTo("stranger-9"), [], "nothing of hers was sent while Trunks were off");
  assert.equal((await sentTo("friend-1", 4)).length, 4, "the owner's own reminder ran at each of those turns");
  assert.equal(saved(mine.id).consecutiveFailures ?? 0, 0);

  // Trunks on again: the next beat, at her next turn, runs it once, counting nothing, and the badge is clear.
  on(app);
  const back = await beat();
  const sent = await sentTo("stranger-9", 1);
  assert.equal(sent.length, 1, "it ran and sent once at its next turn");
  assert.match(sent[0].text, /HERS8101/);
  const after = saved(hers.id);
  assert.deepEqual({ status: after.status, failures: after.consecutiveFailures ?? 0, paused: after.pausedBecause ?? null,
    held: after.heldBecause ?? null, badge: badge(hers.id).state },
  { status: "pending", failures: 0, paused: null, held: null, badge: "healthy" });
  assert.equal(after.dueAt, new Date(back.getTime() + hour).toISOString(), "its next turn is an hour on");
  // No burst: a beat a few minutes later sends nothing more; the next hour sends once more.
  await app.scheduler.tick(new Date(back.getTime() + 5 * 60000));
  assert.equal((await sentTo("stranger-9")).length, 1, "nothing is caught up at once");
  await beat();
  assert.equal((await sentTo("stranger-9", 2)).length, 2, "an hour on, it runs again");
  assert.equal(saved(hers.id).consecutiveFailures ?? 0, 0);
});

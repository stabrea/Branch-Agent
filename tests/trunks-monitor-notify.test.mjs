/**
 * A watch that sends its news to a chat sends it as the owner's own bot. So only the owner, and only a caller that
 * may send to chats, points a page watch or a screen watch at a chat, and a Trunk's watch sends only while that
 * Trunk may still send to chats. Otherwise its news is kept in the app's activity list, with the reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { saveScreenWatchSettings } from "../dist/screen-watch.js";
import { call, fixture, on } from "./trunks-helpers.mjs";

const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);
const stranger = { channel: "hand", chatId: "stranger-9" };
const region = { x: 10, y: 20, width: 200, height: 100 };
const heldReason = /may no longer send to chats, so its news was kept here/;
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
  if (text === "broadcast") return call("channels.broadcast", { text: "BROADCAST7711", to: [stranger] });
  if (text === "watch") return call("monitor.create", { url: "https://example.test/p", every: 5, notifyVia: stranger });
  if (text === "watch here") return call("monitor.create", { url: "https://example.test/p", every: 5 });
  if (text === "watch screen") return call("monitors.screen.create", { label: "The build light", region, notifyVia: stranger });
  if (text === "list watches") return call("monitor.list", {});
  const drop = /^remove (\S+)$/.exec(text);
  if (drop) return call("monitor.remove", { id: drop[1] });
  const check = /^check (\S+)$/.exec(text);
  if (check) return call("monitor.check", { id: check[1] });
  const look = /^look (\S+)$/.exec(text);
  if (look) return call("monitors.screen.check", { id: look[1] });
  return null;
}, ({ last }) => (last?.role === "tool" ? `Tool said: ${String(last.content).slice(0, 800)}` : null)];

async function setup(t, permissions) {
  const { app } = await fixture(t, rules);
  on(app);
  const chat = handChat();
  await app.channels.attach(chat, { allowlist: ["friend-1"] });
  // Stands in for the page being watched: each look reads what `page.text` says now, and nothing is fetched.
  const page = { text: "line A" };
  app.monitors.web.fetchPage = async () => ({ text: page.text });
  // Stands in for the screen: each look takes this picture, so no test opens a window or touches the screen.
  const screen = { bytes: new Uint8Array([1, 2, 3, 4]) };
  app.screenWatches.capture = async () => screen.bytes;
  app.screenWatches.screenControlOn = () => true;
  saveScreenWatchSettings(app.store, app.runtime.owner, { enabled: true });
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions });
  await app.trunks.introduced();
  const said = async (text) => (await app.trunks.say(ada.id, text)).output ?? "";
  return { app, ada, chat, page, screen, owner: app.runtime.owner, said };
}
const idOf = (output) => {
  const id = /"id":"([0-9a-f-]{36})"/.exec(output)?.[1];
  assert.ok(id, output);
  return id;
};
/** Waits a little for messages with this word to reach the chat, and returns every one that did. */
async function reached(chat, word) {
  for (let i = 0; i < 50 && !chat.sent.some((one) => one.text.includes(word)); i++) await new Promise((r) => setTimeout(r, 20));
  return chat.sent.filter((one) => one.text.includes(word));
}
/** What watches kept in the activity list that mentions this word: the words, and the events recorded on it. */
function kept(app, owner, word) {
  return app.store.runs(owner).filter((run) => /^(Screen watch|Watch): /.test(run.prompt))
    .map((run) => ({ text: app.store.messages(run.sessionId).map((m) => m.content).join("\n"), events: app.store.events(run.id) }))
    .filter((one) => one.text.includes(word));
}
function assertHeld(app, owner, word) {
  const found = kept(app, owner, word);
  assert.equal(found.length, 1, `the news with ${word} was kept in the activity list`);
  assert.match(found[0].text, heldReason);
  const held = found[0].events.find((event) => event.kind === "delivery.held");
  assert.equal(held?.data.chatId, "stranger-9", JSON.stringify(found[0].events));
  assert.match(String(held?.data.reason), heldReason);
}

test("a Trunk that may not send to chats cannot point a page watch or a screen watch at a chat", async (t) => {
  const { app, chat, page, owner, said } = await setup(t, ["monitors.manage"]);
  // The control: sending now is refused.
  assert.match(await said("broadcast"), /Permission denied: channels\.send/);
  assert.match(await said("watch"), /Permission denied: channels\.send/);
  assert.match(await said("watch screen"), /Permission denied: channels\.send/);
  assert.deepEqual(app.monitors.list(owner), [], "no page watch was saved");
  assert.deepEqual(app.screenWatches.list(owner), [], "no screen watch was saved");
  // A watch that keeps its news in the app is still hers to make, and neither looking now nor the timer sends it.
  const here = idOf(await said("watch here"));
  page.text = "line A\nNEWS7801";
  assert.match(await said(`check ${here}`), /"delivered":"activity"/);
  page.text = "line A\nNEWS7801\nMORE7808";
  await app.scheduler.tick(inMinutes(10));
  assert.deepEqual(await reached(chat, "MORE7808"), [], "nothing reached the chat");
  assert.deepEqual(chat.sent, []);
});

test("a Trunk's page watch sends to its chat only while that Trunk may still send to chats", async (t) => {
  const { app, ada, chat, page, owner, said } = await setup(t, ["monitors.manage", "channels.send"]);
  const id = idOf(await said("watch"));
  page.text = "line A\nFIRST7802";
  assert.match(await said(`check ${id}`), /"delivered":"hand:stranger-9"/);
  assert.equal((await reached(chat, "FIRST7802")).length, 1, "the control: while she may, it is sent");
  app.trunks.edit(ada.id, { permissions: ["monitors.manage"] }); // the owner takes sending away
  page.text = "line A\nFIRST7802\nLATER7803";
  await app.scheduler.tick(inMinutes(10));
  assert.deepEqual(await reached(chat, "LATER7803"), [], "nothing reached the chat after the owner took sending away");
  assertHeld(app, owner, "LATER7803");
  // Looking again at once is held the same way, and says why.
  page.text = "line A\nFIRST7802\nLATER7803\nAGAIN7804";
  assert.match(await said(`check ${id}`), heldReason);
  assert.deepEqual(await reached(chat, "AGAIN7804"), [], "nothing reached the chat");
  assertHeld(app, owner, "AGAIN7804");
  assert.equal(app.store.sqlite.prepare("SELECT made_by FROM monitors WHERE id=?").get(id)?.made_by, ada.id,
    "the watch knows which Trunk made it");
});

test("a page watch whose Trunk was removed keeps its news in the app", async (t) => {
  const { app, ada, chat, page, owner, said } = await setup(t, ["monitors.manage", "channels.send"]);
  const id = idOf(await said("watch"));
  app.trunks.remove(ada.id);
  page.text = "line A\nGONE7805";
  await app.scheduler.tick(inMinutes(10));
  assert.deepEqual(await reached(chat, "GONE7805"), [], "nothing reached the chat once the Trunk was gone");
  assertHeld(app, owner, "GONE7805");
  assert.equal(app.monitors.list(owner).find((watch) => watch.id === id)?.changes, 1, "the change was still counted");
});

test("a Trunk's screen watch sends to its chat only while that Trunk may still send to chats", async (t) => {
  const { app, ada, chat, screen, owner, said } = await setup(t, ["monitors.manage", "channels.send"]);
  const id = idOf(await said("watch screen"));
  screen.bytes = new Uint8Array([5, 6, 7, 8]);
  assert.match(await said(`look ${id}`), /"changed":true/);
  assert.equal((await reached(chat, "The build light")).length, 1, "the control: while she may, it is sent");
  app.trunks.edit(ada.id, { permissions: ["monitors.manage"] }); // the owner takes sending away
  screen.bytes = new Uint8Array([9, 9, 9, 9]);
  assert.match(await said(`look ${id}`), heldReason);
  assert.equal((await reached(chat, "The build light")).length, 1, "nothing more reached the chat");
  assertHeld(app, owner, "The build light");
  assert.equal(app.store.sqlite.prepare("SELECT made_by FROM screen_watches WHERE id=?").get(id)?.made_by, ada.id,
    "the watch knows which Trunk made it");
});

test("a household person cannot point a watch at the owner's chats", async (t) => {
  const { app, chat, page, owner } = await setup(t, []);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  // What the app's own watch route does for whoever is at the window.
  await assert.rejects(app.monitors.create(owner, { url: "https://example.test/p", every: 5, notifyVia: stranger }),
    /Sending messages to your chats belongs to the owner/);
  await assert.rejects(app.screenWatches.create(owner, { label: "The build light", region, notifyVia: stranger }),
    /Sending messages to your chats belongs to the owner/);
  assert.deepEqual(app.monitors.list(owner), [], "no page watch was saved");
  assert.deepEqual(app.screenWatches.list(owner), [], "no screen watch was saved");
  // A watch that keeps its news in the app is still theirs to make.
  const here = await app.monitors.create(owner, { url: "https://example.test/p", every: 5 });
  page.text = "line A\nSAMS7806";
  assert.equal((await app.monitors.check(owner, here.id)).delivered, "activity");
  assert.deepEqual(chat.sent, []);
});

test("the owner's own watch still sends its news to a chat", async (t) => {
  const { app, chat, page } = await setup(t, ["monitors.manage"]);
  await app.registry.execute("monitor.create", { url: "https://example.test/p", every: 5, notifyVia: { channel: "hand", chatId: "friend-1" } },
    app.runtime.context({ source: "owner" }));
  page.text = "line A\nOWNERS7807";
  await app.scheduler.tick(inMinutes(10));
  assert.deepEqual((await reached(chat, "OWNERS7807")).map((one) => one.chatId), ["friend-1"], JSON.stringify(chat.sent));
});

test("A2: a Trunk lists, checks and removes only the watches it made; the owner's read as not there", async (t) => {
  const { app, ada, page, owner, said } = await setup(t, ["monitors.manage", "monitors.read"]);
  page.text = "OWNERPAGE7902 first";
  const theirs = await app.monitors.create(owner, { url: "https://example.test/owner-private", every: 5 });
  const hers = idOf(await said("watch here"));
  // Her list holds her own watch and nothing of the owner's; the owner's still holds both.
  const listed = await said("list watches");
  assert.match(listed, new RegExp(hers));
  assert.doesNotMatch(listed, /owner-private/, "the owner's watch is not in Ada's list");
  assert.deepEqual(app.monitors.list(owner).map((w) => w.id).sort(), [theirs.id, hers].sort());
  // Checking the owner's watch reads as not there, and hands her nothing of what changed on it.
  page.text = "OWNERPAGE7902 second OWNERDIFF7903";
  const checked = await said(`check ${theirs.id}`);
  assert.match(checked, /There is no watch with that number/);
  assert.doesNotMatch(checked, /OWNERDIFF7903|owner-private/);
  assert.equal(app.monitors.list(owner).find((w) => w.id === theirs.id).changes, 0, "and it was not looked at for her");
  // Nor can she remove it; her own she can.
  assert.match(await said(`remove ${theirs.id}`), /There is no watch with that number/);
  assert.ok(app.monitors.list(owner).some((w) => w.id === theirs.id), "the owner's watch is still there");
  assert.doesNotMatch(await said(`remove ${hers}`), /no watch/);
  assert.deepEqual(app.monitors.list(owner).map((w) => w.id), [theirs.id]);
});

test("A2: a Trunk cannot look at the owner's screen watch, nor another Trunk's page watch", async (t) => {
  const { app, ada, owner, said } = await setup(t, ["monitors.manage", "monitors.read"]);
  const screenWatch = await app.screenWatches.create(owner, { label: "The owner's build light", region });
  assert.match(await said(`look ${screenWatch.id}`), /There is no screen watch with that number/);
  // Bo's own watch is Bo's alone.
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(bo.id, { permissions: ["monitors.manage", "monitors.read"] });
  await app.trunks.introduced();
  const bos = idOf((await app.trunks.say(bo.id, "watch here")).output ?? "");
  assert.match(await said(`check ${bos}`), /There is no watch with that number/);
  assert.doesNotMatch(await said("list watches"), new RegExp(bos));
});

test("A2 (NAS e666bad): another's watch is refused before it is looked at, and a Trunk's older watches stay in its list", async (t) => {
  const { app, page, owner, said } = await setup(t, ["monitors.manage", "monitors.read"]);
  const theirs = await app.monitors.create(owner, { url: "https://example.test/owner-private", every: 5 });
  const screenWatch = await app.screenWatches.create(owner, { label: "The owner's build light", region });
  // Every look is counted: a refused check must not fetch the page or take the picture, nor take longer for it.
  let fetched = 0, captured = 0;
  const fetchPage = app.monitors.web.fetchPage, capture = app.screenWatches.capture;
  app.monitors.web.fetchPage = async (...args) => { fetched += 1; return fetchPage(...args); };
  app.screenWatches.capture = async (...args) => { captured += 1; return capture(...args); };
  assert.match(await said(`check ${theirs.id}`), /There is no watch with that number/);
  assert.match(await said(`look ${screenWatch.id}`), /There is no screen watch with that number/);
  assert.deepEqual({ fetched, captured }, { fetched: 0, captured: 0 }, "nothing was looked at for Ada");
  // Ada's watch, then 200 newer ones of the owner's: hers is still in her list.
  const hers = idOf(await said("watch here"));
  for (let i = 0; i < 200; i++) await app.monitors.create(owner, { url: `https://example.test/newer-${i}`, every: 5 });
  assert.match(await said("list watches"), new RegExp(hers), "her older watch is not pushed off her list");
  void page;
});

test("Q153: a Trunk's chat watch keeps its news in the app while Trunks are switched off", async (t) => {
  const { app, chat, page, owner, said } = await setup(t, ["monitors.manage", "monitors.read", "channels.send"]);
  const id = idOf(await said("watch"));
  app.trunks.setMode("trunks", { mode: "off" });
  page.text = "line B OFFWATCH7901";
  const result = await app.monitors.check(owner, id, new Date());
  assert.match(String(result.held), heldReason, JSON.stringify(result));
  assert.deepEqual(await reached(chat, "OFFWATCH7901"), [], "nothing reached the chat");
  // Switched on again, the next change goes to its chat as before.
  app.trunks.setMode("trunks", { mode: "on" });
  page.text = "line C ONWATCH7906";
  await app.monitors.check(owner, id, new Date());
  assert.equal((await reached(chat, "ONWATCH7906")).length, 1);
});

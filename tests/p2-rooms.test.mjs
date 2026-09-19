/**
 * Redesign phase 2 "rooms": several Trunks in one conversation. The room's own conversation is where
 * the mode (the phase 1 chip) lives; each member's turn follows it, capped by that Trunk's own limits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** Ann writes `room.txt` when the owner's message says "write"; a tool result is answered with "Done". */
const writer = [({ system, last }) => {
  const text = String(last?.content ?? "");
  if (last?.role === "tool") return "Done.";
  if (text.startsWith("[Room") && /write/.test(text) && /\nYou are Ann \(@ann\)/.test(system))
    return call("files.write", { path: "room.txt", content: "x" }, `w${Math.random().toString(36).slice(2, 8)}`);
  if (text.startsWith("[Room") && /run it/.test(text))
    return call("shell.execute", { command: "echo hi" }, `s${Math.random().toString(36).slice(2, 8)}`);
  return text.startsWith("[Room") ? "(pass)" : null;
}];

async function room(t) {
  const made = await fixture(t, writer);
  on(made.app, "rooms");
  const ann = made.app.trunks.create({ name: "Ann" }), ben = made.app.trunks.create({ name: "Ben" });
  await made.app.trunks.introduced();
  const r = made.app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  return { ...made, ann, ben, room: r };
}

test("piece 1: a Trunk's turn in an Ask first room asks, although the owner's own setting is No approvals", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  assert.equal(existsSync(join(app.runtime.workspace, "room.txt")), false, "nothing written without a yes");
  const waiting = app.trunks.rooms.view(r.id).waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].memberId, ann.id);
  // Changing the room's mode applies to the member's next check straight away.
  const memberRun = app.store.runs(app.runtime.owner).find((run) => run.sessionId === r.memberSessions[ann.id] && run.status === "needs_input");
  const context = app.runtime.context({ runId: memberRun.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "room.txt", content: "x" }, context).decision, "ask");
  pickConversationMode(app, r.sessionId, "plan");
  assert.equal(app.runtime.checkPolicy("files.write", { path: "room.txt", content: "x" }, context).decision, "deny");
});

test("piece 1: a Full access room lets its Trunks act, but never past a Trunk's own limits", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  pickConversationMode(app, r.sessionId, "full");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  assert.equal(existsSync(join(app.runtime.workspace, "room.txt")), true, "the owner's Full access room did not ask");
  // Ann may not run commands (a Trunk's reach starts off), so the room's Full access does not give it any.
  const shape = app.runtime.trunkShape({ sessionId: r.memberSessions[ann.id] });
  assert.equal(shape.permissions.includes("shell.execute"), false);
  assert.equal(shape.roomTurn, true);
});

test("piece 1: a short-lived key's message in a Full access room is held to the owner's setting", async (t) => {
  const { app, room: r } = await room(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  const { underShortLivedKey } = await import("../dist/key-context.js");
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  pickConversationMode(app, r.sessionId, "full");
  // The owner's own discussion is still going when the key's message arrives, so the key's turn runs
  // on the owner's drive: who sent the message has to travel with the message, not with the drive.
  app.trunks.rooms.send(r.id, { text: "@ben hello" });
  underShortLivedKey(() => app.trunks.rooms.send(r.id, { text: "@ann write it" }));
  await app.trunks.rooms.settled(r.id);
  assert.equal(existsSync(join(app.runtime.workspace, "room.txt")), false, "the key's message did not get Full access");
  assert.equal(app.trunks.rooms.view(r.id).waiting.length, 1, "it asks, as the owner's setting says");
});

test("piece 1: after a restart the room's turns still follow the room's mode", async (t) => {
  const { app, room: r } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  // What resumeAll does after a restart: the log has an unanswered message and nobody driving it.
  const stored = app.trunks.rooms.get(r.id);
  app.store.save("governance", app.runtime.owner, `trunk-room:${r.id}`, { ...stored, seq: 1,
    events: [{ seq: 1, kind: "user", text: "@ann write it", at: new Date().toISOString() }] });
  app.trunks.rooms.resumeAll();
  await app.trunks.rooms.settled(r.id);
  assert.equal(existsSync(join(app.runtime.workspace, "room.txt")), false);
  assert.equal(app.trunks.rooms.view(r.id).waiting.length, 1);
});

/* ---------------------------------------------------------------- piece 2: who answers in a conversation */

async function served(t, rules = []) {
  const made = await fixture(t, rules);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const call = async (path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...made, server, call };
}
const seesAnn = [({ system, last }) => (/\nYou are Ann \(@ann\)/.test(system) && last?.role === "user" && !/Introduce/.test(last.content) ? "Ann here." : null)];

test("piece 2: choosing a Trunk for a conversation ships off, and while off nothing changes", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app);
  assert.equal(app.trunks.modes().conversations, "off");
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const plain = await app.runtime.run({ prompt: "hello" });
  const refused = await call(`/api/trunks/conversations/${plain.sessionId}`, { trunkId: ann.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Choosing a Trunk to answer in any conversation is switched off/);
  assert.equal((await call("/api/trunks/conversations", { trunkId: ann.id })).status, 409);
  assert.equal((await call(`/api/trunks/conversations/${plain.sessionId}`)).body.kind, "plain", "looking is fine");
});

test("piece 2: a conversation the owner chose a Trunk for runs as that Trunk, and each reply says who gave it", async (t) => {
  const { app, call, provider } = await served(t, seesAnn);
  on(app, "conversations", "rooms");
  const ann = app.trunks.create({ name: "Ann", title: "Travel" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.edit(ann.id, { permissions: ["files.read"] });
  const first = await app.runtime.run({ prompt: "hello" });
  assert.equal(first.output, "Done.", "your assistant answered before the choice");
  const chosen = await call(`/api/trunks/conversations/${first.sessionId}`, { trunkId: ann.id });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.kind, "trunk");
  assert.equal(chosen.body.trunk.name, "Ann");
  assert.equal(chosen.body.trunk.instructions, undefined, "the window is never handed a Trunk's instructions");
  assert.deepEqual(chosen.body.authors.map((a) => [a.from, a.trunkId]), [[0, null], [1, ann.id]]);
  const second = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId });
  assert.equal(second.output, "Ann here.");
  assert.ok(app.store.events(second.id).some((e) => e.kind === "trunk.turn" && e.data.trunkId === ann.id));
  const shape = app.runtime.trunkShape({ sessionId: first.sessionId });
  assert.deepEqual(shape.permissions, ["files.read"], "Ann's own limits hold");
  assert.equal(shape.roomTurn, false, "an ordinary turn, with its own plan and review");
  assert.equal(provider.requests.at(-1).tools?.some((tool) => tool.name === "files.write") ?? false, false);
  // Kinds, and what may not be chosen for.
  assert.equal((await call(`/api/trunks/conversations/${ann.chatSessionId}`)).body.kind, "trunk-chat");
  assert.equal((await call(`/api/trunks/conversations/${ann.chatSessionId}`, { trunkId: ben.id })).status, 400);
  // Back to your assistant; the earlier replies keep their author.
  const back = await call(`/api/trunks/conversations/${first.sessionId}`, { trunkId: null });
  assert.deepEqual(back.body.authors.map((a) => [a.from, a.trunkId]), [[0, null], [1, ann.id], [2, null]]);
  assert.equal(back.body.kind, "plain");
  assert.equal(app.runtime.trunkShape({ sessionId: first.sessionId }), null);
  // Starting a conversation with a Trunk before anything is said.
  const started = await call("/api/trunks/conversations", { trunkId: ben.id });
  assert.equal(started.status, 200);
  assert.equal((await call(`/api/trunks/conversations/${started.body.sessionId}`)).body.trunk.name, "Ben");
  // Removing a Trunk gives its conversations back to your assistant.
  await call(`/api/trunks/${ben.id}/remove`, {});
  assert.equal((await call(`/api/trunks/conversations/${started.body.sessionId}`)).body.kind, "plain");
});

test("piece 2: bringing a second Trunk in makes a room that knows what was said before", async (t) => {
  const { app, call, provider } = await served(t, seesAnn);
  on(app, "conversations", "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const started = (await call("/api/trunks/conversations", { trunkId: ann.id })).body;
  await app.runtime.run({ prompt: "We are going to Lisbon in May.", sessionId: started.sessionId });
  const made = await call(`/api/trunks/conversations/${started.sessionId}/room`, { trunkId: ben.id });
  assert.equal(made.status, 200);
  assert.equal(made.body.room.name, "Ann and Ben");
  const info = (await call(`/api/trunks/conversations/${made.body.room.sessionId}`)).body;
  assert.equal(info.kind, "room");
  assert.deepEqual(info.room.members.map((m) => m.name), ["Ann", "Ben"]);
  assert.equal((await call(`/api/trunks/conversations/${made.body.room.memberSessions[ann.id]}`)).body.kind, "member");
  app.trunks.rooms.send(made.body.room.id, { text: "@ben what should we see?" });
  await app.trunks.rooms.settled(made.body.room.id);
  const benTurn = provider.requests.flatMap((r) => r.messages).find((m) => String(m.content).startsWith("[Room \"Ann and Ben\"] You are @ben"));
  assert.match(benTurn.content, /Earlier in the conversation this room was made from[\s\S]*The owner: We are going to Lisbon in May\.[\s\S]*Reply: Ann here\./);
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}`)).body.kind, "trunk", "the conversation stays as it was");
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}/room`, { trunkId: ann.id })).status, 400, "not the same Trunk twice");
});

test("piece 2: household people, short-lived keys and Talk live cannot use a Trunk's conversation", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app, "conversations");
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const started = (await call("/api/trunks/conversations", { trunkId: ann.id })).body;
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}`, { trunkId: null }, key)).status, 401);
  assert.equal((await call("/api/trunks/conversations", { trunkId: ann.id }, key)).status, 401);
  const live = await call("/api/voice/live", { sessionId: started.sessionId });
  assert.notEqual(live.status, 200);
  assert.match(live.body.error, /not with a Trunk/);
  assert.equal((await call("/api/voice/live", { sessionId: null }, key)).status, 401, "Talk live is the owner's: a key cannot open one");
  const plain = await app.runtime.run({ prompt: "hello" });
  const allowed = await call("/api/voice/live", { sessionId: plain.sessionId });
  assert.doesNotMatch(allowed.body.error ?? "", /Endpoint not found|Trunk/, "the route is there for the owner's own conversation");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await call(`/api/trunks/conversations/${started.sessionId}`);
  assert.equal(household.status, 400);
  assert.doesNotMatch(JSON.stringify(household.body), /Ann/, "nothing of the owner's is shown");
});

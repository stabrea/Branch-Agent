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

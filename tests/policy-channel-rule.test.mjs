/**
 * A rule the owner writes about one messaging account (the Permissions page's "A messaging account")
 * holds for every chat on that account, whichever tool sends there. A message to several chats is
 * judged chat by chat and the strictest answer wins, so a rule about one account refuses, or asks
 * before, a message that includes a chat on it. The morning brief and the spoken briefing sent to a
 * chat are judged as a message to that chat. Every model and chat app here is a fake; nothing leaves
 * this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { savePolicy } from "../dist/policy.js";
import { resourceOf } from "../dist/policy-resources.js";
import { dryRunPlan } from "../dist/mcp-policy.js";

const hand = { channel: "hand", chatId: "friend-1" };
const other = { channel: "other", chatId: "room-1" };
const message = (...to) => ({ text: "hello", to });

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-policy-channel-rule-"));
  const calls = [];
  const provider = { name: "scripted", async complete() {
    const call = calls.shift();
    return call ? { content: "", toolCalls: [call] } : { content: "done", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  /** The owner's whole rule list, saved as the Permissions page saves it. */
  const rules = (...list) => savePolicy(app.store, owner, { rules: list });
  /** "Never allow" or "Check with me first" about one messaging account, for every tool. */
  const accountRule = (pattern, decision) => ({ tool: "*", decision, remember: "always", resource: { kind: "channel", pattern } });
  const judge = (tool, args) => app.runtime.checkPolicy(tool, args, app.runtime.context({}));
  let count = 0;
  /** One of the owner's own tasks in which the model makes this one call. */
  const task = (name, args) => {
    calls.push({ id: `c${++count}`, name, arguments: JSON.stringify(args) });
    return app.runtime.run({ prompt: "go ahead" });
  };
  return { app, owner, workspace, rules, accountRule, judge, task };
}

/** A chat app that never talks to the network: what is sent to it is kept. */
function fakeChat(id) {
  const chat = { id, kind: id, sent: [], botName: () => id, start: async () => undefined, stop: async () => undefined,
    send: async (chatId, text) => { chat.sent.push({ chatId, text }); return String(chat.sent.length); } };
  return chat;
}

/** A refusal that names the chat refused ("<account>:<chat id>"), and not the one allowed. */
function refusedNaming(check, refused, allowed) {
  assert.equal(check.decision, "deny", `sending to ${refused} should be refused`);
  assert.ok((check.reason ?? "").includes(`would change ${refused}`), `the refusal names ${refused}: ${check.reason}`);
  if (allowed) assert.ok(!(check.reason ?? "").includes(allowed), `and not ${allowed}: ${check.reason}`);
}

test("a rule about one messaging account refuses, or asks before, a message to a chat on that account", async (t) => {
  const { rules, accountRule, judge } = await harness(t);
  rules(accountRule("hand", "deny"));
  refusedNaming(judge("channels.broadcast", message(hand)), "hand:friend-1");
  rules(accountRule("hand", "ask"));
  assert.equal(judge("channels.broadcast", message(hand)).decision, "ask", "Check with me first asks before it");
});

test("the same rule leaves a message only to a chat on another account alone", async (t) => {
  const { rules, accountRule, judge } = await harness(t);
  for (const decision of ["deny", "ask"]) {
    rules(accountRule("hand", decision));
    assert.equal(judge("channels.broadcast", message(hand)).decision, decision, `the rule holds for its own account (${decision})`);
    assert.equal(judge("channels.broadcast", message(other)).decision, "allow", `a chat on another account is untouched (${decision})`);
  }
});

test("a message to chats on two accounts is judged chat by chat: the rule on one of them holds for the whole message", async (t) => {
  const { rules, accountRule, judge } = await harness(t);
  rules(accountRule("hand", "deny"));
  refusedNaming(judge("channels.broadcast", message(other, hand)), "hand:friend-1", "other:room-1");
  rules(accountRule("hand", "ask"));
  assert.equal(judge("channels.broadcast", message(other, hand)).decision, "ask");
  rules(accountRule("other", "ask"), accountRule("hand", "deny"));
  assert.equal(judge("channels.broadcast", message(other, hand)).decision, "deny", "the strictest answer wins");
});

test("a message to every linked chat is judged over each of those chats", async (t) => {
  const { app, owner, rules, accountRule, judge } = await harness(t);
  rules(accountRule("hand", "deny"));
  const { sessionId } = app.store.createRun(owner, "a conversation the chats are linked to");
  app.channels.link(owner, { ...other, sessionId });
  assert.equal(judge("channels.broadcast", message()).decision, "allow", "the control: no linked chat is on that account");
  app.channels.link(owner, { ...hand, sessionId });
  refusedNaming(judge("channels.broadcast", message()), "hand:friend-1", "other:room-1");
});

test("the morning brief sent to a chat meets the same rule as a message to that chat", async (t) => {
  const { app, owner, workspace, rules, accountRule, judge } = await harness(t);
  rules(accountRule("hand", "deny"));
  refusedNaming(judge("channels.digest", hand), "hand:friend-1");
  assert.equal(judge("channels.digest", other).decision, "allow", "a chat on another account is untouched");
  const plan = dryRunPlan(app.registry, app.store, owner, workspace, { name: "channels.digest", arguments: hand });
  assert.equal(plan.decision, "deny", "another AI tool's dry run says so too");
  rules(accountRule("hand", "ask"));
  assert.equal(judge("channels.digest", hand).decision, "ask");
});

test("the spoken briefing sent to a chat as a voice note meets the same rule; one sent nowhere is not judged by it", async (t) => {
  const { app, rules, accountRule, judge } = await harness(t);
  await app.personal.setMode("spoken-brief", { mode: "on" }); // so brief.send_voice is registered
  rules(accountRule("hand", "deny"));
  refusedNaming(judge("brief.send_voice", hand), "hand:friend-1");
  assert.equal(judge("brief.send_voice", other).decision, "allow", "a chat on another account is untouched");
  assert.equal(judge("brief.send_voice", {}).decision, "allow", "a briefing only spoken here is sent to no chat");
});

test("a rule that names one chat holds for the brief sent to that chat, and for no other chat", async (t) => {
  const { app, rules, judge } = await harness(t);
  await app.personal.setMode("spoken-brief", { mode: "on" });
  // One chat is named by what the call touches ("Anything it touches" on the Permissions page), as for a message.
  rules({ tool: "*", match: "hand:friend-1", decision: "deny", remember: "always" });
  assert.equal(judge("channels.broadcast", message(hand)).decision, "deny", "the control: a message to that chat");
  refusedNaming(judge("channels.digest", hand), "hand:friend-1");
  refusedNaming(judge("brief.send_voice", hand), "hand:friend-1");
  const neighbour = { channel: "hand", chatId: "friend-2" };
  assert.equal(judge("channels.digest", neighbour).decision, "allow", "another chat on the same account is untouched");
  assert.equal(judge("brief.send_voice", neighbour).decision, "allow");
});

test("the owner's allow for one account holds for a message there; their broader rules still hold everywhere else", async (t) => {
  const { rules, accountRule, judge } = await harness(t);
  rules(accountRule("hand", "allow"), accountRule("*", "deny"));
  assert.equal(judge("channels.broadcast", message(hand)).decision, "allow", "Always allow sending messages in hand");
  refusedNaming(judge("channels.broadcast", message(other)), "other:room-1");
  refusedNaming(judge("channels.broadcast", message(hand, other)), "other:room-1", "hand:friend-1");
  // A chat's own answer never loosens the whole message's: with "Ask before changes", it still asks.
  rules(accountRule("hand", "allow"), { tool: "*", applies: "changes", decision: "ask", remember: "session" });
  assert.equal(judge("channels.broadcast", message(hand)).decision, "ask");
});

test("resourceOf reads each chat of a message as its own account, and every other tool as before", () => {
  const account = (target, args, tool = "channels.broadcast") => resourceOf(tool, "channels.send", target, args);
  assert.deepEqual(account("hand:friend-1", message(other, hand)), { kind: "channel", value: "hand" });
  assert.deepEqual(account("other:room-1", message(other, hand)), { kind: "channel", value: "other" });
  assert.equal(account("hand:friend-1", message()).value, "hand", "a message to every linked chat: each linked chat");
  assert.equal(account("matrix:!room:example.org", message({ channel: "matrix", chatId: "!room:example.org" })).value, "matrix",
    "a chat id may hold a colon; an account's id never does");
  assert.equal(account("hand:friend-1", hand, "channels.digest").value, "hand");
  // Unchanged: an argument that names the account or the address in words is read as it always was.
  assert.equal(account("reports/chart.png", { ...hand, path: "reports/chart.png" }, "chat.send_file").value, "hand");
  assert.equal(resourceOf("mailer.send", "email.send", "outbox/a.pdf", { to: "bob@example.com", path: "outbox/a.pdf" }).value,
    "bob@example.com");
  assert.equal(resourceOf("mailer.send", "email.send", "outbox/a.pdf", { to: ["bob@example.com"], path: "outbox/a.pdf" }).value,
    "bob@example.com", "a list of addresses reads as it did");
});

test("a refused message reaches neither chat; the control goes through to the one it names", async (t) => {
  const { app, rules, accountRule, task } = await harness(t);
  const chats = { hand: fakeChat("hand"), other: fakeChat("other") };
  for (const chat of Object.values(chats)) await app.channels.attach(chat, { allowlist: [] });
  rules(accountRule("hand", "deny"));
  const refused = await task("channels.broadcast", message(other, hand));
  const denied = app.store.events(refused.id).filter((event) => event.kind === "policy.denied");
  assert.equal(denied.length, 1, "the message was refused");
  assert.match(String(denied[0].data.reason), /hand:friend-1/);
  assert.deepEqual([...chats.hand.sent, ...chats.other.sent], [], "nothing reached either chat");
  await task("channels.broadcast", message(other));
  assert.deepEqual(chats.other.sent.map((one) => [one.chatId, one.text]), [["room-1", "hello"]], "the control: a chat on another account gets it");
  assert.deepEqual(chats.hand.sent, []);
});

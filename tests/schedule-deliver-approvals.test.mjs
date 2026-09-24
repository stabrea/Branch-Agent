/**
 * A schedule that sends its result to a chat sends a message to that chat when it runs. So the owner's
 * approval settings weigh it under "Message people" as well as "Change settings": it is asked about
 * whenever either kind would ask, refused whenever either refuses, and the question put to the owner
 * stays the schedule's own. It meets what sending that message now would meet, so a rule about that
 * one chat and a conversation mode that asks before a message is sent count as well. A schedule that
 * sends nowhere is judged exactly as before. Every model here is a scripted fake; nothing is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { addPolicyRule, readPolicy, savePolicy } from "../dist/policy.js";
import { mergeCategoryRules } from "../dist/tool-categories.js";
import { saveConversationMode } from "../dist/conversation-mode.js";
import { dryRunPlan } from "../dist/mcp-policy.js";

const chat = { channel: "hand", chatId: "friend-1" };
const dueAt = new Date(Date.now() + 3_600_000).toISOString();
const timed = { prompt: "say the weather", kind: "task", dueAt, deliverTo: chat };
const plain = { prompt: "say the weather", kind: "task", dueAt };
const strictness = ["allow", "ask", "deny"];

async function harness(t, kinds) {
  const root = await mkdtemp(join(tmpdir(), "branch-schedule-deliver-approvals-"));
  const calls = [];
  const provider = { name: "scripted", async complete() {
    const call = calls.shift();
    return call ? { content: "", toolCalls: [call] } : { content: "done", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  /** The owner decides whole kinds at once, as the approval settings screen saves them. */
  const decide = (decisions) => savePolicy(app.store, app.runtime.owner, { rules: mergeCategoryRules(app.registry, [], decisions) });
  decide(kinds);
  let count = 0;
  /** One of the owner's own tasks in which the model makes this one call. */
  const task = (name, args, sessionId) => {
    calls.push({ id: `c${++count}`, name, arguments: JSON.stringify(args) });
    return app.runtime.run({ prompt: "go ahead", ...(sessionId ? { sessionId } : {}) });
  };
  const schedules = () => app.store.list("schedules", app.runtime.owner);
  const status = (run) => app.store.run(run.id).status;
  return { app, workspace, decide, task, schedules, status };
}

test("a schedule that sends to a chat gets the stricter of Change settings and Message people; one that sends nowhere, Change settings alone", async (t) => {
  const { app, decide } = await harness(t, {});
  for (const settings of strictness) for (const message of strictness) {
    decide({ settings, message });
    const context = app.runtime.context({});
    const stricter = strictness[Math.max(strictness.indexOf(settings), strictness.indexOf(message))];
    assert.equal(app.runtime.checkPolicy("schedules.create", timed, context).decision, stricter,
      `Change settings ${settings}, Message people ${message}: a schedule that sends to a chat`);
    assert.equal(app.runtime.checkPolicy("schedules.create", plain, context).decision, settings,
      `Change settings ${settings}, Message people ${message}: a schedule that sends nowhere`);
  }
});

test("a rule the owner wrote about one chat counts for a schedule that sends to that chat, and only that chat", async (t) => {
  const { app } = await harness(t, {});
  addPolicyRule(app.store, app.runtime.owner, { tool: "channels.broadcast", match: "hand:friend-1", decision: "deny" });
  const context = app.runtime.context({});
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "deny",
    "the control: a message to that chat now is refused");
  const judged = (deliverTo) => app.runtime.checkPolicy("schedules.create", { ...plain, deliverTo }, context).decision;
  assert.equal(judged(chat), "deny", "so is a schedule that would send its result there");
  assert.equal(judged({ channel: "hand", chatId: "friend-2" }), "allow", "a schedule that sends to another chat is not");
});

test("in a conversation on Auto, which asks before a message is sent, a schedule that sends to a chat asks too", async (t) => {
  const { app } = await harness(t, {});
  const run = app.store.createRun(app.runtime.owner, "a conversation on Auto");
  app.store.event(run.id, "run.started", { source: "owner" });
  saveConversationMode(app.store, app.runtime.owner, run.sessionId, { mode: "auto" });
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "ask",
    "the control: a message sent now asks");
  assert.equal(app.runtime.checkPolicy("schedules.create", timed, context).decision, "ask", "so does one put on a timer");
  assert.equal(app.runtime.checkPolicy("schedules.create", plain, context).decision, "allow", "a schedule that sends nowhere goes ahead, as before");
});

test("Message people set to ask with Change settings allowed: a schedule that sends to a chat waits for a yes, one that sends nowhere goes ahead", async (t) => {
  const { app, task, schedules, status } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("schedules.create", timed);
  assert.equal(status(run), "needs_input", "the owner is asked before a message is put on a timer");
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(asked?.tool, "schedules.create", "the question is the schedule's own");
  assert.deepEqual(schedules(), [], "nothing is saved while the question waits");

  const quiet = await task("schedules.create", plain);
  assert.equal(status(quiet), "completed");
  assert.equal(schedules().length, 1, "a schedule that sends nowhere only changes a setting, and goes ahead");
  assert.equal(schedules()[0].data.deliverTo, undefined);
});

test("Message people set to refuse: a schedule that sends to a chat is refused, even where Change settings would only ask", async (t) => {
  const { app, task, schedules } = await harness(t, { message: "deny", settings: "ask" });
  const run = await task("schedules.create", timed);
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "policy.denied").length, 1, "refused, not asked");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId), undefined, "no question waits");
  assert.deepEqual(schedules(), [], "nothing is saved");
});

test("a yes to a schedule that sends to a chat stays that schedule's: it never lets a later message to the chat through", async (t) => {
  const { app, task, schedules, status } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("schedules.create", timed);
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(asked?.tool, "schedules.create");
  const before = readPolicy(app.store, app.runtime.owner).rules;
  // A schedule names no one target a standing yes could be kept for, so "Always" is refused, and
  // nothing is written: least of all a rule for sending messages.
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint), /does not say/);
  assert.deepEqual(readPolicy(app.store, app.runtime.owner).rules, before, "no rule was written");

  app.runtime.approve(run.sessionId, "allow", "session", asked.fingerprint);
  const again = await task("schedules.create", timed, run.sessionId);
  assert.equal(status(again), "completed", "the yes covers the very schedule it was given for");
  assert.equal(schedules().length, 1);
  assert.deepEqual(schedules()[0].data.deliverTo, chat);

  const message = await task("channels.broadcast", { text: "hello", to: [chat] }, run.sessionId);
  assert.equal(status(message), "needs_input", "a message to the same chat now is still asked about");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "channels.broadcast");
});

test("another AI tool's dry run of a schedule that sends to a chat says what the call itself would meet", async (t) => {
  const { app, workspace } = await harness(t, { message: "deny", settings: "allow" });
  const plan = (args) => dryRunPlan(app.registry, app.store, app.runtime.owner, workspace, { name: "schedules.create", arguments: args });
  const called = (args) => app.runtime.checkPolicy("schedules.create", args, app.runtime.context({ source: "mcp" })).decision;
  assert.equal(called(timed), "deny", "the call itself is refused");
  assert.equal(plan(timed).decision, "deny", "and the dry run says so");
  assert.equal(called(plain), "ask", "a change another AI tool asks for still waits for a yes");
  assert.equal(plan(plain).decision, "ask");
});

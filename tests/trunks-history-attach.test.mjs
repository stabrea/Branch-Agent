/**
 * Bringing another conversation in as context (history.attach) keeps the wall a Trunk already has
 * when it looks back through history: from a Trunk's turn it reaches only the conversations that
 * Trunk answered in (such as its own earlier chat, or a conversation handed to it), never another
 * Trunk's chat and never the owner's own conversations. A delegated specialist has none to bring in.
 * Words are looked for only among the conversations the Trunk may read, so what the owner's other
 * conversations say never changes which one it gets, or whether it is asked to choose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

/** Rules keyed on the whole user message; `args` is read when the rule fires, so a test can fill it in later. */
function rules(table) {
  return [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "").trim();
    const entry = table[text];
    return entry ? call(entry.tool, typeof entry.args === "function" ? entry.args() : entry.args) : null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
}

async function twoTrunks(t, table) {
  const { app } = await fixture(t, rules(table));
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  return { app, ada, bo };
}

/** A finished conversation of the owner's own, with these lines in it; its id. */
function ownersConversation(app, ...lines) {
  const run = app.store.createRun(app.runtime.owner, lines[0]);
  lines.forEach((content, index) => app.store.message(run.sessionId, { role: index % 2 ? "assistant" : "user", content }));
  app.store.finish(run.id, "completed", "done");
  return run.sessionId;
}

const topics = (app, runId) => app.store.events(runId).filter((e) => e.kind === "context.topic");

test("a Trunk brings in a conversation it answered in, never another Trunk's or the owner's own", async (t) => {
  let wanted;
  const { app, ada, bo } = await twoTrunks(t, { "bring it in": { tool: "history.attach", args: () => ({ conversation: wanted }) } });
  const owners = ownersConversation(app, "Owner only: the tallowmere account number is 4471, keep it between us", "Noted.");
  await app.trunks.say(bo.id, "Bo only: tallowmere is the supplier I am vetting, marrowfen the backup");
  await app.trunks.say(ada.id, "Ada here: tallowmere goes in the launch plan");
  const adaEarlier = ada.chatSessionId;
  // Ada carries on in a fresh chat; the earlier one is still hers to look back on.
  const adaNow = app.trunks.retireChat(ada.id).chatSessionId;
  assert.notEqual(adaNow, adaEarlier);
  const bos = bo.chatSessionId;

  const attempt = async (conversation) => {
    wanted = conversation;
    const run = await app.trunks.say(ada.id, "bring it in");
    return { runId: run.runId, outcome: toolOutcome(app, run.runId, "history.attach"), said: JSON.stringify(app.store.events(run.runId)) };
  };
  const refusals = [
    { what: "Bo's conversation by its id", conversation: bos, refusal: /no conversation of yours/, unseen: [/supplier I am vetting/, /marrowfen/] },
    { what: "the owner's own conversation by its id", conversation: owners, refusal: /no conversation of yours/, unseen: [/4471/, /between us/] },
    { what: "Bo's conversation by its words", conversation: "marrowfen", refusal: /No other conversation mentions/, unseen: [/supplier I am vetting/, new RegExp(bos)] },
    { what: "the owner's own conversation by its words", conversation: "account number", refusal: /No other conversation mentions/, unseen: [/4471/, /between us/, new RegExp(owners)] },
  ];
  for (const { what, conversation, refusal, unseen } of refusals) {
    const { runId, outcome, said } = await attempt(conversation);
    assert.equal(outcome.ok, false, `${what} reached Ada`);
    assert.match(outcome.error, refusal, what);
    assert.equal(topics(app, runId).length, 0, `nothing is recorded as read for ${what}`);
    for (const words of unseen) assert.doesNotMatch(said, words, `${what}: nothing of it reaches Ada's task`);
  }

  // Not a vacuous pass: her own earlier chat comes in, by its id and by its words.
  const byId = await attempt(adaEarlier);
  assert.equal(byId.outcome.ok, true, byId.outcome.error);
  assert.equal(byId.outcome.result.conversation.id, adaEarlier);
  assert.match(JSON.stringify(byId.outcome.result.messages), /launch plan/);
  assert.deepEqual(topics(app, byId.runId).map((e) => e.data.sessionId), [adaEarlier], "the task says which conversation it read");

  // All three mention tallowmere; only one of them is Ada's to read, so there is nothing to choose between.
  const byWords = await attempt("tallowmere");
  assert.equal(byWords.outcome.ok, true, byWords.outcome.error);
  assert.equal(byWords.outcome.result.conversation.id, adaEarlier);
  assert.deepEqual(topics(app, byWords.runId).map((e) => e.data.sessionId), [adaEarlier]);
  for (const words of [new RegExp(bos), new RegExp(owners), /supplier I am vetting/, /4471/])
    assert.doesNotMatch(byWords.said, words, "no other conversation is named or quoted");

  // The owner's own task still reaches every one of them.
  const task = app.store.createRun(app.runtime.owner, "anything");
  const mine = await app.registry.execute("history.attach", { conversation: bos }, app.runtime.context({ runId: task.id }));
  assert.equal(mine.conversation.id, bos);
});

test("a Trunk's own conversation is found by its words however many of the owner's mention them too", async (t) => {
  const { app, ada } = await twoTrunks(t, { "bring it in": { tool: "history.attach", args: { conversation: "quillmoor" } } });
  await app.trunks.say(ada.id, "Ada here: the quillmoor draft is in my notes");
  const adaEarlier = ada.chatSessionId;
  app.trunks.retireChat(ada.id);
  // More of the owner's conversations mention it, all newer than Ada's, than one page of matches holds.
  for (let index = 0; index < 25; index += 1) ownersConversation(app, `Owner's quillmoor note ${index}`, "Noted.");

  const run = await app.trunks.say(ada.id, "bring it in");
  const outcome = toolOutcome(app, run.runId, "history.attach");
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result.conversation.id, adaEarlier);
  assert.doesNotMatch(JSON.stringify(app.store.events(run.runId)), /Owner's quillmoor note/, "none of the owner's is named or quoted");
});

test("a delegated specialist has no conversation to bring in", async (t) => {
  const { app } = await twoTrunks(t, {});
  const owners = ownersConversation(app, "The owner's plan for the quillmoor launch", "Noted.");
  const task = app.store.createRun(app.runtime.owner, "anything");
  const specialist = { ...app.runtime.context({ runId: task.id }), agent: "researcher" };
  await assert.rejects(app.registry.execute("history.attach", { conversation: owners }, specialist), /no conversation of yours/);
  await assert.rejects(app.registry.execute("history.attach", { conversation: "quillmoor" }, specialist), /No other conversation mentions/);
  assert.equal(topics(app, task.id).length, 0, "nothing is recorded as read");
  // Not a vacuous pass: the owner's own task brings it in.
  const mine = await app.registry.execute("history.attach", { conversation: "quillmoor" }, app.runtime.context({ runId: task.id }));
  assert.equal(mine.conversation.id, owners);
});

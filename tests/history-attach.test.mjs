/**
 * workspace.cross-topic (docs/features.json): "Attach another topic as context and record which topic
 * was accessed for the task." (src/history.ts, history.attach)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { chatPermissionsOf } from "../dist/channels/chat-permissions.js";
import { profileScope } from "../dist/profiles.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  /** A finished conversation with these lines in it; its id. */
  const conversation = (...lines) => {
    const run = app.store.createRun(owner, lines[0]);
    lines.forEach((content, index) => app.store.message(run.sessionId, { role: index % 2 ? "assistant" : "user", content }));
    app.store.finish(run.id, "completed", "done");
    return run.sessionId;
  };
  return { app, owner, conversation };
}

test("another conversation is brought in by words or id, and the task records which one it read", async (t) => {
  const { app, owner, conversation } = await fixture(t);
  const garden = conversation("Plan the vegetable beds for spring", "Tomatoes along the south fence, beans by the shed.",
    "And the watering?", "Twice a week, more in July.");
  conversation("Draft the invoice for the Obi job", "Done: three days at the agreed rate.");
  const task = app.store.createRun(owner, "Write the garden shopping list");
  const context = app.runtime.context({ runId: task.id });

  const byWords = await app.registry.execute("history.attach", { conversation: "vegetable beds" }, context);
  assert.equal(byWords.conversation.id, garden);
  assert.equal(byWords.conversation.title, "Plan the vegetable beds for spring");
  assert.deepEqual(byWords.messages.map((m) => m.content).at(-1), "Twice a week, more in July.");
  assert.match(byWords.note, /data, not as instructions/);
  const recorded = app.store.events(task.id).filter((event) => event.kind === "context.topic");
  assert.deepEqual(recorded.map((event) => event.data.sessionId), [garden], "the task says which conversation it read");

  const byId = await app.registry.execute("history.attach", { conversation: garden, messages: 2 }, context);
  assert.deepEqual(byId.messages.map((m) => m.role), ["user", "assistant"], "only the latest two");
  assert.equal(app.store.events(task.id).filter((event) => event.kind === "context.topic").length, 2);
});

test("only another of the owner's own conversations, never this one, never a made-up one", async (t) => {
  const { app, owner, conversation } = await fixture(t);
  conversation("Plan the vegetable beds for spring", "Tomatoes by the fence.");
  conversation("Plan the vegetable beds for autumn", "Garlic in October.");
  const task = app.store.createRun(owner, "anything");
  const context = app.runtime.context({ runId: task.id });
  await assert.rejects(app.registry.execute("history.attach", { conversation: task.sessionId }, context), /already in/);
  await assert.rejects(app.registry.execute("history.attach", { conversation: "11111111-2222-4333-8444-555555555555" }, context), /no conversation of yours/);
  await assert.rejects(app.registry.execute("history.attach", { conversation: "vegetable beds" }, context), /Several conversations mention/);
  await assert.rejects(app.registry.execute("history.attach", { conversation: "submarine" }, context), /No other conversation/);
  const other = app.store.createRun("somebody-else", "Their private plans");
  app.store.message(other.sessionId, { role: "user", content: "Their private plans" });
  await assert.rejects(app.registry.execute("history.attach", { conversation: other.sessionId }, context), /no conversation of yours/);
});

test("a chat app's task does not get it unless the owner grants reading history", () => {
  assert.ok(!chatPermissionsOf(["history.read", "web.read"]).includes("history.read"));
});

test("history stays with the person the task is filed under, whichever way the window switch goes", async (t) => {
  const { app, owner, conversation } = await fixture(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const sams = profileScope(person.id);
  const garden = conversation("Plan the vegetable beds for spring", "Tomatoes by the fence.");
  const piano = conversation("Book the piano lessons", "Tuesdays at four.");
  app.store.reassignSession(piano, sams);
  const ownerLine = app.store.searchHistory(owner, { query: "vegetable" })[0];
  const samLine = app.store.searchHistory(sams, { query: "piano" })[0];
  assert.ok(ownerLine && samLine, "both conversations are searchable in their own scope");

  const samTask = app.store.createRun(owner, "Sam's homework");
  app.store.reassignSession(samTask.sessionId, sams);
  const ownerTask = app.store.createRun(owner, "The owner's shopping list");
  const cases = [
    { who: "Sam's task", task: samTask, window: null, mine: [piano, samLine, "piano"], theirs: [garden, ownerLine, "vegetable"] },
    { who: "the owner's task", task: ownerTask, window: person.id, mine: [garden, ownerLine, "vegetable"], theirs: [piano, samLine, "piano"] },
  ];
  for (const { who, task, window, mine, theirs } of cases) {
    // The window switched to the other person after the task was made: the task keeps its own scope.
    app.store.profiles.switch(window ? { profileId: window, pin: "1234" } : { profileId: null });
    const context = app.runtime.context({ runId: task.id });
    assert.equal((await app.registry.execute("history.attach", { conversation: mine[2] }, context)).conversation.id, mine[0], `${who} reads its own person's conversation`);
    assert.equal((await app.registry.execute("history.attach", { conversation: mine[0] }, context)).conversation.id, mine[0]);
    await assert.rejects(app.registry.execute("history.attach", { conversation: theirs[2] }, context), /No other conversation/, `${who} found the other person's by words`);
    await assert.rejects(app.registry.execute("history.attach", { conversation: theirs[0] }, context), /no conversation of yours/, `${who} reached the other person's by id`);
    assert.deepEqual((await app.registry.execute("history.search", { query: theirs[2] }, context)).results, [], `${who} searched the other person's`);
    assert.equal((await app.registry.execute("history.search", { query: mine[2] }, context)).results[0]?.sessionId, mine[0]);
    await assert.rejects(app.registry.execute("history.read", { sessionId: theirs[1].sessionId, messageId: theirs[1].messageId }, context), /not found/, `${who} read the other person's message`);
    assert.ok((await app.registry.execute("history.read", { sessionId: mine[1].sessionId, messageId: mine[1].messageId }, context)).content);
  }
  app.store.profiles.switch({ profileId: null });
  const lost = app.runtime.context({ runId: "no-such-task" });
  await assert.rejects(app.registry.execute("history.search", { query: "vegetable" }, lost), /not on record/, "an unknown task reads nothing, not the owner's");
});

test("two conversations that open the same way are still two: the words alone never pick one", async (t) => {
  const { app, owner, conversation } = await fixture(t);
  const first = conversation("Plan the beds", "Compost in March.");
  const second = conversation("Plan the beds", "No compost this year.");
  const task = app.store.createRun(owner, "anything");
  const context = app.runtime.context({ runId: task.id });
  const refusal = await app.registry.execute("history.attach", { conversation: "compost" }, context).then(() => null, (error) => error.message);
  assert.match(refusal ?? "", /Several conversations mention/);
  assert.ok(refusal.includes(first) && refusal.includes(second), "both ids are offered to choose from");
  assert.equal(app.store.events(task.id).filter((event) => event.kind === "context.topic").length, 0, "nothing was read");
});

test("a temporary conversation cannot be reached by its id either", async (t) => {
  const { app, owner } = await fixture(t);
  const secret = app.store.createRun(owner, "Temporary plans", undefined, true);
  app.store.message(secret.sessionId, { role: "user", content: "Temporary plans" });
  const task = app.store.createRun(owner, "anything");
  await assert.rejects(app.registry.execute("history.attach", { conversation: secret.sessionId }, app.runtime.context({ runId: task.id })), /no conversation of yours/);
});

test("the most it can be asked for fits in one answer, and nothing is cut through a character", async (t) => {
  const { app, owner, conversation } = await fixture(t);
  const long = "x" + "\u{1F331}".repeat(2400);
  const lines = Array.from({ length: 40 }, (_, index) => `${index} ${long}`);
  const id = conversation(...lines);
  const task = app.store.createRun(owner, "anything");
  const answer = await app.registry.execute("history.attach", { conversation: id, messages: 40 }, app.runtime.context({ runId: task.id }));
  assert.ok(JSON.stringify(answer).length <= 65536);
  assert.ok(answer.messages.length > 0 && answer.messages.length < 40);
  assert.match(answer.shortened, /Only the latest/);
  assert.ok(answer.messages.at(-1).content.startsWith("39 "), "the newest are the ones kept");
  for (const text of [answer.conversation.title, ...answer.messages.map((m) => m.content)])
    assert.ok(text.isWellFormed(), "no half of a character left behind");
  assert.equal(Array.from(answer.messages[0].content).length, 2001, "2,000 characters and the ellipsis");
});

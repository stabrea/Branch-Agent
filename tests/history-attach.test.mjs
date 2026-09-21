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

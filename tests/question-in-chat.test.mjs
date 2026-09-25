/**
 * Dogfood B21: when Branch asked the owner something with user.ask ("Which setting do you mean?"), the question
 * showed only in the banner at the top of the conversation; the chat itself ended at "Used user ask". The question
 * is now the assistant's message in the conversation, once, where the owner reads and answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function scripted(t, replies) {
  const root = await mkdtemp(join(tmpdir(), "branch-question-chat-"));
  let n = 0;
  const provider = { name: "scripted", async complete() { return replies[Math.min(n++, replies.length - 1)]; } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "w"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const said = (app, sessionId) => app.store.messages(sessionId).filter((message) => message.role === "assistant").map((message) => message.content);

test("a question Branch asks is its message in the conversation, once", async (t) => {
  const question = "Which setting do you mean: the update channel or updating by itself?";
  const app = await scripted(t, [{ content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question }) }] }]);
  const run = await app.runtime.run({ prompt: "turn on automatic updates" });
  assert.equal(run.status, "needs_input");
  const words = said(app, run.sessionId);
  assert.equal(words.filter((text) => text === question).length, 1, "the question is in the conversation once");
  assert.equal(words.at(-1), question, "and it is the last thing Branch said");
});

test("a task that stops for another reason adds no message of its own", async (t) => {
  const app = await scripted(t, [{ content: "All done.", toolCalls: [] }]);
  const run = await app.runtime.run({ prompt: "say done" });
  assert.equal(run.status, "completed");
  assert.deepEqual(said(app, run.sessionId), ["All done."]);
});

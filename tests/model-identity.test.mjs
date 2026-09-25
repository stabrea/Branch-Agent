/**
 * Dogfood B18: asked "which model are you?" on GPT-6 Sol, the model said it had no reliable view of its name. Each
 * attempt now tells the model which model and connection are answering; a fallback is told its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { withModelIdentity } from "../dist/runtime.js";

test("the first system message ends with the model and connection answering, and nothing else changes", () => {
  const messages = [{ role: "system", content: "Be useful." }, { role: "user", content: "which model are you?" }];
  const told = withModelIdentity(messages, { name: "ChatGPT (unofficial) · GPT-6 Sol", model: "gpt-6-sol" });
  assert.equal(told[0].content,
    "Be useful.\n\nThe model answering now is gpt-6-sol, through the connection \"ChatGPT (unofficial) · GPT-6 Sol\". If asked which model you are, say so.");
  assert.deepEqual(told[1], messages[1]);
  assert.equal(messages[0].content, "Be useful.", "the conversation's own messages are not changed");
  assert.match(withModelIdentity(messages, { name: "Default connection", model: "configured" })[0].content,
    /The connection answering now is "Default connection"\. If asked/, "a placeholder is never given as the model's name");
  const noSystem = [{ role: "user", content: "hi" }];
  assert.equal(withModelIdentity(noSystem, { name: "X", model: "x" }), noSystem);
});

test("a task tells the model its name, and a fallback is told its own", async (t) => {
  const seen = [];
  const said = (who) => (request) => seen.push([who, request.messages[0].content.split("\n\n").at(-1)]);
  const main = { name: "main-provider", async complete(request) { said("main")(request); throw new ProviderHttpError(503); } };
  const backup = { name: "backup-provider", async complete(request) { said("backup")(request); return { content: "I am model b.", toolCalls: [] }; } };
  const root = await mkdtemp(join(tmpdir(), "branch-model-identity-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "main", name: "Main", provider: main, model: "gpt-6-sol" }, { id: "backup", name: "Backup", provider: backup, model: "gpt-6-luna" }],
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.models.configure("local", { fallbackOrder: ["backup"] });
  const run = await app.runtime.run({ prompt: "which model are you?" });
  assert.equal(run.status, "completed");
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "model.fallback").length, 1, "the task really fell back");
  assert.deepEqual(seen, [
    ["main", "The model answering now is gpt-6-sol, through the connection \"Main\". If asked which model you are, say so."],
    ["backup", "The model answering now is gpt-6-luna, through the connection \"Backup\". If asked which model you are, say so."],
  ]);
});

// NAS cc72768: a mixture's model is its priciest member's price name, an installed program's is its command, and the
// Codex app-server's is what it is, so none is given as the model's name. An isolated grader gets no line at all.
test("connections whose model is not the one writing name only the connection", () => {
  const messages = [{ role: "system", content: "Be useful." }];
  for (const [provider, model] of [["mixture", "gpt-4o"], ["cli-agent:claude", "claude"], ["app-server:codex", "codex app-server"], ["retired:old", "old-1"]])
    assert.equal(withModelIdentity(messages, { name: "Mine", model, provider: { name: provider } })[0].content,
      "Be useful.\n\nThe connection answering now is \"Mine\". If asked which model you are, say so.", `${provider} names no model`);
  assert.match(withModelIdentity(messages, { name: "Mine", model: "gpt-6-sol", provider: { name: "chatgpt" } })[0].content, /model answering now is gpt-6-sol/);
});

test("an isolated grader is given its instructions and nothing else", async (t) => {
  const firsts = [];
  const provider = { name: "scripted", async complete(request) { firsts.push(request.messages[0].content); return { content: "PASS", toolCalls: [] }; } };
  const root = await mkdtemp(join(tmpdir(), "branch-model-identity-grader-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "main", name: "Main", provider, model: "gpt-6-sol" }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt: "Grade this answer.", isolated: true });
  assert.ok(firsts.length >= 1, "control: the grader was asked");
  assert.ok(firsts.every((content) => !/answering now/.test(content)), "no model line in a grader's instructions");
  await app.runtime.run({ prompt: "which model are you?" });
  assert.match(firsts.at(-1), /model answering now is gpt-6-sol/, "control: an ordinary task still gets it");
});

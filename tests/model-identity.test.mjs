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

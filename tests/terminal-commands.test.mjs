import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { startTerminal } from "../dist/terminal.js";

function scripted(name) {
  const provider = { name, requests: [], async complete(request) { provider.requests.push(request); return { content: `${name} answered`, toolCalls: [] }; } };
  return provider;
}
async function until(check) {
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(10); }
  assert.fail("Timed out waiting for terminal output");
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-term-cmd-"));
  const alpha = scripted("alpha"), beta = scripted("beta");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "alpha", name: "Alpha", provider: alpha, model: "alpha-1" },
    { id: "beta", name: "Beta", provider: beta, model: "beta-9", reasoning: "medium" },
  ] });
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const done = startTerminal(app.runtime, { input, output, signals, terminal: false, pollIntervalMs: 5 });
  t.after(async () => {
    if (!input.writableEnded) { input.write("/exit\n"); input.end(); }
    await done; await app.close(); await rm(root, { recursive: true, force: true });
  });
  return { app, alpha, beta, input, text: () => text };
}

test("/models, /model and /think choose the model and thinking for the terminal conversation", async (t) => {
  const { app, alpha, beta, input, text } = await fixture(t);
  input.write("/models\n");
  await until(() => /\* alpha — Alpha · alpha-1/.test(text()) && /  beta — Beta · beta-9/.test(text()));
  input.write("/model nope\n");
  await until(() => /No model called nope/.test(text()));
  input.write("/model beta\n");
  await until(() => /model set to Beta/.test(text()));
  input.write("/think high\n");
  await until(() => /thinking set to high/.test(text()));
  input.write("hello there\n");
  await until(() => /beta answered/.test(text()));
  assert.equal(alpha.requests.length, 0);
  assert.equal(beta.requests.length, 1);
  assert.equal(beta.requests[0].reasoning, "high");
  const sessionId = app.store.runs("local")[0].sessionId;
  assert.deepEqual(app.runtime.models.session("local", sessionId), { preset: "beta", reasoning: "high" }, "the web view sees the same choice");
  assert.equal(app.runtime.models.settings("local").activePreset, null, "the workspace default is untouched");
  input.write("/think default\n");
  await until(() => /thinking set to the model's default/.test(text()));
  input.write("again please\n");
  await until(() => beta.requests.length === 2);
  assert.equal(beta.requests[1].reasoning, undefined, "null asks for the model's own default");
  input.write("/help\n");
  await until(() => /Commands: \/models, \/model <id>, \/think/.test(text()));
});

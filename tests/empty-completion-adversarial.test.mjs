import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";
import { OpenAIProvider } from "../dist/providers.js";
import { OllamaProvider } from "../dist/providers/ollama.js";
import { producedNothing } from "../dist/empty-answer.js";
import * as reliability from "../dist/reliability.js";

/**
 * integrate/empty-completion: the adversarial pass over mac7/empty-completion. The adapters now
 * read a reasoning model's thinking, and thinking resets the stall watchdog. These hold the four
 * things that change could have broken: the thinking must never be kept anywhere, it must be paid
 * for, it must not keep a stuck connection alive for ever, and a provider that sends its thinking
 * in some other shape must behave exactly as it did before.
 */

const secret = "PRIVATE-THOUGHT-7f3a9c";
const sse = (data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\r\n\r\n`;
const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, provider, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-thinking-attack-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), provider, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
async function everyFile(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name));
  return out;
}

test("the thinking that is now read is never kept: not the page, the record, the conversation or the disk", async (t) => {
  const endpoint = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "text/event-stream");
    for (const frame of [
      sse(chunk({ reasoning_content: `${secret} step one. ` })),
      sse(chunk({ reasoning: `${secret} step two.` })),
      sse(chunk({ content: "The answer is 4." }, "stop")),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 30 } }),
      sse("[DONE]"),
    ]) { res.write(frame); await delay(1); }
    res.end();
  });
  const { app, root } = await fixture(t, new OpenAIProvider({ endpoint: `${endpoint}/v1`, model: "qwen3", apiKey: "k" }));
  for (const showReasoning of [true, false]) {
    saveKnobs(app.store, "local", "reasoning", { showReasoning });
    const page = [];
    const run = await app.runtime.run({ prompt: "what is 2+2", onTextDelta: (text) => page.push(text) });
    assert.equal(run.status, "completed");
    assert.equal(run.output, "The answer is 4.");
    assert.ok(!page.join("").includes(secret), "never streamed to the page");
    assert.ok(!JSON.stringify(app.store.events(run.id)).includes(secret), "never in the audit record");
    assert.ok(!JSON.stringify(app.store.messages(run.sessionId)).includes(secret), "never in the saved conversation");
    assert.ok(app.store.events(run.id).some((e) => e.kind === "model.completed" && e.data.reasoningChars > 0), "only counted");
  }
  await app.close();
  for (const file of await everyFile(root))
    assert.ok(!(await readFile(file)).includes(secret), `never written to disk (${file})`);
});

test("a non-streamed reply — side questions, debate turns, the judge — carries only a count of the thinking", async (t) => {
  const endpoint = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "Yes.", reasoning_content: secret } }] }));
  });
  const completion = await new OpenAIProvider({ endpoint: `${endpoint}/v1`, model: "m", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 50, signal: new AbortController().signal,
  });
  assert.equal(completion.content, "Yes.");
  assert.ok(!JSON.stringify(completion).includes(secret));
});

test("thinking is charged when the provider reports no usage, so a task budget still means something", async (t) => {
  const thinker = { name: "thinker", async complete() {
    return { content: "done", toolCalls: [], reasoningChars: 40000 };
  } };
  const { app } = await fixture(t, thinker);
  const run = await app.runtime.run({ prompt: "think" });
  assert.equal(run.status, "completed");
  assert.ok(app.store.usage(run.id).estimatedOutput >= 10000, "forty thousand characters of thinking are not free");
});

test("thinking counts against the task's token cap", async (t) => {
  let rounds = 0;
  const thinker = { name: "thinker", async complete() {
    rounds++;
    return { content: "", reasoningChars: 40000,
      toolCalls: [{ id: `c${rounds}`, name: "files.list", arguments: JSON.stringify({ path: "." }) }] };
  } };
  const { app } = await fixture(t, thinker);
  const run = await app.runtime.run({ prompt: "keep going", budget: { maxSteps: 50, maxTokens: 30000 } });
  assert.notEqual(run.status, "completed");
  assert.ok(rounds <= 3, `the cap stopped it after ${rounds} rounds of 10,000 thinking tokens, not 50`);
});

test("a stream that fails part way through its thinking is still charged for it", async (t) => {
  const endpoint = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "text/event-stream");
    res.write(sse(chunk({ reasoning_content: "x".repeat(8000) })));
    await delay(5);
    res.destroy();
  });
  const error = await new OpenAIProvider({ endpoint: `${endpoint}/v1`, model: "m", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 4000,
    signal: new AbortController().signal, onTextDelta: () => undefined,
  }).then(() => null, (e) => e);
  assert.ok(error, "the broken stream is an error");
  assert.ok(error.estimatedOutput >= 2000, `charged ${error.estimatedOutput} for 8,000 characters of thinking`);

  const ollama = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "", thinking: "y".repeat(8000) } }) + "\n");
    await delay(5);
    res.destroy();
  });
  const broken = await new OllamaProvider({ endpoint: ollama, model: "qwen3" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 4000,
    signal: new AbortController().signal, onTextDelta: () => undefined,
  }).then(() => null, (e) => e);
  assert.ok(broken, "the broken stream is an error");
  assert.ok(broken.estimatedOutput >= 2000, `charged ${broken.estimatedOutput} for 8,000 characters of thinking`);
});

test("a connection that sends thinking for ever with no end is still caught as stalled", { timeout: 15000 }, async (t) => {
  let calls = 0;
  const forever = { name: "forever", async complete(request) {
    calls++;
    for (;;) { await delay(10, undefined, { signal: request.signal }); request.onReasoningDelta?.("."); }
  } };
  const { app } = await fixture(t, forever, { reliability: { modelStallMs: 5000, stallRecovery: "fail" } });
  app.runtime.reliability.modelStallMs = 40;
  const started = Date.now();
  const run = await app.runtime.run({ prompt: "think", onTextDelta: () => undefined });
  assert.notEqual(run.status, "completed");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "model.stalled"), "the watchdog, not the run deadline, ended it");
  assert.ok(Date.now() - started < 10000);
  assert.equal(calls, 1);
});

test("thinking keeps a call alive only within the room the reply was given", () => {
  let touched = 0, now = 0;
  const pulse = reliability.thinkingKeepsAlive(() => touched++, { maxChars: 10, forMs: 100, now: () => now });
  pulse("12345"); pulse("12345");
  assert.equal(touched, 2);
  pulse("1");
  assert.equal(touched, 2, "more thinking than the reply could hold is not a sign of life");
  let later = 0, clock = 0;
  const slow = reliability.thinkingKeepsAlive(() => later++, { maxChars: 1e9, forMs: 100, now: () => clock });
  slow("."); clock = 99; slow("."); clock = 100; slow(".");
  assert.equal(later, 2, "a slow drip of thinking cannot hold the call open past its window");
});

test("a provider that sends its thinking in another shape behaves exactly as before", async (t) => {
  const endpoint = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "text/event-stream");
    for (const frame of [
      sse(chunk({ reasoning: { summary: "an object, not text" }, reasoning_content: null })),
      sse(chunk({ content: "hi" }, "stop")),
      sse("[DONE]"),
    ]) { res.write(frame); await delay(1); }
    res.end();
  });
  const completion = await new OpenAIProvider({ endpoint: `${endpoint}/v1`, model: "m", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 50,
    signal: new AbortController().signal, onTextDelta: () => undefined,
  });
  assert.equal(completion.content, "hi");
  assert.equal(completion.reasoningChars, undefined);

  const plain = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: "stop",
      message: { role: "assistant", content: "ok", reasoning: [{ type: "summary" }] } }] }));
  });
  const reply = await new OpenAIProvider({ endpoint: `${plain}/v1`, model: "m", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 50, signal: new AbortController().signal,
  });
  assert.deepEqual(reply, { content: "ok", toolCalls: [] });
});

test("the empty-answer sentence is true: it names no setting that does not exist and does not deny a change", () => {
  const thought = producedNothing("completed", "", { toolCalls: 0, reasoningChars: 900, model: "qwen3:4b" });
  assert.doesNotMatch(thought, /reply limit/i, "there is no reply limit for the owner to raise");
  const acted = producedNothing("completed", "", { toolCalls: 2, reasoningChars: 0, model: null });
  assert.doesNotMatch(acted, /nothing to show/i, "a task that used tools may have changed something");
  assert.match(acted, /activity/i);
  assert.equal(producedNothing("completed", "ok", { toolCalls: 0, reasoningChars: 0, model: null }), null, "short is not empty");
});

test("an audited operation that returns nothing is not refused as an empty answer", async (t) => {
  const { app } = await fixture(t, { name: "x", async complete() { return { content: "ok", toolCalls: [] }; } });
  const value = await app.runtime.auditOperation(app.runtime.context(), "Nothing to return", async () => undefined);
  assert.equal(value, undefined);
});

test("a reply cut off while still thinking says so, rather than blaming the provider", async (t) => {
  // 0.18.1 keeps the 2,048-token reply ceiling, so a local reasoning model can still run out of room
  // mid-thought (one recorded reply was 2,409 tokens). That ends as a failure either way; this holds
  // that the sentence names the real cause and that the thinking is still charged.
  const endpoint = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "text/event-stream");
    for (const frame of [
      sse(chunk({ reasoning_content: "z".repeat(4000) })),
      sse(chunk({ content: "" }, "length")),
      sse("[DONE]"),
    ]) { res.write(frame); await delay(1); }
    res.end();
  });
  const error = await new OpenAIProvider({ endpoint: `${endpoint}/v1`, model: "m", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 1000,
    signal: new AbortController().signal, onTextDelta: () => undefined,
  }).then(() => null, (e) => e);
  assert.ok(error);
  assert.doesNotMatch(error.message, /Provider stream ended/);
  assert.match(error.message, /thinking/i);
  assert.ok(error.estimatedOutput >= 1000);
});

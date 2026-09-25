/**
 * Each model gets the context window it really has: the most one request to it may hold. The figure
 * comes from a named source (the room a model on this computer was loaded with, or a window the
 * service itself reported), the owner's own figure comes first, and a model Branch knows nothing
 * about keeps 20,000. Folding a long conversation still comes before a request outgrows the window,
 * or what the task can still spend. Scripted models only: nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveKnobs } from "../dist/index.js";
import { tokenReport } from "../dist/commands/tokens.js";
import { knobsApi } from "../dist/knobs/api.js";
import { restoreLocalConnections } from "../dist/local-connections.js";
import { ProviderHttpError } from "../dist/provider-retry.js";

const tooLong = /grown too long to continue/;
const summaryAsk = /Summarize the conversation below/;

/** A scripted model. A fold's summary and the questions asked with no tools are answered apart. */
function scripted(name, reply = () => ({ content: "Done.", toolCalls: [] })) {
  const provider = {
    name, main: [], side: [],
    async complete(request) {
      if (summaryAsk.test(request.messages[0]?.content ?? "")) {
        provider.side.push(request);
        return { content: JSON.stringify({ goals: ["carry on"], decisions: [], openQuestions: [], filesTouched: [] }), toolCalls: [] };
      }
      if (!request.tools?.length) { provider.side.push(request); return { content: "{\"memories\":[],\"skills\":[]}", toolCalls: [] }; }
      provider.main.push(request);
      return reply(request, provider.main.length);
    },
  };
  return provider;
}
/** The ChatGPT plan route, GPT-5.6 Sol: a model whose window the service reported. */
const planSol = (provider) => ({ id: "chatgpt-gpt-5.6-sol", name: "ChatGPT (unofficial) · GPT-5.6 Sol (light)", model: "gpt-5.6-sol", provider });
const unknown = (provider, id = "default") => ({ id, name: "Default connection", model: "configured", provider });

async function fixture(t, presets, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-context-window-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
/** A model on this computer, rebuilt from its written-down connection the way Branch does at start. */
function localConnection(app, provider, contextLength) {
  const id = "local-ollama-qwen3-8b";
  app.store.save("settings", app.runtime.owner, "local-model-connections", { connections: [
    { id, name: "Qwen3 8B (runs on this computer)", runtime: "ollama", model: "qwen3:8b-q4_K_M-ctx", contextLength },
  ] });
  restoreLocalConnections({ models: app.runtime.models, store: app.store, owner: app.runtime.owner, policy: null,
    fetch: async () => { throw new Error("nothing is reached in tests"); }, endpoint: () => null });
  // The same connection, answered by the scripted model instead of a runtime.
  app.runtime.models.register({ ...app.runtime.models.presets.get(id), provider });
  app.runtime.models.configure(app.runtime.owner, { activePreset: id });
  return id;
}
const events = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind).map((event) => event.data);
const limits = (app, run) => events(app, run, "context.budget").map((budget) => budget.limit);
const knobsView = (app) => knobsApi(app, { method: "GET" }, "/api/knobs", async () => ({}), () => null);
/** About `tokens` estimated tokens of plain words. */
const words = (tokens) => "several plain words about the garden shed plans ".repeat(Math.ceil((tokens * 4) / 49));
const tools = { permissions: ["files.read"] };
/** A conversation whose one earlier message holds about `tokens` tokens: too few messages for a fold to take any. */
function oneLongMessage(app, tokens) {
  const sessionId = app.store.createSession(app.runtime.owner);
  app.store.message(sessionId, { role: "user", content: "Please keep this in mind. " + words(tokens) });
  return sessionId;
}

test("a model whose window the service reported gets it for the fold, the too-long stop and the meter", async (t) => {
  const model = scripted("chatgpt");
  const app = await fixture(t, [planSol(model)]);
  // About 25,000 tokens in one message: more than the old 20,000, well inside this model's window.
  const run = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 25000), ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(model.main.length, 1, "the model was asked");
  assert.ok(events(app, run, "model.started")[0].estimatedInput > 25000);
  assert.deepEqual(limits(app, run), [258400]);
  assert.equal(tokenReport(app.runtime, run.sessionId).limit, 258400, "the meter shows the window the task used");
  assert.equal(tokenReport(app.runtime, app.store.createSession(app.runtime.owner)).limit, 258400,
    "and, before any task, the window of the conversation's model");
  assert.equal((await knobsView(app)).launched.contextWindowTokens, 258400, "Automatic means this model's window");
});

test("a model on this computer gets the room it was loaded with, not 20,000", async (t) => {
  const model = scripted("ollama-like");
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, model, 8192);
  const small = await app.runtime.run({ prompt: "hello", ...tools });
  assert.equal(small.status, "completed", small.output);
  assert.deepEqual(limits(app, small), [8192]);
  assert.equal(tokenReport(app.runtime, small.sessionId).limit, 8192);
  // About 10,000 tokens: inside the old 20,000, past what the runtime holds for this model.
  const big = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 10000), ...tools });
  assert.equal(big.status, "budget_exceeded");
  assert.match(big.output, tooLong);
  assert.equal(model.main.length, 1, "the request that would not fit was never sent");
});

test("a model Branch has no named figure for keeps 20,000, whatever its name looks like", async (t) => {
  const plain = scripted("scripted"), newer = scripted("chatgpt"), keyed = scripted("openai");
  const app = await fixture(t, [unknown(plain),
    { id: "chatgpt-gpt-6-sol", name: "ChatGPT (unofficial) · GPT-6 Sol", model: "gpt-6-sol", provider: newer },
    { id: "api-sol", name: "OpenAI key · GPT-5.6 Sol", model: "gpt-5.6-sol", provider: keyed }]);
  assert.equal(tokenReport(app.runtime, app.store.createSession(app.runtime.owner)).limit, 20000);
  assert.equal((await knobsView(app)).launched.contextWindowTokens, 20000);
  for (const [preset, model] of [["default", plain], ["chatgpt-gpt-6-sol", newer], ["api-sol", keyed]]) {
    const run = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 25000), model: preset, ...tools });
    assert.equal(run.status, "budget_exceeded", preset);
    assert.match(run.output, tooLong);
    assert.deepEqual(limits(app, run), [20000], preset);
    assert.equal(model.main.length, 0, `${preset} was never sent a request past 20,000`);
  }
});

test("the owner's own figure comes before every model's window", async (t) => {
  const sol = scripted("chatgpt"), local = scripted("ollama-like");
  const app = await fixture(t, [planSol(sol)]);
  const localId = localConnection(app, local, 8192);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol" });
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 30000 });
  assert.equal(tokenReport(app.runtime, app.store.createSession(app.runtime.owner)).limit, 30000, "the meter before any task");
  const onPlan = await app.runtime.run({ prompt: "hello", ...tools });
  assert.deepEqual(limits(app, onPlan), [30000]);
  const onLocal = await app.runtime.run({ prompt: "hello", model: localId, ...tools });
  assert.deepEqual(limits(app, onLocal), [30000]);
  const view = await knobsView(app);
  assert.equal(view.values.compaction.contextWindowTokens, 30000);
  assert.equal(view.launched.contextWindowTokens, 258400, "what Automatic would give is still the model's own");
});

test("a task that falls back to another connection uses that connection's window from then on", async (t) => {
  const list = (id) => ({ content: "", toolCalls: [{ id, name: "files.list", arguments: "{}" }] });
  const main = scripted("chatgpt", (_request, n) => { if (n === 1) return list("c1"); throw new ProviderHttpError(503); });
  const backup = scripted("scripted", (_request, n) => (n === 1 ? list("c2") : { content: "Done.", toolCalls: [] }));
  const app = await fixture(t, [planSol(main), unknown(backup, "backup")], { retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 } });
  app.runtime.models.configure(app.runtime.owner, { fallbackOrder: ["backup"] });
  const run = await app.runtime.run({ prompt: "look around", ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(events(app, run, "model.fallback").length, 1);
  assert.deepEqual(limits(app, run), [258400, 258400, 20000], "each round is fitted to the connection it goes to");
});

test("the too-long stop is judged against the connection actually being called", async (t) => {
  const main = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
  const backup = scripted("scripted");
  const app = await fixture(t, [planSol(main), unknown(backup, "backup")], { retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 } });
  app.runtime.models.configure(app.runtime.owner, { fallbackOrder: ["backup"] });
  // About 25,000 tokens: inside the first connection's window, past the second's.
  const run = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 25000), ...tools });
  assert.equal(main.main.length, 1, "the first connection was asked");
  assert.equal(events(app, run, "model.fallback").length, 1);
  assert.equal(backup.main.length, 0, "the second was never sent a request larger than its window");
  assert.equal(run.status, "budget_exceeded");
  assert.match(run.output, tooLong);
});

test("folding follows the model's own window and keeps room for the answer", async (t) => {
  const model = scripted("ollama-like");
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, model, 32768);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  const turns = (from, to) => { for (let n = from; n <= to; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: `Turn ${n}: ` + words(1000) }); };
  // About 24,000 tokens of earlier turns: past what the old 20,000 held, short of this model's fold point.
  turns(1, 24);
  const roomy = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(roomy.status, "completed", roomy.output);
  assert.equal(events(app, roomy, "context.compacting").length, 0, "nothing is folded while the conversation fits");
  turns(25, 40);
  const folded = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(folded.status, "completed", folded.output);
  const [budget] = events(app, folded, "context.budget");
  const [compacting] = events(app, folded, "context.compacting");
  const [compacted] = events(app, folded, "context.compacted");
  assert.equal(budget.limit, 32768);
  assert.equal(compacting.threshold, 32768 - budget.catalog - budget.reserve, "the fold point leaves room for the tools and the answer");
  assert.ok(budget.messages > compacting.threshold);
  assert.ok(compacted.estimatedAfter + budget.catalog <= 32768 - budget.reserve, "after the fold the request leaves room for the answer");
});

test("a long conversation is still folded when the window is larger than one task may spend", async (t) => {
  const model = scripted("scripted");
  const app = await fixture(t, [unknown(model)]);
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 258400 });
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // About 240,000 tokens of earlier turns: inside the window, more than a task's 200,000 tokens.
  for (let n = 1; n <= 160; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: `Turn ${n}: ` + words(1500) });
  const next = await app.runtime.run({ prompt: "a short question", sessionId: first.sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(events(app, next, "context.compacted").length, 1, "the earlier turns were folded first");
  const after = await app.runtime.run({ prompt: "another short question", sessionId: first.sessionId, ...tools });
  assert.equal(after.status, "completed", after.output);
});

test("the summary a fold asks for fits the connection that writes it", async (t) => {
  const model = scripted("ollama-like");
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, model, 8192);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  for (let n = 1; n <= 30; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: `Turn ${n}: ` + words(400) });
  const next = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(events(app, next, "context.compacted").length, 1);
  const asked = model.side.find((request) => summaryAsk.test(request.messages[0].content));
  const size = Math.ceil(JSON.stringify({ messages: asked.messages, tools: [] }).length / 4);
  assert.ok(size <= 8192 - 2048, `the summary request (${size} tokens) leaves room for its answer in 8,192`);
});

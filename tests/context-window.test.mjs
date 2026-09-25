/**
 * Each model gets the context window it really has: the most one request to it may hold. The figure
 * comes from a named source (the room a model on this computer was loaded with, or a window the
 * service itself reported), the owner's own figure comes first, and a model Branch knows nothing
 * about keeps 20,000. The window is only the ceiling: folding and shrinking still keep a request to
 * the built-in 20,000 (or a smaller window), unless the owner set a figure of their own. A connection
 * moved to after a failure is fitted to its own window before it is asked, and a fold reads what it
 * drops even when the connection writing its summary is small. Scripted models only: nothing leaves
 * this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, derivedCompactionThreshold, saveKnobs } from "../dist/index.js";
import { tokenReport } from "../dist/commands/tokens.js";
import { knobsApi } from "../dist/knobs/api.js";
import { restoreLocalConnections } from "../dist/local-connections.js";
import { ProviderHttpError } from "../dist/provider-retry.js";

const tooLong = /grown too long to continue/;
const summaryAsk = /Summarize the conversation below/;
const isSummary = (request) => summaryAsk.test(request.messages[0]?.content ?? "");

/** A scripted model. A fold's summary and the questions asked with no tools are answered apart. */
function scripted(name, reply = () => ({ content: "Done.", toolCalls: [] })) {
  const provider = {
    name, main: [], side: [],
    async complete(request) {
      if (isSummary(request)) {
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
/** A connection that is down: every request to it, a summary included, fails with 503. */
function down(name) {
  const provider = { name, main: [], side: [], async complete(request) {
    (request.tools?.length ? provider.main : provider.side).push(request);
    throw new ProviderHttpError(503);
  } };
  return provider;
}
/** The ChatGPT plan route, GPT-5.6 Sol: a model whose window the service reported. */
const planSol = (provider) => ({ id: "chatgpt-gpt-5.6-sol", name: "ChatGPT (unofficial) · GPT-5.6 Sol (light)", model: "gpt-5.6-sol", provider });
const unknown = (provider, id = "default") => ({ id, name: "Default connection", model: "configured", provider });
const noRetries = { retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5 } };

async function fixture(t, presets, extra = {}, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-context-window-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, "workspace", name), text);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
/** A model on this computer, rebuilt from its written-down connection the way Branch does at start. */
function localConnection(app, provider, contextLength, { active = true } = {}) {
  const id = "local-ollama-qwen3-8b";
  app.store.save("settings", app.runtime.owner, "local-model-connections", { connections: [
    { id, name: "Qwen3 8B (runs on this computer)", runtime: "ollama", model: "qwen3:8b-q4_K_M-ctx", contextLength },
  ] });
  restoreLocalConnections({ models: app.runtime.models, store: app.store, owner: app.runtime.owner, policy: null,
    fetch: async () => { throw new Error("nothing is reached in tests"); }, endpoint: () => null });
  // The same connection, answered by the scripted model instead of a runtime.
  app.runtime.models.register({ ...app.runtime.models.presets.get(id), provider });
  if (active) app.runtime.models.configure(app.runtime.owner, { activePreset: id });
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
/** Earlier turns written straight into a conversation, `size(n)` tokens each. */
function earlierTurns(app, sessionId, count, size) {
  for (let n = 1; n <= count; n++)
    app.store.message(sessionId, { role: n % 2 ? "user" : "assistant", content: `Turn ${n}: ` + words(size(n)) });
}
/** The numbers of the earlier turns a piece of text holds. */
const turnsIn = (text) => [...String(text).matchAll(/Turn (\d+):/g)].map((match) => Number(match[1]));

test("a model whose window the service reported gets it as the ceiling and on the meter", async (t) => {
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
  const app = await fixture(t, [planSol(main), unknown(backup, "backup")], noRetries);
  app.runtime.models.configure(app.runtime.owner, { fallbackOrder: ["backup"] });
  const run = await app.runtime.run({ prompt: "look around", ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(events(app, run, "model.fallback").length, 1);
  assert.deepEqual(limits(app, run), [258400, 258400, 20000, 20000],
    "each round is fitted to the connection it goes to, and the fallback is fitted before it is first asked");
});

test("when the connection moved to cannot hold the conversation, the words name the one that is down", async (t) => {
  const main = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
  const backup = scripted("scripted");
  const app = await fixture(t, [planSol(main), unknown(backup, "backup")], noRetries);
  app.runtime.models.configure(app.runtime.owner, { fallbackOrder: ["backup"] });
  // About 25,000 tokens in one message: inside the first connection's window, past the second's, and nothing to fold.
  const run = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 25000), ...tools });
  assert.equal(main.main.length, 1, "the first connection was asked");
  assert.equal(events(app, run, "model.fallback").length, 1);
  assert.equal(backup.main.length, 0, "the second was never sent a request larger than its window");
  assert.equal(run.status, "budget_exceeded");
  assert.match(run.output, /GPT-5\.6 Sol \(light\) is not answering, and Default connection can't hold this conversation/);
  assert.doesNotMatch(run.output, /grown too long|start a new conversation/i);
  assert.equal(app.runtime.models.health.get("backup").consecutiveFailures, 0, "a conversation too long for it is not its failure");
});

test("a long conversation whose connection stops answering is folded once and answered by the fallback", async (t) => {
  const main = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
  const backup = scripted("scripted");
  const app = await fixture(t, [planSol(main), unknown(backup, "backup")], noRetries);
  app.runtime.models.configure(app.runtime.owner, { fallbackOrder: ["backup"] });
  const sessionId = app.store.createSession(app.runtime.owner);
  // About 40,000 tokens of earlier turns: inside the plan route's window, twice the fallback's.
  earlierTurns(app, sessionId, 40, () => 1000);
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(backup.main.length, 1, "the fallback was asked once");
  const folds = events(app, run, "context.compacted");
  assert.equal(folds.length, 1, "the conversation was folded once");
  const [first] = events(app, run, "context.budget");
  assert.equal(folds[0].threshold, derivedCompactionThreshold(first.catalog, 20000, first.reserve), "at the size the fallback's window allows");
  assert.ok(folds[0].estimatedAfter + first.catalog <= 20000 - first.reserve);
  assert.equal(app.runtime.models.health.get("backup").consecutiveFailures, 0);
});

test("a connection moved to after a failure is fitted to its own window before it is asked", async (t) => {
  const plan = down("chatgpt"), local = scripted("ollama-like");
  const app = await fixture(t, [planSol(plan)], noRetries);
  const localId = localConnection(app, local, 8192, { active: false });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: [localId] });
  // The owner's side jobs go to the plan route, which must not be sent the fold's summary once it is down.
  saveKnobs(app.store, app.runtime.owner, "subtasks", { sideJobModel: "chatgpt-gpt-5.6-sol" });
  const sessionId = app.store.createSession(app.runtime.owner);
  // About 7,800 tokens: far below where the plan route folds, past the local model's 8,192 with the tools.
  // The older twelve turns fit one summary request to it; the newest five stay as they are.
  earlierTurns(app, sessionId, 17, (n) => (n <= 12 ? 420 : 450));
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(plan.main.length, 1, "the plan route was asked once, and failed");
  assert.equal(plan.side.filter(isSummary).length, 0, "the fold's summary never went to the connection that failed");
  assert.equal(local.main.length, 1, "the fallback was asked once");
  assert.equal(local.side.filter(isSummary).length, 1, "the fallback wrote the summary");
  const budgets = events(app, run, "context.budget");
  assert.deepEqual(budgets.map((budget) => budget.limit), [258400, 8192]);
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "context.compacted").length, 1, "one fold");
  assert.ok(kinds.indexOf("context.compacted") > kinds.indexOf("model.fallback"), "folded for the fallback, after the move");
  const [folded] = events(app, run, "context.compacted");
  assert.ok(folded.estimatedAfter + budgets[1].catalog <= 8192, "the request fits the fallback's window");
  assert.ok(local.main[0].messages.length < 17, "the fallback was sent the folded conversation");
  assert.equal(app.runtime.models.health.get(localId).consecutiveFailures, 0, "the fallback's health is not marked");
});

test("a long task on a large-window route shrinks and folds where it always did, and finishes within its budget", async (t) => {
  const count = 15;
  const files = {};
  for (let n = 1; n <= count; n++) files[`notes-${n}.txt`] = `File ${n}\n` + `line ${n} of the long notes, with enough words to be sizeable. `.repeat(500);
  const model = scripted("chatgpt", (_request, n) => (n <= count
    ? { content: "", toolCalls: [{ id: `c${n}`, name: "files.read", arguments: JSON.stringify({ path: `notes-${n}.txt` }) }] }
    : { content: "All read.", toolCalls: [] }));
  const app = await fixture(t, [planSol(model)], {}, files);
  saveKnobs(app.store, app.runtime.owner, "limits", { maxModelRounds: 30 });
  const run = await app.runtime.run({ prompt: "read notes-1.txt to notes-15.txt one at a time", ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(model.main.length, count + 1, "every file was read");
  const inputs = events(app, run, "model.started").map((started) => started.estimatedInput);
  assert.ok(Math.max(...inputs) <= 20000, `no request past the built-in working size (largest ${Math.max(...inputs)})`);
  assert.ok(events(app, run, "context.shrunk").length >= 1, "older results were shrunk to make room");
  assert.deepEqual([...new Set(limits(app, run))], [258400], "while the model's window stays the ceiling");
});

test("a larger window is only the ceiling: a fold comes at the built-in size and keeps room for the answer", async (t) => {
  const model = scripted("ollama-like");
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, model, 32768);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // About 24,000 tokens of earlier turns: inside this model's window, past the size a request is kept to.
  earlierTurns(app, first.sessionId, 24, () => 1000);
  const folded = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(folded.status, "completed", folded.output);
  const [budget] = events(app, folded, "context.budget");
  const [compacting] = events(app, folded, "context.compacting");
  const [compacted] = events(app, folded, "context.compacted");
  assert.equal(budget.limit, 32768, "the window is the ceiling");
  assert.equal(budget.working, 20000, "folding and shrinking keep to the built-in size");
  assert.equal(compacting?.threshold, 20000 - budget.catalog - budget.reserve, "the fold point leaves room for the tools and the answer");
  assert.ok(compacted.estimatedAfter + budget.catalog <= 20000 - budget.reserve, "after the fold the request leaves room for the answer");
});

test("a long conversation is still folded when the window is larger than one task may spend", async (t) => {
  const model = scripted("scripted");
  const app = await fixture(t, [unknown(model)]);
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 258400 });
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // About 240,000 tokens of earlier turns: inside the window, more than a task's 200,000 tokens.
  earlierTurns(app, first.sessionId, 160, () => 1500);
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
  earlierTurns(app, first.sessionId, 30, () => 400);
  const next = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(events(app, next, "context.compacted").length, 1);
  for (const asked of model.side.filter(isSummary)) {
    const size = Math.ceil(JSON.stringify({ messages: asked.messages, tools: [] }).length / 4);
    assert.ok(size <= 8192 - 2048, `the summary request (${size} tokens) leaves room for its answer in 8,192`);
  }
});

/** A conversation whose side jobs go to a model on this computer loaded with `contextLength`. */
async function smallSideJobs(t, contextLength) {
  const main = scripted("scripted"), small = scripted("ollama-like");
  const app = await fixture(t, [unknown(main)]);
  const localId = localConnection(app, small, contextLength, { active: false });
  saveKnobs(app.store, app.runtime.owner, "subtasks", { sideJobModel: localId });
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // About 19,000 tokens of earlier turns, past where the conversation's own connection folds. What a fold
  // reads (the older 34 turns, under 60,000 characters) is far more than one request to the small model holds.
  for (let n = 1; n <= 40; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant",
    content: `Turn ${n}: ` + "earlier findings about the photo library and its folders ".repeat(n <= 34 ? 30 : 53) });
  const run = await app.runtime.run({ prompt: "short question", sessionId: first.sessionId, ...tools });
  return { app, main, small, localId, run, sessionId: first.sessionId };
}

test("a fold drops no turn its summary requests did not carry, however small the connection writing it", async (t) => {
  const { app, small, run, sessionId } = await smallSideJobs(t, 4096);
  assert.equal(run.status, "completed", run.output);
  const asked = small.side.filter(isSummary);
  assert.ok(asked.length > 1, "what one request could not carry was carried by the next, each building on the summary so far");
  const seen = new Set();
  for (const request of asked) {
    const size = Math.ceil(JSON.stringify({ messages: request.messages, tools: [] }).length / 4);
    assert.ok(size <= 4096 - 2048, `a summary request (${size} tokens) fits the connection writing it`);
    for (const turn of turnsIn(request.messages[1].content)) seen.add(turn);
  }
  const kept = new Set(app.store.workingMessages(sessionId).rows.flatMap((row) => turnsIn(row.message.content)));
  const lost = [];
  for (let n = 1; n <= 40; n++) if (!seen.has(n) && !kept.has(n)) lost.push(n);
  assert.deepEqual(lost, [], "every earlier turn was either summarised or is still in the conversation");
});

test("when the connection chosen for side jobs cannot hold any of a fold, the conversation's own connection writes it", async (t) => {
  const { app, main, small, run } = await smallSideJobs(t, 2048);
  assert.equal(run.status, "completed", run.output);
  assert.equal(small.side.filter(isSummary).length, 0, "the side-job connection was not sent a summary it could not hold");
  assert.equal(main.side.filter(isSummary).length, 1, "the conversation's own connection wrote it");
  const [compacting] = events(app, run, "context.compacting");
  assert.equal(compacting.writer, "default");
  assert.match(compacting.writerBecause, /cannot hold/);
});

/**
 * Each model gets the context window it really has: the most one request to it may hold. The figure
 * comes from a named source (the room a model on this computer was loaded with, or a window the
 * service itself reported), the owner's own figure comes first, and a model Branch knows nothing
 * about keeps 20,000. The window is only the ceiling: folding and shrinking still keep a request to
 * the built-in 20,000 (or a smaller window), unless the owner set a figure of their own. A connection
 * moved to after a failure is fitted to its own window before it is asked; one that fails while it is
 * fitted, or can't hold the conversation, is passed over for the next, and so is one a task starts on
 * while the chosen connection rests. A fold reads what it drops even when the connection writing its
 * summary is small: all a fold reads, in as many requests as that takes, ending at a turn of the person's,
 * and it keeps what was written before a request failed or the task ran out of tokens. A summary is
 * only asked for with the whole reply ceiling, so one cut short is never kept. The task is refused as
 * too long only when folding cannot make it fit. Scripted models only: nothing leaves this computer.
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
/** A model on this computer whose runtime is not running: every request to it fails before it gets there. */
function notRunning(name) {
  const provider = { name, main: [], side: [], async complete(request) {
    (request.tools?.length ? provider.main : provider.side).push(request);
    throw new TypeError("fetch failed");
  } };
  return provider;
}
/** A scripted model whose n-th fold summary `summary(n, request)` writes; it may throw instead. */
function writer(name, summary) {
  const provider = scripted(name), answer = provider.complete;
  let asked = 0;
  provider.complete = async (request) => {
    if (!isSummary(request)) return answer(request);
    provider.side.push(request);
    return { content: summary(++asked, request), toolCalls: [] };
  };
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
/** A fold summary that says which earlier turns it was sent. */
const summaryOf = (request) => JSON.stringify({ goals: [`summarised turns ${turnsIn(request.messages[1].content).join(",")}`],
  decisions: [], openQuestions: [], filesTouched: [] });
/** The earlier turns a conversation's stored messages still hold, after any fold. */
const keptTurns = (app, sessionId) => new Set(app.store.workingMessages(sessionId).rows.flatMap((row) => turnsIn(row.message.content)));
/** Earlier turns (1 to `count`) that no summary request carried and that are not in the conversation either. */
function lostTurns(app, sessionId, requests, count = 40) {
  const seen = new Set(requests.flatMap((request) => turnsIn(request.messages[1].content)));
  const kept = keptTurns(app, sessionId), lost = [];
  for (let n = 1; n <= count; n++) if (!seen.has(n) && !kept.has(n)) lost.push(n);
  return lost;
}

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

/**
 * About 19,000 tokens of earlier turns, past where the conversation's own connection folds. What a fold
 * reads (the older 34 turns, under 60,000 characters) is far more than one request to a small model holds.
 */
function photoTurns(app, sessionId) {
  for (let n = 1; n <= 40; n++) app.store.message(sessionId, { role: n % 2 ? "user" : "assistant",
    content: `Turn ${n}: ` + "earlier findings about the photo library and its folders ".repeat(n <= 34 ? 30 : 53) });
}
/** A conversation whose side jobs go to a model on this computer loaded with `contextLength`. */
async function smallSideJobs(t, contextLength, { small = scripted("ollama-like"), turns = photoTurns } = {}) {
  const main = scripted("scripted");
  const app = await fixture(t, [unknown(main)]);
  const localId = localConnection(app, small, contextLength, { active: false });
  saveKnobs(app.store, app.runtime.owner, "subtasks", { sideJobModel: localId });
  const first = await app.runtime.run({ prompt: "start", ...tools });
  turns(app, first.sessionId);
  const run = await app.runtime.run({ prompt: "short question", sessionId: first.sessionId, ...tools });
  return { app, main, small, localId, run, sessionId: first.sessionId };
}

test("a fold drops no turn its summary requests did not carry, however small the connection writing it", async (t) => {
  const { app, main, small, run, sessionId } = await smallSideJobs(t, 4096);
  assert.equal(run.status, "completed", run.output);
  const asked = small.side.filter(isSummary);
  assert.ok(asked.length > 1, "what one request could not carry was carried by the next, each building on the summary so far");
  // The conversation's own connection may write part of a fold; what it carried counts too.
  const seen = new Set(main.side.filter(isSummary).flatMap((request) => turnsIn(request.messages[1].content)));
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

test("a fallback that fails while the conversation is fitted to it is marked like any other, and the next one is asked", async (t) => {
  // A failure with no status is written down by Branch; one with a status, by the connection's own watched fetch.
  for (const [failing, writtenHere] of [[notRunning("ollama-like"), true], [down("ollama-like"), false]]) {
    const plan = scripted("chatgpt", () => { throw new ProviderHttpError(503); }), backup = scripted("scripted");
    const app = await fixture(t, [planSol(plan), unknown(backup, "backup")], noRetries);
    const localId = localConnection(app, failing, 8192, { active: false });
    app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: [localId, "backup"] });
    const sessionId = app.store.createSession(app.runtime.owner);
    // About 14,000 tokens: under where the plan route folds, past what the model on this computer holds. With no
    // side-job connection, that model is asked to write the summary that fits the conversation to it.
    earlierTurns(app, sessionId, 14, () => 1000);
    const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
    assert.equal(run.status, "completed", run.output);
    assert.equal(failing.side.filter(isSummary).length, 1, "the model on this computer was asked for the summary, and failed");
    assert.equal(backup.main.length, 1, "the next connection in the order answered");
    assert.deepEqual(events(app, run, "model.fallback").map((move) => `${move.from} > ${move.to}`),
      [`chatgpt-gpt-5.6-sol > ${localId}`, `${localId} > backup`]);
    assert.ok(app.runtime.models.coolingDown(localId), "the connection that failed is cooling down");
    if (writtenHere) assert.equal(app.runtime.models.health.get(localId).consecutiveFailures, 1, "and its failure is written down");
    const second = await app.runtime.run({ prompt: "and again?", sessionId, ...tools });
    assert.equal(second.status, "completed", second.output);
    assert.equal(events(app, second, "model.started")[0].preset, "backup", "the next task starts past both");
  }
});

test("a side-job connection that fails for its own reasons while a fallback is fitted ends the task, and the fallback is not marked for it", async (t) => {
  const plan = scripted("chatgpt", () => { throw new ProviderHttpError(503); }), local = scripted("ollama-like");
  // A refusal with no status (a refused sign-in, say) is no reason to try another connection. Branch writes a failure
  // with no status down itself, so it must be put down to the connection that failed and to no other.
  const refused = "The sign-in to this connection was refused.";
  const helper = writer("helper", () => { throw new Error(refused); });
  const app = await fixture(t, [planSol(plan), unknown(helper, "helper")], noRetries);
  const localId = localConnection(app, local, 8192, { active: false });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: [localId] });
  // The owner's side jobs go to a third connection, so it is asked for the summary that fits the conversation to the fallback.
  saveKnobs(app.store, app.runtime.owner, "subtasks", { sideJobModel: "helper" });
  const sessionId = app.store.createSession(app.runtime.owner);
  // About 14,000 tokens: under where the plan route folds, past what the model on this computer holds.
  earlierTurns(app, sessionId, 14, () => 1000);
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "failed", "the side-job connection's own failure ends the task, as it always has");
  assert.equal(run.output, refused);
  assert.deepEqual(events(app, run, "model.fallback").map((move) => `${move.from} > ${move.to}`), [`chatgpt-gpt-5.6-sol > ${localId}`]);
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.indexOf("context.compacting") > kinds.indexOf("model.fallback"), "the fold was for the fallback, after the move");
  assert.deepEqual(events(app, run, "context.compacting").map((fold) => fold.writer), ["helper"], "and the side-job connection was asked to write it");
  assert.equal(helper.side.filter(isSummary).length, 1);
  assert.deepEqual([local.main.length, local.side.length], [0, 0], "the fallback was never asked anything");
  assert.deepEqual(events(app, run, "context.compacted"), [], "nothing was folded");
  assert.equal(app.runtime.models.health.get(localId).consecutiveFailures, 0, "the side-job connection's failure is not counted against the fallback");
  assert.equal(app.runtime.models.coolingDown(localId), false, "and the fallback is not cooling down");
  // Nor is it written into the side-job connection's own health here: the task's events record it.
  assert.equal(app.runtime.models.health.get("helper").consecutiveFailures, 0);
  assert.equal(app.runtime.models.coolingDown("helper"), false);
  assert.equal(events(app, run, "model.failed").at(-1).error, refused);
});

test("a fallback that can't hold the conversation is passed over for a later one that can", async (t) => {
  const plan = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
  const local = scripted("ollama-like"), backup = scripted("scripted");
  const app = await fixture(t, [planSol(plan), unknown(backup, "backup")], noRetries);
  const localId = localConnection(app, local, 8192, { active: false });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: [localId, "backup"] });
  const sessionId = app.store.createSession(app.runtime.owner);
  // The newest turns, which a fold keeps, hold about 15,000 tokens: past 8,192 however much is folded, inside 20,000.
  earlierTurns(app, sessionId, 40, (n) => (n > 32 ? 2500 : 1000));
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(local.main.length, 0, "the model on this computer was never sent a request larger than its window");
  assert.equal(backup.main.length, 1, "the backup, later in the order, answered");
  const moves = events(app, run, "model.fallback");
  assert.deepEqual(moves.map((move) => `${move.from} > ${move.to}`), [`chatgpt-gpt-5.6-sol > ${localId}`, `${localId} > backup`]);
  assert.match(moves[1].reason, /can't hold this conversation/);
  assert.equal(app.runtime.models.health.get(localId).consecutiveFailures, 0, "being passed over is not a failure");
  assert.equal(app.runtime.models.coolingDown(localId), false);
});

test("a task that starts on a fallback while the chosen connection rests passes over one that can't hold the conversation", async (t) => {
  const plan = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
  const local = scripted("ollama-like"), backup = scripted("scripted");
  const app = await fixture(t, [planSol(plan), unknown(backup, "backup")], noRetries);
  const localId = localConnection(app, local, 8192, { active: false });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: [localId, "backup"] });
  const sessionId = app.store.createSession(app.runtime.owner);
  // The newest turns, which a fold keeps, hold about 15,000 tokens: past 8,192 however much is folded, inside 20,000.
  earlierTurns(app, sessionId, 40, (n) => (n > 32 ? 2500 : 1000));
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.ok(app.runtime.models.coolingDown("chatgpt-gpt-5.6-sol"), "the chosen connection rests after its failure");
  // Straight after, the next task starts on the first fallback in the order, which can't hold the conversation either.
  const next = await app.runtime.run({ prompt: "and again?", sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  const [selected] = events(app, next, "model.selected");
  assert.deepEqual([selected.presetId, selected.source], [localId, "cooldown"], "it started on the model on this computer");
  assert.equal(plan.main.length, 1, "the resting connection was not asked again");
  assert.equal(local.main.length, 0, "the model on this computer was never sent a request larger than its window");
  assert.equal(backup.main.length, 2, "the backup, later in the order, answered both");
  const moves = events(app, next, "model.fallback");
  assert.deepEqual(moves.map((move) => `${move.from} > ${move.to}`), [`${localId} > backup`]);
  assert.match(moves[0].reason, /can't hold this conversation/);
  assert.equal(app.runtime.models.health.get(localId).consecutiveFailures, 0, "being passed over is not a failure");
  assert.equal(app.runtime.models.coolingDown(localId), false);
});

test("the connection chosen for a task is never passed over for a fallback because the conversation is too long for it", async (t) => {
  const local = scripted("ollama-like"), backup = scripted("scripted");
  const app = await fixture(t, [unknown(backup, "backup")]);
  const localId = localConnection(app, local, 8192);
  app.runtime.models.configure(app.runtime.owner, { activePreset: localId, fallbackOrder: ["backup"] });
  // About 10,000 tokens in one message: past what the chosen model on this computer holds, and nothing to fold.
  const run = await app.runtime.run({ prompt: "What did I send?", sessionId: oneLongMessage(app, 10000), ...tools });
  assert.equal(run.status, "budget_exceeded");
  assert.match(run.output, tooLong);
  assert.deepEqual(events(app, run, "model.fallback"), [], "the conversation was not sent to another connection");
  assert.equal(backup.main.length, 0);
});

test("a small side-job connection writes all of a fold it can carry, in as many requests as that takes", async (t) => {
  const { app, main, small, localId, run, sessionId } = await smallSideJobs(t, 4096);
  assert.equal(run.status, "completed", run.output);
  const asked = small.side.filter(isSummary), taken = main.side.filter(isSummary);
  assert.equal(asked.length, 9, "the side-job connection wrote all nine requests");
  assert.equal(taken.length, 0, "and the conversation's own connection wrote none of it");
  assert.deepEqual(lostTurns(app, sessionId, asked), [], "every earlier turn was either summarised or is still in the conversation");
  const [folded] = events(app, run, "context.compacted");
  assert.equal(folded.summaryRequests, 9);
  assert.deepEqual(folded.writers, [localId]);
  assert.equal(folded.readMessages, undefined, "the fold read all a fold reads");
});

/** 400 short turns (or `count`), about 45 tokens each: far more than one request to a model loaded with 4,096 carries. */
function tinyTurns(app, sessionId, size = () => 3, count = 400) {
  for (let n = 1; n <= count; n++) app.store.message(sessionId, { role: n % 2 ? "user" : "assistant",
    content: `Turn ${n}: ` + "earlier findings about the photo library and its folders ".repeat(size(n)) });
}
const foldedPart = /more is left to fold/;
const longSummary = () => "the summary goes on and on about the photo library ".repeat(200);
/** The earlier turns the summary requests carried, and the last of them. */
function carried(requests) {
  const seen = requests.flatMap((request) => turnsIn(request.messages[1].content));
  return { seen, last: Math.max(...seen) };
}

test("a fold with no larger connection to turn to reads all a fold reads, however many requests that takes, and the task is answered", async (t) => {
  const own = writer("ollama-like", longSummary);
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 4096);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // Many short turns and long summaries: after its first request, the only connection there is carries a few
  // turns at a time while it reads back a summary of 6,000 characters.
  tinyTurns(app, first.sessionId);
  const run = await app.runtime.run({ prompt: "short question", sessionId: first.sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.doesNotMatch(run.output, foldedPart);
  const asked = own.side.filter(isSummary);
  const folds = events(app, run, "context.compacted");
  assert.equal(folds.length, 1, "one fold");
  assert.equal(asked.length, 36, "one fold of thirty-six requests: all it reads, the first 60,000 characters of the older part");
  assert.equal(folds[0].summaryRequests, 36);
  assert.equal(folds[0].readMessages, undefined, "it read all a fold reads");
  // What a fold reads is its first 60,000 characters; the rest of the older part is folded with it, as it always was.
  const { last } = carried(asked);
  assert.deepEqual(lostTurns(app, first.sessionId, asked, 400).filter((n) => n <= last), [], "nothing up to the last turn it read was dropped unread");
  // The next message is answered with nothing more to fold.
  const next = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(own.side.filter(isSummary).length, 36, "nothing was left to fold");
});

test("a fold its only connection writes a few dozen turns at a time reads on past five requests, and the task is answered", async (t) => {
  const own = writer("ollama-like", (_n, request) => summaryOf(request));
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 4096);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // Short summaries: each request carries about forty turns, so reading all a fold reads takes nine.
  tinyTurns(app, first.sessionId);
  const answered = own.main.length;
  const run = await app.runtime.run({ prompt: "short question", sessionId: first.sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  assert.equal(own.main.length - answered, 1, "the question was answered");
  const folds = events(app, run, "context.compacted");
  assert.equal(folds.length, 1, "one fold, not one stopped at five and made again");
  assert.equal(folds[0].summaryRequests, 9);
  assert.equal(folds[0].readMessages, undefined, "it read all a fold reads");
  const asked = own.side.filter(isSummary), { last } = carried(asked);
  assert.equal(asked.length, 9);
  assert.deepEqual(lostTurns(app, first.sessionId, asked, 400).filter((n) => n <= last), [], "nothing up to the last turn it read was dropped unread");
});

test("when what folding keeps is past the window by itself, the task is refused as too long after one fold", async (t) => {
  const own = writer("ollama-like", longSummary);
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 4096);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // The newest turns, which a fold keeps, hold about 3,600 tokens: with the summary, past 4,096 however much is folded.
  tinyTurns(app, first.sessionId, (n) => (n > 394 ? 40 : 3));
  const run = await app.runtime.run({ prompt: "short question", sessionId: first.sessionId, ...tools });
  assert.equal(run.status, "budget_exceeded");
  assert.match(run.output, tooLong);
  assert.doesNotMatch(run.output, foldedPart);
  const folds = events(app, run, "context.compacted");
  assert.equal(folds.length, 1, "one fold, with no second one that could not help");
  assert.equal(folds[0].readMessages, undefined, "and it read all a fold reads before the refusal");
});

test("a summary request that fails keeps what the earlier ones wrote, and the conversation's own connection writes the rest", async (t) => {
  const small = writer("ollama-like", (n, request) => { if (n === 3) throw new ProviderHttpError(503); return summaryOf(request); });
  const { app, main, run, localId, sessionId } = await smallSideJobs(t, 4096, { small });
  assert.equal(run.status, "completed", run.output);
  const asked = small.side.filter(isSummary), taken = main.side.filter(isSummary);
  assert.equal(asked.length, 3, "the side-job connection was asked three times, and the third failed");
  assert.equal(taken.length, 1, "the conversation's own connection wrote the rest");
  assert.ok(taken[0].messages[1].content.includes(`summarised turns ${turnsIn(asked[1].messages[1].content).join(",")}`),
    "building on the summary already written");
  const written = asked.slice(0, 2).flatMap((request) => turnsIn(request.messages[1].content));
  assert.deepEqual(turnsIn(taken[0].messages[1].content).filter((n) => written.includes(n)), [], "without being sent those turns again");
  assert.deepEqual(lostTurns(app, sessionId, [...asked.slice(0, 2), ...taken]), []);
  const [folded] = events(app, run, "context.compacted");
  assert.deepEqual(folded.writers, [localId, "default"]);
  assert.equal(folded.failedRequests, 1);
});

test("when the connection writing a fold fails partway, the summary it already wrote is kept", async (t) => {
  const own = writer("ollama-like", (n, request) => { if (n === 3) throw new ProviderHttpError(503); return summaryOf(request); });
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 8192);
  const first = await app.runtime.run({ prompt: "start", ...tools });
  // What a fold reads here, about 15,000 tokens, takes three or more requests to a model loaded with 8,192.
  earlierTurns(app, first.sessionId, 30, () => 1000);
  const run = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId, ...tools });
  assert.equal(run.status, "failed", "its only connection failed, as before");
  const asked = own.side.filter(isSummary);
  assert.equal(asked.length, 3);
  const working = app.store.workingMessages(first.sessionId);
  assert.match(working.summary ?? "", new RegExp(`summarised turns ${turnsIn(asked[1].messages[1].content).join(",")}`),
    "the summary written before the failure is kept");
  assert.equal(keptTurns(app, first.sessionId).has(1), false, "and the turns it carried left the conversation");
  assert.deepEqual(lostTurns(app, first.sessionId, asked.slice(0, 2), 30), []);
});

test("a side-job connection that would read back more summary than it adds hands the rest of a fold to the conversation's own", async (t) => {
  const small = writer("ollama-like", () => "the summary goes on and on about the photo library ".repeat(200));
  const { app, main, run, localId } = await smallSideJobs(t, 4096, { small, turns: (app, sessionId) => {
    // Many short turns: after its first long summary, each request the side-job connection could send would
    // carry less of them than the summary it must read back.
    for (let n = 1; n <= 400; n++) app.store.message(sessionId, { role: n % 2 ? "user" : "assistant",
      content: `Turn ${n}: ` + "earlier findings about the photo library and its folders ".repeat(3) });
  } });
  assert.equal(run.status, "completed", run.output);
  assert.equal(small.side.filter(isSummary).length, 1, "the side-job connection wrote the first part only");
  assert.equal(main.side.filter(isSummary).length, 1, "the conversation's own connection wrote the rest, in one request");
  assert.deepEqual(events(app, run, "context.compacted")[0].writers, [localId, "default"]);
});

/**
 * An earlier task with one long run of tool calls: the person's question, `pairs` rounds of one call and its result
 * (`resultChars` characters), the answer, then ten ordinary turns. Returns the number of the last turn.
 */
function toolExchange(app, sessionId, pairs, { resultChars = 1200, pin = [] } = {}) {
  const text = (chars) => "notes on the folder of holiday photos and their dates ".repeat(Math.ceil(chars / 54)).slice(0, chars);
  let n = 1;
  const put = (message) => {
    const id = app.store.message(sessionId, message);
    if (pin.includes(n - 1)) app.store.pinMessage(app.runtime.owner, sessionId, id, true);
  };
  put({ role: "user", content: `Turn ${n++}: please go through the photo library folders one by one and list what is in each` });
  for (let i = 1; i <= pairs; i++) {
    put({ role: "assistant", content: `Turn ${n++}: reading folder ${i}`, toolCalls: [{ id: `c${i}`, name: "files.read", arguments: JSON.stringify({ path: `photos/${i}` }) }] });
    put({ role: "tool", toolCallId: `c${i}`, content: `Turn ${n++}: ` + text(resultChars) });
  }
  put({ role: "assistant", content: `Turn ${n++}: I went through all ${pairs} folders.` });
  for (let k = 1; k <= 10; k++) put({ role: k % 2 ? "user" : "assistant", content: `Turn ${n++}: ` + text(400) });
  return n - 1;
}
/** The first message after the instructions in a request, pinned ones aside. */
const opening = (request, pinned = []) => request.messages.find((message) => message.role !== "system" && !pinned.includes(message.content));

test("a fold whose older part is one long run of tool calls reads through it to the person's next turn, and the conversation carries on", async (t) => {
  const own = writer("ollama-like", (_n, request) => summaryOf(request));
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 4096);
  const sessionId = app.store.createSession(app.runtime.owner);
  // Thirty rounds, with results of 1,200 characters: more than five requests to a model loaded with 4,096 carry.
  const turns = toolExchange(app, sessionId, 30);
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "completed", run.output);
  const folds = events(app, run, "context.compacted");
  assert.equal(folds.length, 1, "the run of tool calls was folded");
  assert.ok(folds[0].summaryRequests > 5, `${folds[0].summaryRequests} summary requests`);
  assert.equal(folds[0].readMessages, undefined, "it read all a fold reads, through the run of tool calls");
  assert.deepEqual(lostTurns(app, sessionId, own.side.filter(isSummary), turns), [], "every earlier turn was either summarised or is still in the conversation");
  assert.equal(app.store.workingMessages(sessionId).rows[0].message.role, "user", "what is kept begins with a turn of the person's");
  // The next message carries on, with nothing left to fold.
  const next = await app.runtime.run({ prompt: "and again?", sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(events(app, next, "context.compacted").length, 0);
  assert.equal(opening(own.main.at(-1)).role, "user");
});

test("a fallback that folding can fit is not passed over as unable to hold the conversation, however many requests its fold takes", async (t) => {
  // After the model on this computer comes an unknown 20,000 backup, or a second model on this computer.
  for (const second of ["backup", "local-second"]) {
    const plan = scripted("chatgpt", () => { throw new ProviderHttpError(503); });
    const local = writer("ollama-like", longSummary), other = writer("ollama-like", longSummary), backup = scripted("scripted");
    const app = await fixture(t, [planSol(plan), unknown(backup, "backup")], noRetries);
    app.store.save("settings", app.runtime.owner, "local-model-connections", { connections: [
      { id: "local-first", name: "Small (runs on this computer)", runtime: "ollama", model: "small:3b", contextLength: 4096 },
      { id: "local-second", name: "Second small (runs on this computer)", runtime: "ollama", model: "second:3b", contextLength: 4096 },
    ] });
    restoreLocalConnections({ models: app.runtime.models, store: app.store, owner: app.runtime.owner, policy: null,
      fetch: async () => { throw new Error("nothing is reached in tests"); }, endpoint: () => null });
    app.runtime.models.register({ ...app.runtime.models.presets.get("local-first"), provider: local });
    app.runtime.models.register({ ...app.runtime.models.presets.get("local-second"), provider: other });
    app.runtime.models.configure(app.runtime.owner, { activePreset: "chatgpt-gpt-5.6-sol", fallbackOrder: ["local-first", second] });
    const sessionId = app.store.createSession(app.runtime.owner);
    // The first fallback writes summaries of 6,000 characters, so its fold takes many requests; what it keeps fits it.
    tinyTurns(app, sessionId);
    // The chosen connection rests, so the task starts on the first fallback.
    app.runtime.models.markFailure(app.runtime.owner, "chatgpt-gpt-5.6-sol", new ProviderHttpError(503));
    const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
    assert.equal(run.status, "completed", `${second}: ${run.output}`);
    assert.equal(local.main.length, 1, `${second}: the first fallback, which folding could fit, answered`);
    assert.deepEqual(events(app, run, "model.fallback"), [], `${second}: it was not passed over`);
    assert.deepEqual([backup.main.length, other.main.length, other.side.length], [0, 0, 0], `${second}: the next in the order was never asked`);
    assert.equal(events(app, run, "context.compacted").length, 1);
    assert.equal(app.runtime.models.health.get("local-first").consecutiveFailures, 0);
  }
});

test("a conversation with ordinary turns, a long run of tool calls and a pinned answer is answered in every task on a model loaded with 4,096", async (t) => {
  const own = writer("ollama-like", (_n, request) => summaryOf(request));
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 4096);
  const sessionId = app.store.createSession(app.runtime.owner);
  // Forty rounds with results of 1,200 characters, the answer after them (turn 82) pinned by the owner, then
  // more ordinary turns.
  toolExchange(app, sessionId, 40, { pin: [82] });
  earlierTurns(app, sessionId, 6, () => 100);
  const pinned = app.store.workingMessages(sessionId).rows.filter((row) => app.store.pinnedMessageIds(sessionId).has(row.id)).map((row) => row.message.content);
  assert.equal(pinned.length, 1);
  for (const [n, prompt] of ["and now?", "and again?", "and once more?"].entries()) {
    const run = await app.runtime.run({ prompt, sessionId, ...tools });
    assert.equal(run.status, "completed", `task ${n + 1}: ${run.output}`);
    assert.equal(opening(own.main.at(-1), pinned).role, "user", `task ${n + 1}: the conversation it sent begins with a turn of the person's`);
    assert.ok(own.main.at(-1).messages.some((message) => message.content === pinned[0]), `task ${n + 1}: the pinned answer stays`);
  }
});

test("when the connection writing a fold fails inside a long run of tool calls, what is kept still begins with a turn of the person's", async (t) => {
  const own = writer("ollama-like", (n, request) => { if (n === 3) throw new ProviderHttpError(503); return summaryOf(request); });
  const app = await fixture(t, [unknown(scripted("unused"))]);
  localConnection(app, own, 8192);
  const sessionId = app.store.createSession(app.runtime.owner);
  // Forty rounds: its first two requests read into the run of tool calls, and the third fails.
  toolExchange(app, sessionId, 40);
  const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools });
  assert.equal(run.status, "failed", "its only connection failed, as before");
  assert.equal(own.side.filter(isSummary).length, 3);
  assert.equal(app.store.workingMessages(sessionId).rows[0].message.role, "user",
    "no fold ended inside the run of tool calls: what is kept begins with a turn of the person's");
  const next = await app.runtime.run({ prompt: "and again?", sessionId, ...tools });
  assert.equal(next.status, "completed", next.output);
  assert.equal(opening(own.main.at(-1)).role, "user");
});

/**
 * A writer that keeps to the reply ceiling it is sent, as a real model does: its reply, at three characters a
 * token, is cut there. Each reply names its request and the last turn it was sent.
 */
function keepsToCeiling(name) {
  return writer(name, (n, request) =>
    (`summary ${n} through turn ${Math.max(...turnsIn(request.messages[1].content))}: ` + longSummary()).slice(0, request.maxTokens * 3));
}

test("a fold that runs out of the task's tokens keeps its last whole summary, drops only the turns it covered, and the next task carries on", async (t) => {
  // Task budgets spread across one summary request's cost (about 3,500 tokens), so the fold runs out at every point in one.
  for (const maxTokens of [12900, 13800, 14700, 15600, 16500]) {
    const own = keepsToCeiling("ollama-like");
    const app = await fixture(t, [unknown(scripted("unused"))]);
    const localId = localConnection(app, own, 4096);
    const sessionId = app.store.createSession(app.runtime.owner);
    // 120 short turns and long summaries: a fold of about a dozen requests, more than the task's tokens allow.
    tinyTurns(app, sessionId, () => 3, 120);
    const run = await app.runtime.run({ prompt: "and now?", sessionId, ...tools, budget: { maxSteps: 60, maxTokens } });
    const asked = own.side.filter(isSummary);
    assert.deepEqual(asked.map((request) => request.maxTokens).filter((ceiling) => ceiling !== 2048), [],
      `${maxTokens}: every summary request went out with the whole reply ceiling`);
    assert.equal(run.status, "budget_exceeded", `${maxTokens}: ${run.output}`);
    assert.match(run.output, /Token budget exhausted/);
    const { summary } = app.store.workingMessages(sessionId);
    assert.equal(summary?.length, 6000, `${maxTokens}: the summary kept is a whole one`);
    assert.ok(summary.startsWith(`summary ${asked.length} through turn ${carried(asked).last}:`), `${maxTokens}: the last one written`);
    const whole = asked.filter((request) => request.maxTokens === 2048);
    assert.deepEqual(lostTurns(app, sessionId, whole, 120), [], `${maxTokens}: every turn dropped was carried by a request whose summary is kept`);
    const [folded] = events(app, run, "context.compacted");
    assert.ok(folded.readMessages > 0, "the part of the fold that was read is kept");
    assert.equal(folded.failedRequests, undefined, "no request failed: the one the task could not afford was never sent");
    assert.equal(app.runtime.models.health.get(localId)?.consecutiveFailures ?? 0, 0, "running out of tokens is not the connection's failure");
    // The next task carries on from the part kept, with the whole of its own budget.
    const next = await app.runtime.run({ prompt: "and again?", sessionId, ...tools });
    assert.equal(next.status, "completed", `${maxTokens}: ${next.output}`);
    const later = own.side.filter(isSummary).slice(asked.length);
    assert.ok(later[0].messages[1].content.includes(summary), `${maxTokens}: building on the summary kept`);
    assert.deepEqual(later.map((request) => request.maxTokens).filter((ceiling) => ceiling !== 2048), []);
    assert.deepEqual(lostTurns(app, sessionId, [...whole, ...later], 120), [], `${maxTokens}: no earlier turn was dropped unread`);
  }
});

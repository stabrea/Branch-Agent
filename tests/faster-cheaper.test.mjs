import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, saveBatchSettings, runBatch, supportsBatch, batchSets,
  saveCacheSettings, OpenAIProvider, AnthropicProvider, offersBatch, sameHost,
} from "../dist/index.js";

/**
 * Wave 9, bucket 9: faster and cheaper on the same work.
 *
 * Everything here is against fakes. No question ever leaves this computer: the two service adapters
 * are driven by a fake `fetch` that answers with the shapes OpenAI and Anthropic really send, and
 * the rest of the tests use a fake connection that reports whether it takes whole sets.
 */

const discard = (base) => discardTemp(base).catch(() => undefined);
const noWait = async () => undefined;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-faster-"));
  const provider = { name: "scripted", async complete() { return { content: "plain", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discard(base); });
  return app;
}

/** A connection that takes whole sets, driven by a plan. */
function setTaking(plan = {}) {
  const calls = { submit: 0, poll: 0, collect: 0, complete: 0 };
  const provider = {
    name: "fake", calls,
    async complete() {
      calls.complete += 1;
      return { content: `one at a time ${calls.complete}`, toolCalls: [], usage: { input: 9, output: 3 } };
    },
    batch: () => plan.none ? null : ({
      async submit(requests) { calls.submit += 1; provider.sent = requests; return { batchId: "set-1" }; },
      async poll() {
        calls.poll += 1;
        if (plan.failsAfter && calls.poll >= plan.failsAfter) return { status: "failed", error: "the set failed" };
        return { status: calls.poll >= (plan.readyAfter ?? 1) ? "completed" : "working" };
      },
      async collect() {
        calls.collect += 1;
        if (plan.collectFails) throw new Error("the answers could not be read");
        return provider.sent
          .filter((request) => !(plan.lost ?? []).includes(request.id))
          .map((request) => (plan.errored ?? []).includes(request.id)
            ? { id: request.id, content: "", error: "that one went wrong" }
            : { id: request.id, content: `in a set: ${request.id}`, usage: { input: 10, output: 4 } });
      },
    }),
  };
  return provider;
}

const threeAsks = [
  { id: "a", messages: [{ role: "user", content: "first" }] },
  { id: "b", messages: [{ role: "user", content: "second" }] },
  { id: "c", messages: [{ role: "user", content: "third" }] },
];

/* ---------- A1351 / A1352: several independent asks, one set ---------- */

test("several independent asks go out as one set where the service takes one", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  const provider = setTaking({ readyAfter: 2 });
  assert.equal(supportsBatch(provider), true);

  const outcome = await runBatch(app.store, owner, { id: "s", name: "Sets", provider, model: "gpt-4o-mini" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(outcome.route, "batch");
  assert.equal(provider.calls.submit, 1, "three asks went over as one hand-over");
  assert.equal(provider.calls.complete, 0, "not one ordinary call was made");
  assert.deepEqual(outcome.answers.map((answer) => answer.id), ["a", "b", "c"]);
  assert.deepEqual(outcome.counts, { batched: 3, askedAgain: 0, unanswered: 0 });
});

test("a service without sets falls back, and the answers are the same either way", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });

  const withSets = setTaking({ readyAfter: 1 });
  const batched = await runBatch(app.store, owner, { id: "s", name: "S", provider: withSets, model: "m" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  // The same three questions against a connection that has no set endpoint at all.
  const plain = setTaking({ none: true });
  plain.complete = async (request) => ({ content: `in a set: ${idFor(request)}`, toolCalls: [], usage: { input: 10, output: 4 } });
  assert.equal(supportsBatch(plain), false);
  const direct = await runBatch(app.store, owner, { id: "p", name: "P", provider: plain, model: "m" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(direct.route, "direct");
  assert.match(direct.reason, /does not take a whole set/);
  assert.deepEqual(direct.answers.map((answer) => answer.id), batched.answers.map((answer) => answer.id));
  assert.deepEqual(direct.answers.map((answer) => answer.content), batched.answers.map((answer) => answer.content),
    "the answers are identical whichever road they took");
});
/** Which question a one-at-a-time call is answering, read back out of its own words. */
const idFor = (request) => ({ first: "a", second: "b", third: "c" })[request.messages.at(-1).content];

test("a set that fails part-way keeps what succeeded and says what did not", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  // The service calls the whole set failed, but two of the three answers are there to be collected.
  const provider = setTaking({ failsAfter: 1, lost: ["c"] });

  const outcome = await runBatch(app.store, owner, { id: "s", name: "S", provider, model: "m" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(outcome.route, "batch", "the set road is still what happened");
  assert.equal(outcome.answers.find((answer) => answer.id === "a").content, "in a set: a");
  assert.equal(outcome.answers.find((answer) => answer.id === "b").content, "in a set: b");
  assert.equal(provider.calls.complete, 1, "only the missing question was asked again");
  assert.equal(outcome.counts.batched, 2);
  assert.equal(outcome.counts.askedAgain, 1);
  assert.deepEqual(outcome.askedAgain, ["c"]);
  assert.match(outcome.reason, /asked again one at a time/);
  assert.deepEqual(outcome.answers.map((answer) => answer.id), ["a", "b", "c"], "in the order they were asked");
});

test("a question the set answered with an error is asked again rather than kept as an error", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  const provider = setTaking({ readyAfter: 1, errored: ["b"] });

  const outcome = await runBatch(app.store, owner, { id: "s", name: "S", provider, model: "m" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.deepEqual(outcome.askedAgain, ["b"]);
  assert.equal(outcome.counts.unanswered, 0, "asking it again answered it");
  assert.equal(provider.calls.complete, 1);
});

test("nothing collectable at all still falls back to ordinary calls", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  const provider = setTaking({ readyAfter: 1, collectFails: true });

  const outcome = await runBatch(app.store, owner, { id: "s", name: "S", provider, model: "m" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(outcome.route, "direct");
  assert.match(outcome.reason, /could not be read/);
  assert.equal(provider.calls.complete, 3, "every question was still answered");
  assert.equal(outcome.counts.unanswered, 0);
});

/* ---------- the saving shows up in the usage figures ---------- */

test("what handing a set over saved shows up in the usage figures", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10, discount: 0.5 });
  const run = app.store.createRun(owner, "summarise the folder");
  const provider = setTaking({ readyAfter: 1 });

  const outcome = await runBatch(app.store, owner, { id: "s", name: "S", provider, model: "gpt-4o-mini" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait, runId: run.id });
  assert.ok(outcome.saved.amount > 0, "a set costs less than the same questions one at a time");

  const figures = batchSets(app.store, owner);
  assert.equal(figures.lines.length, 1);
  assert.equal(figures.lines[0].route, "batch");
  assert.equal(figures.lines[0].questions, 3);
  assert.equal(figures.batched, 3);
  assert.equal(figures.saved, outcome.saved.amount, "the Usage screen reads back the same saving");
  assert.ok(figures.saved > 0);
  // Half off: what the set cost plus what it saved is what the same questions cost one at a time.
  assert.ok(Math.abs(figures.spent - figures.saved) < 1e-9, "half the ordinary price, half saved");
});

test("a set the connection could not take is listed as saving nothing, with the reason", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  const run = app.store.createRun(owner, "summarise the folder");

  await runBatch(app.store, owner, { id: "p", name: "P", provider: setTaking({ none: true }), model: "gpt-4o-mini" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait, runId: run.id });

  const figures = batchSets(app.store, owner);
  assert.equal(figures.lines[0].route, "direct");
  assert.equal(figures.saved, 0, "nothing was saved and the screen does not pretend otherwise");
  assert.match(figures.lines[0].reason, /does not take a whole set/);
});

/* ---------- the two real adapters, against a fake service ---------- */

/** A fake `fetch` that answers the addresses a service really answers, and records what it was asked. */
function fakeService(routes) {
  const seen = [];
  return {
    seen,
    async fetch(url, init = {}) {
      seen.push({ url: String(url), method: init.method ?? "GET", body: init.body });
      for (const [match, reply] of routes) {
        if (!String(url).includes(match)) continue;
        const body = typeof reply === "function" ? reply(init) : reply;
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

test("the OpenAI adapter uploads the set, waits, and reads both answer files", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  let polls = 0;
  const service = fakeService([
    ["/files/file-out/content", [
      { custom_id: "a", response: { status_code: 200, body: { choices: [{ message: { content: "A." } }], usage: { prompt_tokens: 11, completion_tokens: 3 } } } },
      { custom_id: "b", response: { status_code: 200, body: { choices: [{ message: { content: "B." } }], usage: { prompt_tokens: 12, completion_tokens: 4 } } } },
    ].map((line) => JSON.stringify(line)).join("\n")],
    ["/files/file-err/content",
      JSON.stringify({ custom_id: "c", response: null, error: { message: "that question was too long" } })],
    ["/files", { id: "file-in" }],
    ["/batches/batch-9", () => {
      polls += 1;
      return polls < 2
        ? { id: "batch-9", status: "in_progress" }
        : { id: "batch-9", status: "completed", output_file_id: "file-out", error_file_id: "file-err" };
    }],
    ["/batches", { id: "batch-9", status: "validating" }],
    ["/chat/completions", { choices: [{ message: { content: "C., asked on its own." } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }],
  ]);
  const provider = new OpenAIProvider({
    endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "k", fetchImpl: service.fetch,
  });
  assert.equal(supportsBatch(provider), true, "api.openai.com does take a whole set");

  const outcome = await runBatch(app.store, owner, { id: "o", name: "OpenAI", provider, model: "gpt-4o-mini" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(outcome.route, "batch");
  assert.equal(outcome.batchId, "batch-9");
  assert.equal(outcome.answers.find((answer) => answer.id === "a").content, "A.");
  assert.equal(outcome.answers.find((answer) => answer.id === "b").content, "B.");
  // The third failed on its own; it was asked again rather than lost with the rest.
  assert.deepEqual(outcome.askedAgain, ["c"]);
  assert.equal(outcome.counts.batched, 2);
  assert.ok(service.seen.some((call) => call.url.includes("/files/file-out/content")), "the answers file was read");
  assert.ok(service.seen.some((call) => call.url.includes("/files/file-err/content")),
    "and so was the file of the ones that failed on their own");
  assert.ok(service.seen.some((call) => call.url.endsWith("/files") && call.method === "POST"), "the questions went up as a file");
  assert.ok(service.seen.some((call) => call.url.endsWith("/batches") && call.method === "POST"), "a set was created against it");
});

test("the Anthropic adapter hands the set over and reads the answers it is pointed at", async (t) => {
  const app = await fixture(t);
  const owner = app.runtime.owner;
  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });
  let polls = 0;
  const results = [
    { custom_id: "a", result: { type: "succeeded", message: { content: [{ type: "text", text: "A." }], usage: { input_tokens: 11, output_tokens: 3 } } } },
    { custom_id: "b", result: { type: "succeeded", message: { content: [{ type: "text", text: "B." }], usage: { input_tokens: 12, output_tokens: 4 } } } },
    { custom_id: "c", result: { type: "errored", error: { error: { message: "that question was refused" } } } },
  ].map((line) => JSON.stringify(line)).join("\n");
  const service = fakeService([
    ["/results", results],
    ["/messages/batches/msgbatch_1", () => {
      polls += 1;
      return polls < 2
        ? { id: "msgbatch_1", processing_status: "in_progress" }
        : { id: "msgbatch_1", processing_status: "ended", results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results" };
    }],
    ["/messages/batches", { id: "msgbatch_1", processing_status: "in_progress" }],
    ["/messages", { content: [{ type: "text", text: "C., asked on its own." }], usage: { input_tokens: 5, output_tokens: 2 } }],
  ]);
  const provider = new AnthropicProvider({
    endpoint: "https://api.anthropic.com/v1", model: "claude-sonnet-4", apiKey: "k", fetchImpl: service.fetch,
  });
  assert.equal(supportsBatch(provider), true);

  const outcome = await runBatch(app.store, owner, { id: "a", name: "Anthropic", provider, model: "claude-sonnet-4" },
    threeAsks, AbortSignal.timeout(5000), { sleep: noWait });

  assert.equal(outcome.route, "batch");
  assert.equal(outcome.answers.find((answer) => answer.id === "a").content, "A.");
  assert.deepEqual(outcome.askedAgain, ["c"], "the refused one was asked again on its own");
  const handover = service.seen.find((call) => call.method === "POST");
  const sent = JSON.parse(handover.body);
  assert.equal(sent.requests.length, 3, "all three went over in one request");
  assert.deepEqual(sent.requests.map((request) => request.custom_id), ["a", "b", "c"]);
});

test("a connection that only speaks the OpenAI shape is not claimed to take whole sets", () => {
  assert.equal(offersBatch("https://api.openai.com/v1", ["api.openai.com", ".openai.azure.com"]), true);
  assert.equal(offersBatch("https://my-shop.openai.azure.com/openai", ["api.openai.com", ".openai.azure.com"]), true);
  assert.equal(offersBatch("http://localhost:11434/v1", ["api.openai.com", ".openai.azure.com"]), false,
    "a model on this computer has no set endpoint and is not said to have one");
  assert.equal(offersBatch("https://api.groq.com/openai/v1", ["api.openai.com"]), false);
});

test("the address the answers are read from must be the service the owner configured", () => {
  assert.equal(sameHost("https://api.anthropic.com/v1", "https://api.anthropic.com/v1/x/results"),
    "https://api.anthropic.com/v1/x/results");
  assert.throws(() => sameHost("https://api.anthropic.com/v1", "https://somewhere-else.example/results"),
    /which is not api\.anthropic\.com/);
});

/* ---------- A0928: kept answers, checked honestly ---------- */

const keyParts = (over) => ({ provider: "p", model: "m", reasoning: null, maxTokens: 100, tools: [], ...over });

test("a request carrying a picture is never kept", async (t) => {
  const app = await fixture(t);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true });
  const cache = app.runtime.requestCache;
  const parts = keyParts({ messages: [{ role: "user", content: "what is this?", images: [{ data: "AAAA", mediaType: "image/png" }] }] });

  assert.equal(cache.keep(parts, { content: "A cat.", toolCalls: [] }), false);
  assert.equal(cache.look(parts), null, "and there is nothing to read back");
});

test("a request naming a saved secret is never kept, in its words or in a tool call", async (t) => {
  const app = await fixture(t);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true });
  const cache = app.runtime.requestCache;
  const answer = { content: "Done.", toolCalls: [] };

  const inWords = keyParts({ messages: [{ role: "user", content: "deploy with secret://default/DEPLOY_TOKEN" }] });
  assert.equal(cache.keep(inWords, answer), false);
  assert.equal(cache.look(inWords), null);

  // The place a secret reference really appears: the arguments of a tool call earlier in the round.
  const inArguments = keyParts({ messages: [
    { role: "user", content: "deploy it" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "process.start", arguments: '{"env":{"TOKEN":"secret://default/DEPLOY_TOKEN"}}' }] },
  ] });
  assert.equal(cache.keep(inArguments, answer), false, "a secret named in a tool call is a secret too");
  assert.equal(cache.look(inArguments), null);

  // The same conversation without the reference is kept as usual, so the rule is not simply "never".
  const clean = keyParts({ messages: [
    { role: "user", content: "deploy it" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "process.start", arguments: '{"env":{"TOKEN":"abc"}}' }] },
  ] });
  assert.equal(cache.keep(clean, answer), true);
  assert.equal(cache.look(clean).content, "Done.");
});

test("one profile cannot read another profile's kept answers", async (t) => {
  const app = await fixture(t);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true });
  const cache = app.runtime.requestCache;
  const parts = keyParts({ messages: [{ role: "user", content: "What is the capital of France?" }] });
  assert.equal(cache.keep(parts, { content: "Paris.", toolCalls: [] }), true);

  const other = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: other.id, pin: "4321" });
  assert.equal(cache.look(parts), null, "the other person's answer is not theirs to read");
  assert.equal(cache.keep(parts, { content: "Lyon.", toolCalls: [] }), true);

  app.store.profiles.switch({ profileId: null });
  assert.equal(cache.look(parts).content, "Paris.", "and neither profile has overwritten the other's");
});

test("an answer that asked for a tool is never replayed", async (t) => {
  const app = await fixture(t);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true });
  const cache = app.runtime.requestCache;
  const parts = keyParts({ messages: [{ role: "user", content: "list my files" }] });

  const askedForTool = { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{}" }] };
  assert.equal(cache.keep(parts, askedForTool), false, "replaying it would replay whatever the tool does");
  assert.equal(cache.look(parts), null);

  // The plain answer that follows is kept, and comes back with no tool call on it.
  assert.equal(cache.keep(parts, { content: "Three files.", toolCalls: [] }), true);
  assert.deepEqual(cache.look(parts), { content: "Three files.", toolCalls: [] });
});

/* ---------- the first real caller: summarising a whole knowledge base ---------- */

/** A folder with enough in it to need more than one part summarised. */
async function bigFolder(workspace) {
  await mkdir(join(workspace, "hr"), { recursive: true });
  for (let file = 0; file < 4; file += 1) {
    const sections = [];
    for (let at = 0; at < 10; at += 1)
      sections.push(`## Rule ${file}.${at}\n\n${"Staff are entitled to the thing described in this rule. ".repeat(20)}\n`);
    await writeFile(join(workspace, `hr/rules-${file}.md`), `# Rules ${file}\n\n${sections.join("\n")}`);
  }
}

/** A connection that answers ordinarily and also takes whole sets, for the summary tests. */
function summarising() {
  const calls = { submit: 0, complete: 0 };
  const provider = {
    name: "fake", calls, requests: [],
    async complete(request) {
      calls.complete += 1;
      provider.requests.push(request);
      return { content: "- Staff get twenty days of leave [1]", toolCalls: [], usage: { input: 9, output: 3 } };
    },
    batch: () => ({
      async submit(requests) { calls.submit += 1; provider.sent = requests; return { batchId: "set-1" }; },
      async poll() { return { status: "completed" }; },
      async collect() {
        return provider.sent.map((request) => ({
          id: request.id, content: "- Staff get twenty days of leave [1]", usage: { input: 10, output: 4 },
        }));
      },
    }),
  };
  return provider;
}

async function knowledgeFixture(t, provider) {
  const base = await mkdtemp(join(tmpdir(), "branch-faster-kb-"));
  const workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(base, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discard(base); });
  await bigFolder(workspace);
  const made = app.knowledgeParts.bases.create(app.runtime.owner, { name: "HR", sources: [{ kind: "folder", path: "hr" }] });
  await app.knowledgeParts.bases.reindex(app.runtime.owner, made.id);
  return { app, collection: made.id };
}

test("summarising a knowledge base sends its parts as one set", async (t) => {
  const provider = summarising();
  const { app, collection } = await knowledgeFixture(t, provider);
  saveBatchSettings(app.store, app.runtime.owner, { enabled: true, pollMs: 10 });

  const summary = await app.knowledgeParts.summaries.summarise(app.runtime.owner, { collection });

  assert.ok(summary.batches > 1, "there was more than one part to summarise");
  assert.equal(provider.calls.submit, 1, "the parts went over together rather than one after another");
  assert.equal(provider.calls.complete, 1, "only the final drawing-together was an ordinary call");
  assert.match(summary.summary, /Sources/);
  assert.match(summary.summary, /\[1\]/);
});

test("with sets switched off the summary is written the ordinary way, word for word the same", async (t) => {
  const offProvider = summarising();
  const off = await knowledgeFixture(t, offProvider);
  const plain = await off.app.knowledgeParts.summaries.summarise(off.app.runtime.owner, { collection: off.collection });

  assert.equal(offProvider.calls.submit, 0, "nothing is handed over until the owner asks for it");
  assert.equal(offProvider.calls.complete, plain.batches + 1, "each part, then the drawing-together");
  assert.match(plain.summary, /Sources/);
  // Every part was asked for with the same ceiling the one-at-a-time road always used.
  assert.ok(offProvider.requests.every((request) => request.maxTokens === 500 || request.maxTokens === 900));

  // The same folder, the same answers, with sets switched on: the summary must read identically.
  const onProvider = summarising();
  const on = await knowledgeFixture(t, onProvider);
  saveBatchSettings(on.app.store, on.app.runtime.owner, { enabled: true, pollMs: 10 });
  const batched = await on.app.knowledgeParts.summaries.summarise(on.app.runtime.owner, { collection: on.collection });

  assert.equal(onProvider.calls.submit, 1);
  assert.equal(batched.batches, plain.batches);
  assert.equal(batched.summary, plain.summary, "whichever road the parts took, the summary is the same");
});

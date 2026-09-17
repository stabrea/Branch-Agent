/**
 * A second opinion before it commits: the advisor pass, two connections arguing, and answers in a
 * declared shape. Every model here is a fake; nothing in this file reaches a real service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "../dist/server.js";
import {
  createBranch, Budget, declareShape, askInShape, runDebate, readAdvice, adviceLine,
  saveSecondOpinionSettings, secondOpinionSettings, openaiBody, anthropicBody, shapeInstructions,
} from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

/** A connection whose answer is chosen from the words it was sent. Counts every call it takes. */
function scripted(name, reply) {
  const provider = { name, calls: 0, requests: [], async complete(request) {
    provider.calls += 1;
    provider.requests.push(request);
    const last = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = request.messages[0]?.content ?? "";
    return reply({ last, system, request, at: provider.calls });
  } };
  return provider;
}
async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-second-opinion-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root };
}
const events = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);

/* ------------------------------------------------------------------ the advisor pass */

test("the advisor is off by default: no second connection is asked and nothing is written down", async (t) => {
  const worker = scripted("worker", () => say("the answer"));
  const advisor = scripted("advisor", () => say('{"stands":"no"}'));
  const { app } = await fixture(t, [
    { id: "worker", name: "Worker", provider: worker, model: "w-1" },
    { id: "advisor", name: "Advisor", provider: advisor, model: "a-1" },
  ]);
  assert.equal(secondOpinionSettings(app.store, "local").advisor, false, "off until the owner turns it on");
  const run = await app.runtime.run({ prompt: "what is the capital of France" });
  assert.equal(run.output, "the answer");
  assert.equal(advisor.calls, 0, "the second connection was never asked");
  assert.deepEqual(events(app, run.id, "advice.given"), []);
  assert.equal(app.runtime.advice(run.id), null);
});

test("the advisor runs on the second connection, its cost lands on the task, and the answer is untouched", async (t) => {
  const worker = scripted("worker", () => say("Paris is the capital of France."));
  const advisor = scripted("advisor", () =>
    say('{"stands":"unsure","why":"It gives no source.","check":["whether a source is named"]}'));
  const { app } = await fixture(t, [
    { id: "worker", name: "Worker", provider: worker, model: "w-1" },
    { id: "advisor", name: "Advisor", provider: advisor, model: "a-1" },
  ]);
  saveSecondOpinionSettings(app.store, "local", { advisor: true, advisorPreset: "advisor", advisorMaxTokens: 5000 });

  const before = app.store.usageStore().getMonthlyStats?.()?.currentMonthlyTokens ?? null;
  const run = await app.runtime.run({ prompt: "what is the capital of France" });

  assert.equal(worker.calls, 1, "the task itself was answered once");
  assert.equal(advisor.calls, 1, "the advisor ran, and on the other connection");
  assert.equal(run.output, "Paris is the capital of France.",
    "the advice is never written into the answer");
  assert.ok(!run.output.includes("source"), "nothing the advisor said leaked into the answer");

  const advice = app.runtime.advice(run.id);
  assert.equal(advice.stands, "unsure");
  assert.equal(advice.preset, "Advisor", "the owner can see it was not the connection that answered");
  assert.deepEqual(advice.check, ["whether a source is named"]);
  assert.match(advice.line, /Advisor is not sure about this\./);

  // The cost lands on the task: the advisor's round is recorded against this run like any other.
  const rounds = events(app, run.id, "model.completed");
  assert.equal(rounds.length, 2, "both the answer and the advice are rounds of this task");
  assert.ok(rounds.some((round) => round.preset === "advisor"), "the advisor's round names the advisor");
  const usage = app.store.usage(run.id);
  assert.ok((usage.estimatedInput || 0) > 0 && (usage.estimatedOutput || 0) > 0,
    "the task's own usage figures carry the advisor pass");
  assert.notEqual(before, undefined);
});

test("the advice is shown beside the answer on the Look inside screen, not inside it", async (t) => {
  const worker = scripted("worker", () => say("Ship on Friday."));
  const advisor = scripted("advisor", () =>
    say('{"stands":"no","why":"Friday leaves nobody to fix it.","check":["who is on call at the weekend"]}'));
  const { app, root } = await fixture(t, [
    { id: "worker", name: "Worker", provider: worker, model: "w-1" },
    { id: "advisor", name: "Advisor", provider: advisor, model: "a-1" },
  ]);
  saveSecondOpinionSettings(app.store, "local", { advisor: true, advisorPreset: "advisor" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const get = async (path) => {
    const response = await fetch(`${server.url}/api/${path}`,
      { headers: { authorization: `Bearer ${server.token}`, origin: server.url } });
    assert.ok(response.ok, `${path} answered ${response.status}`);
    return response.json();
  };

  const run = await app.runtime.run({ prompt: "should we ship on Friday" });
  const view = await get(`runs/${run.id}/inspect`);
  assert.equal(view.run.output, "Ship on Friday.", "the answer on the screen is the answer that was given");
  assert.ok(!view.run.output.includes("on call"), "the advice is not part of the answer");
  assert.equal(view.advice.stands, "no");
  assert.match(view.advice.line, /Advisor does not think this stands up\. Friday leaves nobody to fix it\./);
  assert.match(view.advice.line, /It would check: who is on call at the weekend\./);

  const details = await get(`runs/${run.id}`);
  assert.equal(details.advice.stands, "no");
  assert.equal(details.run.output, "Ship on Friday.");

  // Turning it off again leaves the next answer with nothing beside it.
  saveSecondOpinionSettings(app.store, "local", { advisor: false });
  const second = await app.runtime.run({ prompt: "and Monday" });
  assert.equal((await get(`runs/${second.id}/inspect`)).advice, null);
});

test("the advisor never fails a task that has already answered", async (t) => {
  const worker = scripted("worker", () => say("done"));
  const advisor = scripted("advisor", () => { throw new Error("the advisor connection is down"); });
  const { app } = await fixture(t, [
    { id: "worker", name: "Worker", provider: worker, model: "w-1" },
    { id: "advisor", name: "Advisor", provider: advisor, model: "a-1" },
  ]);
  saveSecondOpinionSettings(app.store, "local", { advisor: true, advisorPreset: "advisor" });
  const run = await app.runtime.run({ prompt: "anything" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "done");
  assert.match(events(app, run.id, "advice.failed")[0].reason, /the advisor connection is down/);
  assert.equal(app.runtime.advice(run.id), null);
});

test("the advisor stops at its own cost ceiling and says so, leaving the answer as it was", async (t) => {
  const worker = scripted("worker", () => say("Paris."));
  const advisor = scripted("advisor", () => say('{"stands":"yes"}'));
  const { app } = await fixture(t, [
    { id: "worker", name: "Worker", provider: worker, model: "w-1" },
    { id: "advisor", name: "Advisor", provider: advisor, model: "a-1" },
  ]);
  saveSecondOpinionSettings(app.store, "local",
    { advisor: true, advisorPreset: "advisor", advisorMaxTokens: 200 });
  const run = await app.runtime.run({ prompt: "tell me at length about the capital of France ".repeat(20) });

  assert.equal(advisor.calls, 0, "nothing was sent once the ceiling could not cover the check");
  assert.equal(run.status, "completed", "a ceiling reached by the check never fails the task");
  assert.equal(run.output, "Paris.", "the answer is given exactly as it was");
  const failed = events(app, run.id, "advice.failed")[0];
  assert.match(failed.reason, /^There was not enough left of the 200-token ceiling for the check/);
  assert.match(failed.reason, /Raise it in Settings\.$/);
  assert.ok(!/BudgetError|undefined|\{/.test(failed.reason), "it reads as a sentence, not an error object");
  assert.equal(app.runtime.advice(run.id), null, "no advice is shown when none was given");

  // With room to work in, the very same setup does produce advice.
  saveSecondOpinionSettings(app.store, "local",
    { advisor: true, advisorPreset: "advisor", advisorMaxTokens: 20000 });
  const second = await app.runtime.run({ prompt: "and the capital of Spain" });
  assert.equal(advisor.calls, 1);
  assert.equal(app.runtime.advice(second.id).stands, "yes");
});

test("an advisor whose reply cannot be read says so rather than being dropped", () => {
  const advice = readAdvice("Advisor", "I think it's fine, honestly");
  assert.equal(advice.stands, "unsure");
  assert.match(advice.why, /could not be read/);
  assert.match(adviceLine(advice), /^Advisor is not sure about this\./);
  const good = readAdvice("Advisor", '```json\n{"stands":"yes","why":"It checks out.","check":["a","b","c","d"]}\n```');
  assert.equal(good.stands, "yes");
  assert.equal(good.check.length, 3, "at most three things to check");
  assert.match(adviceLine(good), /thinks this stands up\. It checks out\. It would check: a; b; c\./);
});

/* ------------------------------------------------------------------ two models arguing */

test("a debate stops at its bound: one exchange each unless the owner raises it", async () => {
  const asked = [];
  const ask = async (side, question) => { asked.push({ side, question }); return { text: `${side} says so`, spent: 10 }; };
  const one = await runDebate(ask, { question: "is it worth it", sides: ["alpha", "beta"] },
    { exchanges: 1, maxTokens: 100000 });
  assert.equal(one.exchanges, 1, "exactly one exchange each");
  assert.equal(one.turns.filter((turn) => turn.kind === "opening").length, 2);
  assert.equal(one.turns.filter((turn) => turn.kind === "rebuttal").length, 2);
  assert.equal(asked.length, 4, "two openings and one rebuttal each: no more");
  assert.match(one.stoppedBecause, /stopped after its 1 allowed exchange\(s\)/);
  assert.match(one.verdict, /alpha and beta answered on their own first\./);
  assert.match(one.verdict, /still open/);

  asked.length = 0;
  const raised = await runDebate(ask, { question: "q", sides: ["alpha", "beta"], exchanges: 3 },
    { exchanges: 3, maxTokens: 100000 });
  assert.equal(raised.exchanges, 3);
  assert.equal(asked.length, 8, "two openings and three rebuttals each");
  assert.match(raised.stoppedBecause, /3 allowed exchange\(s\)/);
});

test("a task may not talk its way past the owner's bound", async () => {
  const ask = async (side) => ({ text: `${side} says so`, spent: 1 });
  const capped = await runDebate(ask, { question: "q", sides: ["a", "b"], exchanges: 3 },
    { exchanges: 1, maxTokens: 100000 });
  assert.equal(capped.exchanges, 1, "the owner's setting is the ceiling, not the caller's wish");
});

test("a debate stops at its cost ceiling and says so in a plain sentence", async () => {
  let calls = 0;
  const ask = async (side) => { calls += 1; return { text: `${side} says so`, spent: 400 }; };
  const outcome = await runDebate(ask, { question: "q", sides: ["alpha", "beta"], exchanges: 3 },
    { exchanges: 3, maxTokens: 1000 });
  assert.equal(calls, 3, "nothing was sent once the running total reached the ceiling");
  assert.equal(outcome.spent, 1200);
  assert.match(outcome.stoppedBecause,
    /^The debate stopped after \d+ exchange\(s\): it had spent about [\d,]+ tokens against a ceiling of 1,000\./);
  assert.match(outcome.stoppedBecause, /Raise the debate spending ceiling in Settings/);
  assert.ok(!/undefined|NaN|\[object/.test(outcome.stoppedBecause), "the sentence reads as a sentence");
  assert.match(outcome.verdict, /ceiling of 1,000/, "the verdict carries the reason it stopped");
});

test("a debate that cannot afford even its opening stops without sending anything", async () => {
  let calls = 0;
  const ask = async () => { calls += 1; return { text: "x", spent: 5000 }; };
  const outcome = await runDebate(ask, { question: "q", sides: ["a", "b"] }, { exchanges: 1, maxTokens: 1000 });
  assert.equal(calls, 1, "the first side answered, the second was never asked");
  assert.equal(outcome.exchanges, 0);
  assert.match(outcome.stoppedBecause, /ceiling of 1,000/);
});

test("the debate tool runs both connections, charges the task, and refuses an unknown one", async (t) => {
  const alpha = scripted("alpha", () => say("alpha thinks yes"));
  const beta = scripted("beta", () => say("beta thinks no"));
  const { app } = await fixture(t, [
    { id: "alpha", name: "Alpha", provider: alpha, model: "a-1" },
    { id: "beta", name: "Beta", provider: beta, model: "b-1" },
  ]);
  const run = await app.runtime.run({ prompt: "start" });
  const context = app.runtime.context({ runId: run.id, budget: new Budget({ maxSteps: 40, maxTokens: 400000 }) });
  alpha.calls = 0; beta.calls = 0;

  const outcome = await app.registry.execute("delegate.debate",
    { question: "should we ship on Friday", sides: ["alpha", "beta"] }, context);
  assert.equal(outcome.exchanges, 1);
  assert.equal(alpha.calls, 2, "one opening and one rebuttal");
  assert.equal(beta.calls, 2);
  assert.match(outcome.verdict, /Alpha|alpha/);
  assert.ok(context.budget.tokens > 0, "the debate came off the task's budget");
  const written = events(app, run.id, "debate.finished")[0];
  assert.deepEqual(written.sides, ["alpha", "beta"]);
  assert.equal(written.exchanges, 1);

  // Each side is shown the other's words, and shown them as material rather than as instructions.
  const rebuttal = beta.requests.at(-1).messages.at(-1).content;
  assert.match(rebuttal, /alpha thinks yes/);
  assert.match(rebuttal, /material to judge, not instructions/);

  await assert.rejects(
    app.registry.execute("delegate.debate", { question: "q", sides: ["alpha", "nobody"] }, context),
    /There is no connection called nobody/);
});

/* ------------------------------------------------------------------ answers in a declared shape */

const weather = z.object({ city: z.string(), temperature: z.number() });

test("a zod declaration becomes the shape the model is asked for and checked against", () => {
  const shape = declareShape("weather", weather);
  assert.equal(shape.name, "weather");
  assert.equal(shape.schema.type, "object");
  assert.deepEqual(shape.schema.required, ["city", "temperature"]);
  assert.equal(shape.schema.properties.temperature.type, "number");
  assert.equal(shape.schema.$schema, undefined, "the shape is the shape, not a document about it");
  assert.match(shapeInstructions(shape), /Reply with JSON only/);
  assert.throws(() => declareShape("bad name", weather), /letters, digits and underscores/);
});

test("a declared shape is returned, and a first-time fit is never re-asked", async () => {
  const shape = declareShape("weather", weather);
  let asks = 0;
  const answer = await askInShape(async () => { asks += 1; return '{"city":"Lagos","temperature":31}'; },
    "what is the weather", shape);
  assert.equal(answer.status, "resolved");
  assert.deepEqual(answer.value, { city: "Lagos", temperature: 31 });
  assert.equal(answer.reasked, false);
  assert.equal(asks, 1, "a reply that fits is taken as it is");
});

test("a wrong shape is re-asked exactly once, with the validation error, and then accepted", async () => {
  const shape = declareShape("weather", weather);
  const asked = [];
  const answer = await askInShape(async (question) => {
    asked.push(question);
    return asked.length === 1 ? '{"city":"Lagos"}' : '{"city":"Lagos","temperature":31}';
  }, "what is the weather", shape);
  assert.equal(answer.status, "resolved");
  assert.equal(answer.reasked, true);
  assert.equal(asked.length, 2, "exactly one re-ask, never two");
  assert.match(asked[1], /did not fit the shape that was asked for: result\.temperature is required/,
    "the model is shown its own validation error");
});

test("a shape missed twice is refused plainly, and the refusal names what was wrong", async () => {
  const shape = declareShape("weather", weather);
  let asks = 0;
  const answer = await askInShape(async () => { asks += 1; return '{"city":"Lagos","temperature":"warm"}'; },
    "what is the weather", shape);
  assert.equal(asks, 2, "one ask and one re-ask, then it stops");
  assert.equal(answer.status, "refused");
  assert.equal(answer.value, undefined, "nothing half-parsed is handed back");
  assert.match(answer.reason, /asked for as weather/, "the refusal names the shape");
  assert.match(answer.reason, /result\.temperature must be a number/, "the refusal names what was wrong");
  assert.match(answer.reason, /Nothing was guessed at/);
  assert.ok(!/\{|\}|Error:/.test(answer.reason.replace(/result\.\w+/g, "")), "it reads as a sentence, not a stack");
});

test("a reply that is not JSON at all is named as that, and refused after one re-ask", async () => {
  const shape = declareShape("weather", weather);
  const answer = await askInShape(async () => "It is quite warm in Lagos today.", "weather", shape);
  assert.equal(answer.status, "refused");
  assert.match(answer.reason, /The answer was not valid JSON/);
});

test("a shaped ask goes through the whole runtime, using the shape and the same one re-ask", async (t) => {
  const model = scripted("shaper", ({ at }) =>
    say(at === 1 ? "{}" : '{"city":"Lagos","temperature":31}'));
  const { app } = await fixture(t, [{ id: "shaper", name: "Shaper", provider: model, model: "s-1" }]);
  const run = await app.runtime.run({ prompt: "start" });
  const context = app.runtime.context({ runId: run.id, budget: new Budget({ maxSteps: 40, maxTokens: 400000 }) });
  model.calls = 0; model.requests.length = 0;

  const shape = declareShape("weather", weather);
  const answer = await app.runtime.shaped(run, context, "the weather in Lagos", shape);
  assert.equal(answer.status, "resolved");
  assert.deepEqual(answer.value, { city: "Lagos", temperature: 31 });
  assert.equal(model.calls, 2, "one ask, one re-ask");
  assert.deepEqual(model.requests[0].responseFormat, { name: "weather", schema: shape.schema },
    "the connection is told the shape, not only asked for it in words");
  assert.deepEqual(model.requests[0].tools, [], "a shaped ask carries no tools, so both services can fix the shape");
  const written = events(app, run.id, "answer.shaped").at(-1);
  assert.deepEqual(written, { shape: "weather", status: "resolved", reasked: true });
});

test("a delegated task that declares a shape is re-asked once and then refused in plain words", async (t) => {
  const model = scripted("shaper", ({ last }) =>
    say(last.includes("send the same content in the right shape") ? "still not json" : "not json either"));
  const { app } = await fixture(t, [{ id: "shaper", name: "Shaper", provider: model, model: "s-1" }]);
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id, budget: new Budget({ maxSteps: 40, maxTokens: 400000 }) });
  const shape = declareShape("weather", weather);

  const { run, result } = await app.runtime.delegateChecked("the weather", context, [], "Answer.", { shape });
  assert.equal(run.status, "completed", "the child itself finished; only the shape was missed");
  assert.equal(result.status, "unresolved");
  assert.match(result.reason, /asked for as weather and came back in the wrong shape twice/);
  assert.match(result.reason, /The answer was not valid JSON/);
  assert.ok(app.store.events(parent.id).some((e) => e.kind === "delegation.unresolved"));
  const child = model.requests.find((request) =>
    request.messages.some((message) => message.content.includes("Reply with JSON only")));
  assert.ok(child, "the child was told the shape it had to answer in");
});

/* ------------------------------------------------------------------ both providers */

test("OpenAI is given its own json_schema setting; Anthropic is given the tool it must call", () => {
  const shape = declareShape("weather", weather);
  const request = { messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 500,
    signal: AbortSignal.timeout(1000), responseFormat: { name: shape.name, schema: shape.schema } };

  const openai = openaiBody(request, "gpt-x");
  assert.deepEqual(openai.response_format,
    { type: "json_schema", json_schema: { name: "weather", schema: shape.schema } });

  const anthropic = anthropicBody(request, "claude-x");
  assert.deepEqual(anthropic.tool_choice, { type: "tool", name: "weather" });
  assert.equal(anthropic.tools.length, 1);
  assert.equal(anthropic.tools[0].name, "weather");
  assert.deepEqual(anthropic.tools[0].input_schema, shape.schema);

  // A request that already has tools keeps them: Anthropic's way of fixing a shape is a tool, and
  // taking a task's tools away to get one would be a worse trade than asking in words.
  const withTools = { ...request, tools: [{ name: "files.read", description: "read", parameters: {} }] };
  const kept = anthropicBody(withTools, "claude-x");
  assert.equal(kept.tool_choice, undefined, "no tool is forced when the task has tools of its own");
  assert.equal(kept.tools.length, 1);
  assert.notEqual(kept.tools[0].name, "weather", "the task's own tool is kept, not replaced by the shape");
  assert.equal(openaiBody({ ...request, responseFormat: undefined }, "gpt-x").response_format, undefined);
});

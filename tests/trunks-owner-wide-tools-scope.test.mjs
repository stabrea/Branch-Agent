/**
 * FQ-routing.isolated-agents, from the Claude NAS adversarial review at a32527d. Four tools still
 * reached past a Trunk's own scope:
 *
 * - memory.put ended any earlier fact with the same entity and attribute, so Bo saving
 *   "launch / day" set a validTo on Ada's own fact about it. It now ends only facts the writer
 *   may change (`writableTo`), and the owner's own put still ends any.
 * - history.search / history.read reached every conversation of the owner, Ada's Trunk Chat too.
 *   A Trunk now sees only the conversations it answered in (its `trunk.turn` events).
 * - todos.list / add / done are the owner's one list with no scope, so an agent is refused.
 * - learning.suggest named memory ids learned over the owner's whole memory; for an agent they are
 *   cut to the facts it may read (`visibleTo`).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { FlyCore } from "../dist/fly-core/hook.js";
import { Circuit } from "../dist/fly-core/circuit.js";
import { suggestToolName } from "../dist/fly-core/settings.js";

function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

/** Rules keyed on the whole user message; `args` is read when the rule fires, so a test can fill it in later. */
function rules(table) {
  return [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "").trim();
    const entry = table[text];
    return entry ? call(entry.tool, typeof entry.args === "function" ? entry.args() : entry.args) : null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
}

async function twoTrunks(t, table) {
  const { app } = await fixture(t, rules(table));
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  return { app, ada, bo };
}

test("Bo's memory.put about the same entity and detail never ends Ada's own fact", async (t) => {
  const bosFact = { text: "Bo: the launch is on Tuesday", source: "Bo's notes", entity: "launch", attribute: "day" };
  const { app, ada, bo } = await twoTrunks(t, { "remember the launch day": { tool: "memory.put", args: bosFact } });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.write", "memory.read"] });
  const earlier = "2026-01-01T00:00:00.000Z";
  app.store.save("memory", "local", "ada-launch", { text: "Ada: the launch is on Monday", source: "Ada's notes",
    entity: "launch", attribute: "day", validFrom: earlier, scope: `agent:trunk:${ada.id}` });
  app.store.save("memory", "local", "bo-launch", { text: "Bo: the launch is on Friday", source: "Bo's notes",
    entity: "launch", attribute: "day", validFrom: earlier, scope: `agent:trunk:${bo.id}` });

  const run = await app.trunks.say(bo.id, "remember the launch day");
  const outcome = toolOutcome(app, run.runId, "memory.put");
  assert.equal(outcome.ok, true, outcome.error);
  assert.equal(outcome.result.staged, undefined, "saved for real, not waiting as a suggestion");
  assert.equal(outcome.result.data.scope, `agent:trunk:${bo.id}`);

  assert.equal(app.store.get("memory", "local", "ada-launch").data.validTo, undefined, "Ada's fact is not ended by Bo");
  const adas = await app.registry.execute("memory.at", { entity: "launch", attribute: "day" },
    { ...app.runtime.context(), agent: `trunk:${ada.id}` });
  assert.deepEqual(adas.map((fact) => fact.id), ["ada-launch"], "memory.at for Ada still returns hers");
  // Not a vacuous pass: Bo's own earlier fact about it is ended, as before.
  const bosEnd = app.store.get("memory", "local", "bo-launch").data.validTo;
  assert.ok(bosEnd && bosEnd > earlier && bosEnd <= outcome.result.createdAt, "Bo's own earlier fact ends when his new one starts");

  // The owner's own put still ends any earlier fact, whosever it is.
  app.store.save("memory", "local", "owner-launch", { text: "The launch is on Wednesday", source: "owner", entity: "launch", attribute: "day" });
  assert.ok(app.store.get("memory", "local", "ada-launch").data.validTo, "the owner's newer fact ends Ada's");
});

test("history.search and history.read reach only the conversations a Trunk answered in", async (t) => {
  const table = {
    "look back": { tool: "history.search", args: { query: "zephyrquill" } },
    "read it": { tool: "history.read", args: () => target },
  };
  let target;
  const { app, ada, bo } = await twoTrunks(t, table);
  await app.trunks.say(ada.id, "The launch codename is zephyrquill, keep it quiet");
  await app.trunks.say(bo.id, "My own codename is zephyrquill too, for my notes");
  const adaChat = ada.chatSessionId, boChat = bo.chatSessionId;
  const everything = app.store.searchHistory("local", { query: "zephyrquill" });
  const adas = everything.find((hit) => hit.sessionId === adaChat);
  assert.ok(adas, "the owner still finds Ada's message");
  assert.ok(everything.some((hit) => hit.sessionId === boChat), "and Bo's");
  target = { sessionId: adaChat, messageId: adas.messageId };

  // Bo searches from his own Trunk Chat, which is left out as the conversation he is in.
  const searched = await app.trunks.say(bo.id, "look back");
  const search = toolOutcome(app, searched.runId, "history.search");
  assert.equal(search.ok, true, search.error);
  const text = JSON.stringify(search.result);
  assert.ok(!text.includes(adaChat), "Ada's conversation id never reaches Bo");
  assert.doesNotMatch(text, /keep it quiet/, "nor her words");

  const read = await app.trunks.say(bo.id, "read it");
  const reading = toolOutcome(app, read.runId, "history.read");
  assert.equal(reading.ok, false, "Bo cannot read Ada's message by id");
  assert.match(reading.error, /Historical message not found/, "refused exactly as a missing message is");

  // Not a vacuous pass: Ada's own conversation is hers to look back on, from anywhere but itself.
  const asAda = app.store.searchHistory("local", { query: "zephyrquill" }, "", `trunk:${ada.id}`);
  assert.deepEqual([...new Set(asAda.map((hit) => hit.sessionId))], [adaChat]);
  assert.equal(app.store.readHistory("local", target, "", `trunk:${ada.id}`).sessionId, adaChat);
  // A delegated specialist has no conversation of its own to look back on.
  assert.deepEqual(app.store.searchHistory("local", { query: "zephyrquill" }, "", "researcher"), []);
});

test("a Trunk is refused the owner's to-do list, and the owner's list is left as it was", async (t) => {
  let ownersId;
  const { app, bo } = await twoTrunks(t, {
    "list the to-dos": { tool: "todos.list", args: { includeDone: true } },
    "add a to-do": { tool: "todos.add", args: { text: "Bo was here" } },
    "tick it": { tool: "todos.done", args: () => ({ id: ownersId }) },
  });
  const owners = app.todos.add("local", { text: "Ring the plumber about the boiler" });
  ownersId = owners.id;

  const listed = await app.trunks.say(bo.id, "list the to-dos");
  const list = toolOutcome(app, listed.runId, "todos.list");
  assert.equal(list.ok, false, "todos.list is refused");
  assert.match(list.error, /belongs to the owner/);
  assert.doesNotMatch(JSON.stringify(app.store.events(listed.runId)), /plumber/, "the owner's to-do never reaches Bo");
  for (const [said, tool] of [["add a to-do", "todos.add"], ["tick it", "todos.done"]]) {
    const run = await app.trunks.say(bo.id, said);
    const outcome = toolOutcome(app, run.runId, tool);
    assert.equal(outcome.ok, false, `${tool} is refused`);
    assert.match(outcome.error, /memory\.put/, "and told where to keep its own notes");
  }
  const after = app.todos.list("local", { includeDone: true });
  assert.deepEqual(after.map((todo) => [todo.text, todo.done]), [["Ring the plumber about the boiler", false]]);
  // The owner's own task still reads and writes the list.
  const mine = await app.registry.execute("todos.list", { includeDone: true }, app.runtime.context());
  assert.deepEqual(mine.todos.map((todo) => todo.id), [ownersId]);
});

test("learning.suggest names only the memories the asking agent may read", async (t) => {
  const { app, ada, bo } = await twoTrunks(t, {});
  app.learningCore.configure({ mode: "on" });
  const put = (id, scope) => app.store.save("memory", "local", id, { text: `fact ${id}`, source: "seed", scope });
  put("ada-good", `agent:trunk:${ada.id}`); put("ada-bad", `agent:trunk:${ada.id}`);
  put("bo-good", `agent:trunk:${bo.id}`); put("shared-good", "shared"); put("owner-good", "private");
  const request = "plan the launch party";
  const core = new FlyCore(app.store);
  const code = core.code("local", { prompt: request }), circuit = new Circuit(), now = Date.now();
  for (let at = 0; at < 3; at += 1) for (const id of ["ada-good", "bo-good", "shared-good", "owner-good", "ada-bad"])
    circuit.learn(code, [{ action: id, kind: "memory", step: 1 }], id === "ada-bad" ? -1 : 1, now);
  core.state.save("local", [...circuit.actions.values()]);

  const ids = (answer) => [...answer.memories.map((s) => s.name), ...answer.avoid.map((s) => s.name),
    ...answer.memoryAdvice.strengthen, ...answer.memoryAdvice.fade].join(" ");
  const owners = await app.registry.execute(suggestToolName, { request }, app.runtime.context());
  for (const id of ["ada-good", "ada-bad", "bo-good", "shared-good", "owner-good"])
    assert.match(ids(owners), new RegExp(id), `the owner still hears about ${id}`);

  const bos = await app.registry.execute(suggestToolName, { request }, { ...app.runtime.context(), agent: `trunk:${bo.id}` });
  const named = ids(bos);
  for (const id of ["ada-good", "ada-bad", "owner-good"]) assert.doesNotMatch(named, new RegExp(id), `${id} never reaches Bo`);
  assert.match(named, /bo-good/, "Bo's own fact is still named");
  assert.match(named, /shared-good/, "and a shared one he may read");
  assert.ok(Array.isArray(bos.tools), "tools and skills are left as they are");
});

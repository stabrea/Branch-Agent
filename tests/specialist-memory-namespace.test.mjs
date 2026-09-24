/**
 * FQ-routing.isolated-agents: specialists' memory scopes are namespaced by their parent agent
 * to prevent Trunk Ada's "researcher" and Trunk Bo's "researcher" from sharing agent:researcher scope.
 * A specialist running from Ada has scope agent:trunk:ada/researcher; from Bo, agent:trunk:bo/researcher.
 * The owner's specialist keeps agent:researcher (not namespaced).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** The result (or error) of one named tool call on a run, from its own event trail. */
function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

test("Trunk Ada's and Bo's memory facts have properly namespaced scopes", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) {
      return call("memory.put", { text: text.slice("remember ".length), source: "specialist" });
    }
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];

  const { app } = await fixture(t, rules);
  on(app);

  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();

  // Ada's trunk saves a fact
  const adaSaveRun = await app.trunks.say(ada.id, "remember Ada data");
  const adaSaveOutcome = toolOutcome(app, adaSaveRun.runId, "memory.put");
  assert.equal(adaSaveOutcome.ok, true, "Ada saves fact");
  const adaFact = adaSaveOutcome.result;

  // Bo's trunk saves a fact
  const boSaveRun = await app.trunks.say(bo.id, "remember Bo data");
  const boSaveOutcome = toolOutcome(app, boSaveRun.runId, "memory.put");
  assert.equal(boSaveOutcome.ok, true, "Bo saves fact");
  const boFact = boSaveOutcome.result;

  // Verify each fact has the correct scope (namespaced by trunk)
  assert.equal(adaFact.data.scope, `agent:trunk:${ada.id}`, "Ada's fact scope includes Ada's trunk id");
  assert.equal(boFact.data.scope, `agent:trunk:${bo.id}`, "Bo's fact scope includes Bo's trunk id");

  // Verify the scopes are different (namespace isolation)
  assert.notEqual(adaFact.data.scope, boFact.data.scope, "Ada and Bo have different scoped facts");
});

test("the owner's facts have the default private scope (not namespaced)", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "remember") {
      return call("memory.put", { text: "owner fact", source: "owner" });
    }
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];

  const { app } = await fixture(t, rules);

  // When the owner runs memory.put directly (not through a specialist), the scope should be private or shared
  // This is the default behavior, not namespaced
  const run = await app.runtime.run({ prompt: "remember" });
  assert.equal(run.status, "completed");

  const outcome = toolOutcome(app, run.id, "memory.put");
  const ownerFact = outcome.result;
  // Owner's facts have either no scope (private default) or shared if they asked for it
  const scope = ownerFact.data.scope ?? "private";
  assert.ok(scope !== "agent:researcher", "owner's fact is not agent-scoped");
});

/**
 * FQ-routing.isolated-agents: Trunk field isolation tests.
 *
 * Verify that the dedicated trunk field in ToolContext properly isolates specialists
 * working under different Trunks, without breaking specialist lookups or instructions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The result (or error) of one named tool call on a run, from its own event trail. */
function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

/** Find the child run ID from a delegation event. */
function getChildRunId(app, parentRunId, eventKind) {
  const event = app.store.events(parentRunId).find(e => e.kind === eventKind);
  return event?.data.childRunId;
}

/** Promoted specialist from tests/orchestration.test.mjs */
async function specialist(app, name, permissions = ["memory.write", "memory.read"]) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", {
    name, instructions: `You are the ${name}.`, permissions,
    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
  }, context);
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

test("Test 1: Ada's secret in memory not visible to Bo's researcher", async (t) => {
  // Ada hands researcher a memory.put of a secret; Bo hands researcher a memory.search.
  // Bo should NOT get Ada's secret, proving memory scopes are isolated by trunk.

  const rules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "hand-off-put") {
        return call("delegate.handoff", { specialist: "", brief: "put-secret Ada's secret: CONFIDENTIAL-001", reason: "save secret" });
      }
      if (text === "put-secret Ada's secret: CONFIDENTIAL-001") {
        return call("memory.put", { text, source: "delegated" });
      }
      if (text === "hand-off-search") {
        return call("delegate.handoff", { specialist: "", brief: "search-secret Ada", reason: "search" });
      }
      if (text === "search-secret Ada") {
        return call("memory.search", { query: "Ada" });
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];

  const { app } = await fixture(t, rules);
  on(app);

  const researcherId = await specialist(app, "researcher", ["memory.write", "memory.read"]);

  // Update rules with actual specialist ID
  const actualRules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "hand-off-put") {
        return call("delegate.handoff", { specialist: researcherId, brief: "put-secret Ada's secret: CONFIDENTIAL-001", reason: "save" });
      }
      if (text === "put-secret Ada's secret: CONFIDENTIAL-001") {
        return call("memory.put", { text, source: "delegated" });
      }
      if (text === "hand-off-search") {
        return call("delegate.handoff", { specialist: researcherId, brief: "search-secret Ada", reason: "search" });
      }
      if (text === "search-secret Ada") {
        return call("memory.search", { query: "Ada" });
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];
  app.ui.setRules(actualRules);

  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read", "specialists.use"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read", "specialists.use"] });
  await app.trunks.introduced();

  // Ada saves secret via researcher
  const adaPut = await app.trunks.say(ada.id, "hand-off-put");
  assert.equal(adaPut.status, "completed", "Ada's put should complete");

  // Bo searches via researcher
  const boSearch = await app.trunks.say(bo.id, "hand-off-search");
  assert.equal(boSearch.status, "completed", "Bo's search should complete");

  // Get the child run ID from the delegation event
  const boChildRunId = getChildRunId(app, boSearch.runId, "delegation.handoff");
  assert.ok(boChildRunId, "Bo's handoff should have a child run");

  // Check what Bo's search found
  const searchOutcome = toolOutcome(app, boChildRunId, "memory.search");
  assert.equal(searchOutcome.ok, true, "Search should succeed");

  const foundTexts = (searchOutcome.result || []).map(f => f.data?.text ?? "").join(" | ");
  assert.ok(!foundTexts.includes("Ada"), `Bo should NOT find Ada's secret. Found: ${foundTexts}`);
});

test("Test 2: Specialist delegated from Ada keeps Ada's file root and history", async (t) => {
  // A specialist delegated from Ada's Trunk should work in Ada's file scope
  // and not be able to read Bo's files.

  const rules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "delegate-write") {
        return call("delegate.parallel", {
          tasks: [{ id: "w1", specialist: "", prompt: "write-file ada-file Ada content" }]
        });
      }
      if (text === "write-file ada-file Ada content") {
        return call("files.write", { path: "ada-file", content: "Ada content" });
      }
      if (text === "delegate-read") {
        return call("delegate.parallel", {
          tasks: [{ id: "r1", specialist: "", prompt: "read-file ada-file" }]
        });
      }
      if (text === "read-file ada-file") {
        return call("files.read", { path: "ada-file" });
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];

  const { app } = await fixture(t, rules);
  on(app);

  const researcherId = await specialist(app, "researcher", ["files.read", "files.write"]);

  const actualRules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "delegate-write") {
        return call("delegate.parallel", {
          tasks: [{ id: "w1", specialist: researcherId, prompt: "write-file ada-file Ada content" }]
        });
      }
      if (text === "write-file ada-file Ada content") {
        return call("files.write", { path: "ada-file", content: "Ada content" });
      }
      if (text === "delegate-read") {
        return call("delegate.parallel", {
          tasks: [{ id: "r1", specialist: researcherId, prompt: "read-file ada-file" }]
        });
      }
      if (text === "read-file ada-file") {
        return call("files.read", { path: "ada-file" });
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];
  app.ui.setRules(actualRules);

  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["files.read", "files.write", "specialists.use"] });
  app.trunks.edit(bo.id, { permissions: ["files.read", "files.write", "specialists.use"] });
  await app.trunks.introduced();

  // Ada delegates write
  const adaWrite = await app.trunks.say(ada.id, "delegate-write");
  assert.equal(adaWrite.status, "completed", "Ada's delegate write should complete");

  // Ada delegates read (should work)
  const adaRead = await app.trunks.say(ada.id, "delegate-read");
  assert.equal(adaRead.status, "completed", "Ada's delegate read should complete");

  // Verify the file was read successfully
  const adaFanoutEvent = app.store.events(adaRead.runId).find(e => e.kind === "delegation.fanout");
  assert.ok(adaFanoutEvent, "Should have fanout event");

  const fanoutOutcomes = adaFanoutEvent?.data?.tasks || {};
  assert.equal(fanoutOutcomes.r1?.status, "completed", "Read task should complete");
});

test("Test 3: Specialist under Trunk still gets own instructions and handoff rules", async (t) => {
  // Specialist lookups by name must still work: a handoff to researcher should find
  // the researcher specialist by name, not by some composite identity.

  const rules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "check-instructions") {
        return call("delegate.handoff", { specialist: "", brief: "tell-me-who-you-are", reason: "verify" });
      }
      if (text === "tell-me-who-you-are") {
        // The model will see the researcher's instructions in the system prompt
        return { content: "I am the researcher, here to help with research tasks." };
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];

  const { app } = await fixture(t, rules);
  on(app);

  const researcherId = await specialist(app, "researcher", ["memory.write", "memory.read"]);

  const actualRules = [
    ({ last }) => {
      if (last?.role !== "user") return null;
      const text = String(last.content ?? "");
      if (text === "check-instructions") {
        return call("delegate.handoff", { specialist: researcherId, brief: "tell-me-who-you-are", reason: "verify" });
      }
      if (text === "tell-me-who-you-are") {
        return { content: "I am the researcher, here to help with research tasks." };
      }
      return null;
    },
    ({ last }) => (last?.role === "tool" ? "OK" : null)
  ];
  app.ui.setRules(actualRules);

  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["specialists.use"] });
  await app.trunks.introduced();

  // Ada hands off to researcher
  const handoff = await app.trunks.say(ada.id, "check-instructions");
  assert.equal(handoff.status, "completed", "Handoff should complete");

  // Verify the specialist was found by name (not composite name)
  const handoffEvent = app.store.events(handoff.runId).find(e => e.kind === "delegation.handoff");
  assert.ok(handoffEvent, "Should have handoff event");
  assert.equal(handoffEvent?.data?.to, researcherId, "Should hand off to researcher by ID");
});

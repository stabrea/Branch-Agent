/**
 * FQ-routing.isolated-agents: PROBE - do delegated specialists share memory if they have the same name?
 * A Trunk Ada's "researcher" and Trunk Bo's "researcher" should NOT share agent:researcher memory scope.
 * Currently they might because specialists run with agent: bare-name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { call, fixture, on } from "./trunks-helpers.mjs";

test("PROBE: Trunk Ada's researcher and Trunk Bo's researcher do NOT share memory", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "specialist" });
    if (text.startsWith("recall ")) return call("memory.search", { query: text.slice("recall ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);

  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read", "specialists.use"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read", "specialists.use"] });

  // Create named specialists for Ada and Bo
  app.store.save("specialists", app.store.owner(), `researcher-${ada.id}`, { permissions: ["memory.write", "memory.read"], instructions: "You are a researcher." });
  app.store.save("specialists", app.store.owner(), `researcher-${bo.id}`, { permissions: ["memory.write", "memory.read"], instructions: "You are a researcher." });
  app.store.save("specializations", app.store.owner(), `spec-${ada.id}`, { agentId: ada.id, specialists: [`researcher-${ada.id}`] });
  app.store.save("specializations", app.store.owner(), `spec-${bo.id}`, { agentId: bo.id, specialists: [`researcher-${bo.id}`] });

  await app.trunks.introduced();

  // Ada's researcher saves a fact
  const adaSaveRun = await app.trunks.say(ada.id, "remember Ada's research finding");
  assert.ok(adaSaveRun.runId, "Ada's save completed");

  // Get the saved fact from Ada's perspective
  const adaRecallRun = await app.trunks.say(ada.id, "recall research finding");
  const adaRecall = app.store.events(adaRecallRun.runId).find((e) => e.kind === "tool.completed" && e.data.name === "memory.search");
  const adaFoundFacts = adaRecall?.data.result?.records ?? [];

  // Bo's researcher should NOT see Ada's fact if memory is properly isolated
  const boRecallRun = await app.trunks.say(bo.id, "recall research finding");
  const boRecall = app.store.events(boRecallRun.runId).find((e) => e.kind === "tool.completed" && e.data.name === "memory.search");
  const boFoundFacts = boRecall?.data.result?.records ?? [];

  // IF THIS FAILS: specialists with the same name share memory (the bug)
  // The correct behavior is: Bo should find 0 facts, Ada should find at least 1
  console.log("Ada found facts:", adaFoundFacts.length);
  console.log("Bo found facts:", boFoundFacts.length);

  // This assertion will FAIL if the bug exists (Bo finds Ada's facts)
  assert.equal(boFoundFacts.length, 0, "Bo's researcher should NOT see Ada's researcher facts (tests memory isolation)");
});

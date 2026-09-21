/**
 * The owner's own records in the smaller asks — forecasts and the prospect list — are the owner's
 * alone (src/asks/owner-only.ts). Reading them is marked look-only, and look-only work is let through for
 * outside work on purpose, so each tool refuses by where the work came from before it reads anything.
 *
 * What a hostile caller would try, and the test for each: a household task, a short-lived key, a chat
 * app (and a chat's helper), a lent conversation, a schedule, a trigger, another program over MCP or
 * A2A — reading, exporting, answering, clearing or writing. Every one is refused and nothing changes,
 * through the tool itself and through the runtime's own path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-asks-owner-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.asks.setMode("forecasts", { mode: "on" });
  app.asks.setMode("leads", { mode: "on" });
  const owner = app.runtime.owner;
  const as = (start) => {
    const run = app.store.createRun(owner, "someone else's work");
    app.store.event(run.id, "run.started", start);
    return app.runtime.context({ runId: run.id, source: start.source ?? "owner" });
  };
  // The owner's own records, made the owner's way.
  const mine = as({ source: "owner" });
  const forecast = await app.registry.execute("forecast.add", { question: "Will the launch slip?", probability: 0.4 }, mine);
  await app.registry.execute("leads.add", { prospects: [{ name: "Ada Obi", email: "ada@acme.com" }] }, mine);
  return { app, as, forecast };
}

const calls = (forecast) => [
  ["forecast.add", { question: "Planted?", probability: 0.5 }],
  ["forecast.resolve", { id: forecast.id, happened: true }],
  ["forecast.score", { which: "all" }],
  ["leads.add", { prospects: [{ name: "Eve", email: "eve@evil.test" }] }],
  ["leads.export", {}],
  ["leads.clear", {}],
];

test("nobody but the owner's own work reads, exports, answers, clears or writes the owner's records", async (t) => {
  const { app, as, forecast } = await fixture(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const chat = app.store.createRun(app.runtime.owner, "from a chat");
  app.store.event(chat.id, "run.started", { source: "channel" });
  for (const [who, start] of [
    ["a household task", { source: "owner", personProfileId: person.id }],
    ["a short-lived key", { source: "owner", shortLivedKey: true }],
    ["a chat app", { source: "channel" }],
    ["a chat's helper", { source: "owner", parentRunId: chat.id }],
    ["a lent conversation", { source: "owner", lentTo: "sam" }],
    ["a schedule", { source: "schedule" }],
    ["a trigger", { source: "trigger" }],
    ["another program over MCP", { source: "mcp" }],
    ["another agent over A2A", { source: "a2a" }],
  ]) {
    for (const [tool, args] of calls(forecast))
      await assert.rejects(app.registry.execute(tool, args, as(start)), /owner|chat app|short-lived|somebody else|started yourself/i, `${who} reached ${tool}`);
  }
  assert.equal(app.asks.forecasts.list("all").length, 1, "no forecast was written");
  assert.equal(app.asks.forecasts.get(forecast.id).happened, null, "no forecast was answered");
  assert.deepEqual(app.asks.leads.list().map((lead) => lead.email), ["ada@acme.com"], "the list was neither changed nor cleared");
});

test("the runtime's own path refuses outside work too, for the look-only export as well", async (t) => {
  const { app, forecast } = await fixture(t);
  for (const source of ["schedule", "trigger", "mcp", "a2a"]) {
    for (const [tool, args] of calls(forecast)) {
      let result;
      try { result = await app.runtime.executeTool(tool, args, { mode: "policy", source }); } catch (error) { result = { threw: String(error?.message ?? error) }; }
      const text = JSON.stringify(result);
      assert.ok(!text.includes("ada@acme.com"), `${source} got the prospect list through ${tool}`);
      assert.ok(!text.includes("Will the launch slip?"), `${source} got a forecast through ${tool}`);
    }
  }
  assert.equal(app.asks.forecasts.list("all").length, 1);
  assert.equal(app.asks.leads.list().length, 1);
});

test("the owner's own work still has all of it", async (t) => {
  const { app, as, forecast } = await fixture(t);
  const mine = as({ source: "owner" });
  assert.match((await app.registry.execute("leads.export", {}, mine)).csv, /ada@acme\.com/);
  assert.equal((await app.registry.execute("forecast.score", { which: "all" }, mine)).open, 1);
  await app.registry.execute("forecast.resolve", { id: forecast.id, happened: false }, mine);
  assert.equal(app.asks.forecasts.get(forecast.id).happened, false);
});

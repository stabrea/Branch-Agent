/**
 * Dogfood F4: "update by itself" held for five conversations waiting hours for an answer, and the card called them
 * working. A task stopped on a question holds an update only while the question is under an hour old.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { busyTaskCount, busyTasks, questionHoldsUpdateMs, updatePlan } from "../dist/comfort/auto-update.js";
import { saveComfort } from "../dist/comfort/settings.js";

test("F4 working tasks and fresh questions hold an update; a question older than an hour does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-f4-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const asked = (ms) => {
    const run = app.store.createRun(owner, "a question");
    app.store.finish(run.id, "needs_input", "May I?");
    app.store.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(new Date(Date.now() - ms).toISOString(), run.id);
  };
  asked(3 * 60 * 60 * 1000);
  asked(questionHoldsUpdateMs + 60_000);
  assert.deepEqual(busyTasks(app.store), { working: 0, asking: 0 }, "questions left over an hour hold nothing");
  saveComfort(app.store, owner, "notify", { autoUpdate: "install" });
  assert.equal(updatePlan(app.store, owner, { busyTasks: busyTaskCount(app.store), updaterPhase: "available" }).step, "install",
    "update by itself goes ahead past old questions");
  asked(5 * 60_000);
  app.store.createRun(owner, "working");
  assert.deepEqual(busyTasks(app.store), { working: 1, asking: 1 });
  assert.equal(busyTaskCount(app.store), 2);
  assert.equal(updatePlan(app.store, owner, { busyTasks: busyTaskCount(app.store), updaterPhase: "available" }).step, "nothing");
});

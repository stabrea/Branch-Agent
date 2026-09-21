/**
 * Before an update Branch drains: it takes no new work, gives what is running a short while to finish,
 * and marks what is still running as cut off by the update, so the version that comes up next offers
 * it back, with the never-break switch off (as it ships) too, instead of throwing it away. Before
 * this, closing for an update cancelled running tasks outright unless never-break was on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { cutByUpdate } from "../dist/never-break/resume.js";
import { drainPath, drainRunning } from "../dist/install/quit.js";
import { writeRunning } from "../dist/install/running.js";

/** A model that answers `quick` at once and otherwise waits until the task is stopped. */
const provider = () => ({
  name: "slow",
  complete(request) {
    if (request.messages.some((m) => m.role === "user" && String(m.content).includes("quick"))) return Promise.resolve({ content: "done", toolCalls: [] });
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  },
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-drain-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: provider() });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(root); });
  return { app, dataDir, root };
}
const started = async (app) => {
  for (let i = 0; i < 200 && !app.store.runs(app.runtime.owner).some((run) => run.status === "running"); i++) await new Promise((r) => setTimeout(r, 10));
  return app.store.runs(app.runtime.owner).find((run) => run.status === "running");
};

test("a drain waits for what finishes in time, marks what does not, and takes no new work", async (t) => {
  const { app } = await fixture(t);
  const slow = app.runtime.run({ prompt: "a long job", permissions: [] }).catch((error) => error);
  const running = await started(app);
  assert.ok(running, "the long job is running");
  const report = await app.runtime.drain(50);
  assert.deepEqual(report, { finished: 0, stillRunning: 1 });
  assert.ok(app.store.events(running.id).some((event) => event.kind === "run.cut-by-update"), "the long job is marked as cut off by the update");
  await assert.rejects(app.runtime.run({ prompt: "quick", permissions: [] }), /shut down/, "no new work while draining");
  app.runtime.undrain();
  const again = await app.runtime.run({ prompt: "quick again", permissions: [] });
  assert.equal(again.status, "completed", "an update that stopped before closing gives the work back");
  await app.runtime.shutdown();
  await slow;
});

test("what an update cuts off is interrupted, not cancelled, with the never-break switch off as it ships", async (t) => {
  const { app } = await fixture(t);
  const slow = app.runtime.run({ prompt: "a long job", permissions: [] }).catch((error) => error);
  const running = await started(app);
  await app.runtime.drain(20);
  await app.runtime.shutdown();
  await slow;
  assert.equal(app.store.run(running.id).status, "interrupted");
  assert.deepEqual([...cutByUpdate(app.store)], [running.id]);
});

test("without an update the switch's old answer stands: a plain close cancels", async (t) => {
  const { app } = await fixture(t);
  const slow = app.runtime.run({ prompt: "a long job", permissions: [] }).catch((error) => error);
  const running = await started(app);
  await app.runtime.shutdown();
  await slow;
  assert.equal(app.store.run(running.id).status, "cancelled");
  assert.equal(cutByUpdate(app.store).size, 0);
});

test("the next start offers back only what the update cut off, even with the switch off", async (t) => {
  const { app, dataDir } = await fixture(t);
  const cut = app.store.createRun(app.runtime.owner, "cut by the update");
  app.store.event(cut.id, "run.cut-by-update", { waitedMs: 30000 });
  app.store.finish(cut.id, "interrupted", "stopped for the update");
  const crashed = app.store.createRun(app.runtime.owner, "cut by a crash");
  app.store.finish(crashed.id, "interrupted", "Process stopped before completion");
  const report = await app.neverBreak.recoverOnStart(dataDir);
  assert.deepEqual(report.map((one) => one.runId), [cut.id], "only the update's task, and only offered");
  assert.ok(report.every((one) => one.outcome !== "auto_resumed"), "never carried on by itself with the switch off");
  assert.equal(app.store.events(crashed.id).length, 0, "a crash's task is left as the switch-off Branch always left it");
  assert.deepEqual(await app.neverBreak.recoverOnStart(dataDir), [], "offered once, not on every start");
});

test("the drain door opens only for this computer with Branch's own key, and answers how it went", async (t) => {
  const { app, dataDir } = await fixture(t);
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(() => server.close());
  const post = (key, body = {}) => fetch(server.url + drainPath, { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const short = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await post(short)).status), "a short-lived key cannot prepare Branch for an update");
  assert.equal((await fetch(server.url + drainPath, { headers: { authorization: `Bearer ${server.token}` } })).status, 405);
  const answer = await post(server.token, { budgetMs: 0 });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { finished: 0, stillRunning: 0 });
  assert.equal(app.runtime.draining, true);

  // The helper an update uses finds the running Branch from its note and asks it the same way.
  app.runtime.undrain();
  await writeRunning(dataDir, { pid: process.pid, mode: "app", port: Number(new URL(server.url).port), url: server.url, version: "1.0.0" });
  assert.deepEqual(await drainRunning(dataDir, 0), { finished: 0, stillRunning: 0 });
});

test("with no Branch running, or one that cannot be asked, an update carries on without a drain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-drain-none-"));
  t.after(() => discardTemp(root));
  assert.equal(await drainRunning(root, 0), null);
  await writeRunning(root, { pid: process.pid, mode: "daemon", port: 9, url: "http://127.0.0.1:9", version: "1.0.0" });
  assert.equal(await drainRunning(root, 0, { fetch: async () => { throw new Error("refused"); } }), null);
});

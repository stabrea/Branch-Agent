/**
 * Before an update Branch drains: it takes no new work, gives what is running a short while to finish,
 * and marks what is still running as cut off by the update, so the version that comes up next offers
 * it back, with the never-break switch off (as it ships) too, instead of throwing it away. Before
 * this, closing for an update cancelled running tasks outright unless never-break was on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { cutByUpdate } from "../dist/never-break/resume.js";
import { drainPath, drainRunning, undrainRunning } from "../dist/install/quit.js";
import { writeRunning } from "../dist/install/running.js";
import { Updater } from "../dist/desktop/updater.js";

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

test("with no Branch running there is nothing to drain; a running one that cannot be asked stops the update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-drain-none-"));
  t.after(() => discardTemp(root));
  assert.equal(await drainRunning(root, 0), null, "nothing running: nothing to finish");
  await writeRunning(root, { pid: process.pid, mode: "daemon", port: 9, url: "http://127.0.0.1:9", version: "1.0.0" });
  await assert.rejects(drainRunning(root, 0, { fetch: async () => { throw new Error("refused"); } }), /running but could not be asked to finish its work first[\s\S]*nothing was changed/,
    "a live Branch that cannot be drained is never closed as if it had been");
});

test("a drain the update did not follow through is taken back at once", async (t) => {
  const { app, dataDir } = await fixture(t);
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(() => server.close());
  await writeRunning(dataDir, { pid: process.pid, mode: "app", port: Number(new URL(server.url).port), url: server.url, version: "1.0.0" });
  await drainRunning(dataDir, 0);
  assert.equal(app.runtime.draining, true);
  await undrainRunning(dataDir);
  assert.equal(app.runtime.draining, false, "work is taken again, without waiting two minutes");
  const done = await app.runtime.run({ prompt: "quick", permissions: [] });
  assert.equal(done.status, "completed");
});

test("the next start puts back only the repeating jobs whose turn the update cut off", async (t) => {
  const { app, dataDir } = await fixture(t);
  const owner = app.runtime.owner;
  const cut = app.store.createRun(owner, "cut by the update");
  app.store.event(cut.id, "run.cut-by-update", { waitedMs: 30000 });
  app.store.finish(cut.id, "interrupted", "stopped for the update");
  const crashed = app.store.createRun(owner, "cut by a crash");
  app.store.finish(crashed.id, "interrupted", "Process stopped before completion");
  const job = (id, runId) => app.store.save("schedules", owner, id, { prompt: "check", intervalMs: 3600000, status: "interrupted", activeRunId: runId, dueAt: new Date().toISOString() });
  job("job-update", cut.id);
  job("job-crash", crashed.id);
  await app.neverBreak.recoverOnStart(dataDir);
  assert.equal(app.store.get("schedules", owner, "job-update").data.status, "pending", "the update's job carries on at its next turn");
  assert.equal(app.store.get("schedules", owner, "job-crash").data.status, "interrupted", "a crash's job is left as the switch-off Branch always left it");
});

test("a schedule's turn writes down its task as soon as it starts", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  app.store.save("schedules", owner, "job", { prompt: "a long job", intervalMs: 3600000, status: "pending", dueAt: new Date(0).toISOString(), permissions: [] });
  const ticking = app.scheduler.tick(new Date()).catch(() => []);
  let saved;
  for (let i = 0; i < 200 && !(saved = app.store.get("schedules", owner, "job").data).activeRunId; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(typeof saved.activeRunId === "string" && app.store.run(saved.activeRunId), "the running turn names its task");
  await app.runtime.shutdown();
  await ticking;
});

test("a released job forgets the task that was cut, so a later crash is never taken for the update", async (t) => {
  const { app, dataDir } = await fixture(t);
  const owner = app.runtime.owner;
  const cut = app.store.createRun(owner, "cut by the update");
  app.store.event(cut.id, "run.cut-by-update", { waitedMs: 30000 });
  app.store.finish(cut.id, "interrupted", "stopped for the update");
  app.store.save("schedules", owner, "job", { prompt: "check", intervalMs: 3600000, status: "interrupted", activeRunId: cut.id, dueAt: new Date().toISOString() });
  await app.neverBreak.recoverOnStart(dataDir);
  const released = app.store.get("schedules", owner, "job").data;
  assert.equal(released.status, "pending");
  assert.equal("activeRunId" in released, false, "the released job names no task");
  // Its next turn is cut off by a crash before it named its own task: not the update's to release.
  app.store.save("schedules", owner, "job", { ...released, status: "interrupted" });
  await app.neverBreak.recoverOnStart(dataDir);
  assert.equal(app.store.get("schedules", owner, "job").data.status, "interrupted");
});

/** A published 2.0.0 whose download matches its checksum, answered without the network. */
function fakeRelease() {
  const bytes = Buffer.from("pretend zip"), digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    if (String(url).includes("releases/latest"))
      return new Response(JSON.stringify({ tag_name: "v2.0.0", name: "2.0.0", body: "", published_at: null, html_url: "https://github.com/x/y/releases/tag/v2.0.0", assets: [
        { name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: bytes.length },
        { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] }), { status: 200 });
    if (String(url).endsWith("app.zip")) return new Response(bytes, { status: 200 });
    return new Response(`${digest}  app.zip
`, { status: 200 });
  };
}

/**
 * An update that stops after trying to close the background engine, when the hand-over script cannot
 * be written. Nothing is spawned: the script is only written, and here it cannot be.
 */
async function stopsAfterClosing(t, stopDaemon) {
  const root = await mkdtemp(join(tmpdir(), "branch-giveback-"));
  t.after(() => discardTemp(root));
  const scratchDir = join(root, "scratch"), installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  const calls = { undrained: 0, revived: 0 };
  const updater = new Updater({
    repo: "x/y", currentVersion: "1.0.0", installDir, executableName: "Branch Agent.exe", assetName: "app.zip",
    scratchDir, fetch: fakeRelease(), platform: "win32", packaged: true,
    extract: async (_archive, into) => { await mkdir(join(into, "app"), { recursive: true }); await writeFile(join(into, "app", "Branch Agent.exe"), "new"); },
    drain: async () => undefined,
    undrain: async () => { calls.undrained++; },
    revive: async () => { calls.revived++; },
    // When the close answers, a folder where the script goes makes writing it fail (the scratch
    // folder is fresh by now). A close that throws gets no such help: it must stop the update itself.
    stopDaemon: async () => { const answer = await stopDaemon(); await mkdir(join(scratchDir, "recover-update.cmd"), { recursive: true }); return answer; },
  });
  await assert.rejects(updater.install());
  const script = await readFile(join(scratchDir, "apply-update.cmd"), "utf8").then(() => true, () => false);
  return { ...calls, phase: updater.status.phase, script };
}

test("a stopped update gives a still-running engine its work back, and starts again only one proved closed", async (t) => {
  assert.deepEqual(await stopsAfterClosing(t, async () => ({ pid: 4242, stopped: false })),
    { undrained: 1, revived: 0, phase: "error", script: false }, "alive after the wait: only drained, so the drain is taken back");
  assert.deepEqual(await stopsAfterClosing(t, async () => ({ pid: 4242, stopped: true })),
    { undrained: 0, revived: 1, phase: "error", script: false }, "proved closed: started again, not sent an undo it cannot hear");
  assert.deepEqual(await stopsAfterClosing(t, async () => { throw new Error("no answer"); }),
    { undrained: 1, revived: 0, phase: "error", script: false }, "a close that failed outright stops the update: nothing proves the engine gone");
});

/**
 * A restored schedule keeps its job but not its standing yes (Q168 C). A changed backup could carry a
 * check program with its own fingerprint as the owner's approval, and it ran at its next turn; and a
 * webhook token the file's maker already held opened the job's webhook here. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";
import { saveQuietSwitches } from "../dist/heartbeat.js";
import { gateFingerprint, GateScriptSchema } from "../dist/job-gate.js";

const noon = new Date("2026-03-02T12:00:00.000Z");
const woke = { status: "completed", exitCode: 0, stdout: "{\"wakeAgent\":false}", stderr: "", durationMs: 3 };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-schedules-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const program = join(root, "probe");
  await writeFile(program, "fake");
  const ran = [];
  app.scheduler.gateRunner = async (...args) => { ran.push(args); return woke; };
  saveQuietSwitches(app.store, "local", { scriptGates: "on" });
  const job = (id) => app.store.get("schedules", "local", id)?.data;
  return { app, program, ran, job, context: app.runtime.context() };
}

/** A changed backup: one job whose check approves itself, with a webhook token its maker kept. */
function planted(archive, program) {
  const gate = GateScriptSchema.parse({ executable: program, args: ["anything"] });
  const now = new Date().toISOString();
  const id = "7d3c1c8e-0000-4000-8000-00000000abcd";
  archive.tables.schedules = [...(archive.tables.schedules ?? []), { id, owner: "local", created_at: now, updated_at: now,
    data: JSON.stringify({ prompt: "Summarise new issues", kind: "task", dueAt: noon.toISOString(), intervalMs: 3600_000,
      permissions: [], status: "pending", history: [], gate, gateApproved: gateFingerprint(gate), hookToken: "a".repeat(48) }) }];
  return id;
}

test("a restored job's check script waits for the owner's yes, and its webhook gets a new token", async (t) => {
  const { app, program, job, context } = await fixture(t);
  const made = app.scheduler.create(context, { prompt: "Summarise new issues", dueAt: noon.toISOString(), kind: "task",
    intervalMs: 3600_000, gate: { executable: program, args: ["issues"] }, webhook: true });
  await app.scheduler.approveGate("local", made.id, true);
  const before = job(made.id);
  assert.equal(before.status, "pending", "control: approved here");
  assert.match(before.hookToken, /^[a-f0-9]{48}$/, "control: it has a webhook");
  const archive = app.store.backup(app.version);

  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => archive, false);
  const after = fresh.job(made.id);
  assert.equal(after.prompt, "Summarise new issues", "the job itself comes back");
  assert.equal(after.gateApproved, null, "but not the yes for its check script");
  assert.match(after.hookToken, /^[a-f0-9]{48}$/, "it still has a webhook");
  assert.notEqual(after.hookToken, before.hookToken, "with a token made here, not the file's");

  await fresh.app.scheduler.tick(new Date(noon.getTime() + 1000));
  assert.equal(fresh.ran.length, 0, "the check script did not run");
  assert.equal(fresh.job(made.id).status, "paused");
  assert.match(fresh.job(made.id).pausedBecause, /approve the script/);
  // The owner's own yes here brings it back.
  await fresh.app.scheduler.approveGate("local", made.id, true);
  await fresh.app.scheduler.tick(new Date(noon.getTime() + 2000));
  assert.equal(fresh.ran.length, 1, "once approved here, it runs");
});

test("a changed backup's self-approving check and known webhook token are disarmed, fresh or replacing", async (t) => {
  for (const replacing of [false, true]) {
    const { app, program, ran, job } = await fixture(t);
    const archive = app.store.backup(app.version);
    const id = planted(archive, program);
    if (replacing) await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
    await restoreBackup(app, async () => archive, replacing);
    assert.equal(job(id).gateApproved, null, `${replacing ? "replacing" : "fresh"}: the file's yes is not kept`);
    assert.notEqual(job(id).hookToken, "a".repeat(48), `${replacing ? "replacing" : "fresh"}: the file's token is not kept`);
    await app.scheduler.tick(new Date(noon.getTime() + 1000));
    assert.equal(ran.length, 0, `${replacing ? "replacing" : "fresh"}: the planted check never ran`);
    assert.equal(job(id).status, "paused");
  }
});

test("a job with no check and no webhook comes back exactly as it was", async (t) => {
  const { app, job, context } = await fixture(t);
  const made = app.scheduler.create(context, { prompt: "Water the plants", dueAt: noon.toISOString(), kind: "reminder" });
  const archive = app.store.backup(app.version);
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => archive, false);
  assert.deepEqual(fresh.job(made.id), job(made.id));
  assert.ok(!("hookToken" in fresh.job(made.id)), "no webhook is switched on");
});

test("a schedule the restore cannot read as a plain JSON object is left out, not put in with the file's yes", async (t) => {
  for (const replacing of [false, true]) {
    const { app, program, ran, job } = await fixture(t);
    const archive = app.store.backup(app.version);
    const gate = GateScriptSchema.parse({ executable: program, args: ["anything"] });
    const now = new Date().toISOString();
    const planted = { prompt: "Summarise new issues", kind: "task", dueAt: noon.toISOString(), intervalMs: 3600_000, permissions: [],
      status: "running", history: [], gate, gateApproved: gateFingerprint(gate), hookToken: "a".repeat(48) };
    // JSON5 (a trailing comma), which JSON.parse refuses and SQLite's JSON functions read; an array; a number.
    const shapes = { "b0a1c1e8-0000-4000-8000-000000000001": JSON.stringify(planted).replace(/\}$/, ",}"),
      "b0a1c1e8-0000-4000-8000-000000000002": JSON.stringify([planted]), "b0a1c1e8-0000-4000-8000-000000000003": 7 };
    for (const [id, data] of Object.entries(shapes)) archive.tables.schedules = [...(archive.tables.schedules ?? []), { id, owner: "local", created_at: now, updated_at: now, data }];
    if (replacing) await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
    await restoreBackup(app, async () => archive, replacing);
    const where = replacing ? "replacing" : "fresh";
    for (const id of Object.keys(shapes))
      assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM schedules WHERE id=?").get(id).n, 0, `${where}: ${id.slice(-1)} is not restored`);
    await app.scheduler.tick(new Date(noon.getTime() + 1000));
    assert.equal(ran.length, 0, `${where}: nothing the file planted ran`);
    assert.equal(job(Object.keys(shapes)[0]), undefined);
  }
});

test("a schedule or workflow SQLite's own JSON reader refuses is left out, so the owner's jobs keep running", async (t) => {
  const { app, job, context } = await fixture(t);
  const reminder = app.scheduler.create(context, { prompt: "Water the plants", dueAt: noon.toISOString(), kind: "reminder" });
  const archive = app.store.backup(app.version);
  // JSON.parse takes this depth; SQLite's JSON functions do not (NAS 91388a7).
  const deep = `{"prompt":"deep","kind":"reminder","dueAt":"${noon.toISOString()}","status":"pending","history":[],"x":${"[".repeat(1200)}${"]".repeat(1200)}}`;
  assert.doesNotThrow(() => JSON.parse(deep), "control: JavaScript reads it");
  const now = new Date().toISOString();
  const deepId = "d0a1c1e8-0000-4000-8000-00000000dee9";
  archive.tables.schedules = [...(archive.tables.schedules ?? []), { id: deepId, owner: "local", created_at: now, updated_at: now, data: deep }];
  archive.tables.workflows = [...(archive.tables.workflows ?? []), { id: "d0a1c1e8-0000-4000-8000-00000000dee8", owner: "local", created_at: now, updated_at: now,
    data: `{"status":"running","x":${"[".repeat(1200)}${"]".repeat(1200)}}` }];
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => archive, false);
  assert.equal(fresh.app.store.sqlite.prepare("SELECT count(*) AS n FROM schedules WHERE id=?").get(deepId).n, 0, "the deep schedule is not restored");
  assert.equal(fresh.app.store.sqlite.prepare("SELECT count(*) AS n FROM workflows WHERE json_valid(data)=0").get().n, 0, "nor the deep workflow");
  await fresh.app.scheduler.tick(new Date(noon.getTime() + 1000));
  assert.notEqual(fresh.job(reminder.id).status, "pending", "the owner's own due reminder still runs");
  assert.ok(job(reminder.id), "control: it was the owner's");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/coding-next: coding reliability, round 2 (docs/agents/STATUS-coding-next.md). Nothing here
 * starts Electron or a real program: every outside program is a fake that records what it was
 * handed, which is the only way to check the environment a child would have been given.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-next-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

const contextOf = (app, extra = {}) => ({
  owner: "local", workspace: app?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly what it was asked. */
function fakeWorld() {
  const calls = [];
  const probe = async () => ({ code: null, stdout: "", stderr: "", missing: true });
  const spawn = async (options) => {
    calls.push(options);
    return { status: "completed", exitCode: 0, stdout: "3\n", stderr: "", truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn };
}

/** Runs `work` as if inside the desktop app, where process.versions says which Electron it is. */
async function asDesktopApp(work) {
  Object.defineProperty(process.versions, "electron", { value: "99.0.0", configurable: true, enumerable: true });
  try { return await work(); } finally { delete process.versions.electron; }
}

// ------------------------------------------------------------------ 5. code.run runs as Node

test("5 runAsNode adds ELECTRON_RUN_AS_NODE only for this program, and only inside the desktop app", async () => {
  const { runAsNode } = await import("../dist/child-env.js");
  assert.deepEqual(runAsNode(process.execPath), {}, "plain Node needs nothing");
  await asDesktopApp(async () => {
    assert.deepEqual(runAsNode(process.execPath), { ELECTRON_RUN_AS_NODE: "1" });
    assert.deepEqual(runAsNode("C:/Python/python.exe"), {}, "another program is left alone");
  });
});

test("5 code.run inside the desktop app starts this program as Node, not a second app", async (t) => {
  const { app, workspace } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld();
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  await asDesktopApp(() => runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app)));
  const started = world.calls.at(-1);
  assert.equal(started.executable, process.execPath);
  assert.equal(started.env.ELECTRON_RUN_AS_NODE, "1", "without it the packaged app would start itself again");
  // Outside the desktop app nothing extra is handed on.
  await runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app));
  assert.equal(world.calls.at(-1).env.ELECTRON_RUN_AS_NODE, undefined);
});

// ------------------------------------------------------------------ 6. crash capture is a switch

test("6 crash capture ships off: a crash writes no note, and with the log off nothing at all", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-off-"));
  t.after(() => discardTemp(dir));
  assert.equal(DiagnosticLogSettingsSchema.parse({}).crashCapture, "off");
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({}) });
  log.write({ level: "info", component: "tasks", message: "step one" });
  log.crash("engine", new Error("boom"));
  assert.deepEqual(log.crashes(), []);
  assert.deepEqual(await readdir(dir).catch(() => []), [], "off writes no file");
  // With the log on, the crash is still an ordinary log line — just no crash note.
  const logged = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on" }) });
  logged.crash("engine", new Error("boom"));
  assert.equal(logged.crashes().length, 0);
  assert.match(logged.read()[0].message, /Crashed: Error: boom/);
  // On: the note is written.
  const on = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ crashCapture: "on" }) });
  on.crash("engine", new Error("boom"));
  assert.equal(on.crashes().length, 1);
});

test("6 saving the log's mode keeps crash capture; the switch file tells the desktop app at its next start", async (t) => {
  const { diagnosticApi } = await import("../dist/diagnostic-api.js");
  const { crashReporterPlan, crashCaptureMarked } = await import("../dist/diagnostic-log.js");
  const dataDir = await mkdtemp(join(tmpdir(), "branch-crash-mark-"));
  t.after(() => discardTemp(dataDir));
  const saved = new Map();
  const app = { version: "9", runtime: { owner: "me" }, store: {
    profiles: { requireOwner() {} },
    get: (_table, _owner, key) => saved.has(key) ? { data: saved.get(key) } : undefined,
    save: (_table, _owner, key, data) => { saved.set(key, data); },
  } };
  const post = (body) => diagnosticApi({ app, dataDir, installType: "x", startedAt: 0 }, "POST", "/api/diagnostics/log/settings",
    new URL("http://local/api/diagnostics/log/settings"), async () => body);
  assert.equal(crashReporterPlan(dataDir), null, "never switched on: the reporter is not started");
  assert.equal((await post({ crashCapture: "on" })).crashCapture, "on");
  assert.equal(crashCaptureMarked(dataDir), true);
  assert.equal(crashReporterPlan(dataDir).uploadToServer, false, "on: started, and still never uploads");
  const after = await post({ mode: "when-needed", keepDays: 7 });
  assert.equal(after.crashCapture, "on", "changing the log's mode must not switch crash capture off");
  assert.equal(after.maxMegabytes, 20);
  await post({ crashCapture: "off" });
  assert.equal(crashReporterPlan(dataDir), null);
});

test("6 Report a problem still works with crash capture off: it just has no crash files to offer", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { gatherReport } = await import("../dist/diagnostic-report.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-report-"));
  t.after(() => discardTemp(dir));
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({}) });
  log.crash("engine", new Error("boom"));
  const items = await gatherReport({ version: "9", dataDir: dir, installType: "x", log, logMode: "off",
    health: async () => ({ ok: true, items: [] }), settings: () => ({}), services: () => ({}), events: () => ({ events: [] }),
    crashDumpsDir: null, resolve: null });
  const crashes = items.find((item) => item.id === "crashes");
  assert.match(crashes.title, /0 noted, 0 crash files/);
});

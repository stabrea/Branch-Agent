// Bucket 14: what it has cost you, in plain figures.
// U1-U3 the usage report (A0367), U4 the task counters sent to your own collector (A1751),
// U5 handing events to an embedding program's logger (A1334), U6 the written guides (A1334, A0681).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, afterTaskMetrics, bridgeLogs, change, executionMetricsSettings, levelFor, money, rollUp,
  saveExecutionMetricsSettings, saveTraceExportSettings, sendExecutionMetrics, usageReportSettings,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

const plantedKey = "sk-testonly0000ZZZZ1111secretvalue"; // not-a-real-secret: a planted fixture that must be blanked

function scripted(steps) {
  let calls = 0;
  return {
    name: "scripted",
    async complete() { const step = steps[Math.min(calls, steps.length - 1)]; calls += 1; return step(); },
  };
}
const say = (content) => () => ({ content, toolCalls: [] });
const write = (id) => () => ({ content: "", toolCalls: [{ id, name: "files.write", arguments: JSON.stringify({ path: `${id}.txt`, content: "x" }) }] });

async function served(t, steps = [say("done")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-usage14-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps),
    web: { allowPrivateAddresses: true },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, api };
}

/** The model the scripted runs were recorded under, so a price can be put on it. */
function recordedModel(app, runId) {
  const event = app.store.events(runId).find((e) => e.kind === "model.completed");
  return String(event?.data.model ?? "");
}

/** Moves a finished task back in time, with its events, so it falls in the stretch before. */
function backdate(app, runId, days) {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  app.store.sqlite.prepare("UPDATE tasks SET created_at=?, updated_at=? WHERE id=?").run(at, at, runId);
  app.store.sqlite.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(at, runId);
}

// ------------------------------------------------------------ U1-U3: the usage report

test("U1: the usage report ships off and refuses in one sentence until switched on", async (t) => {
  const { app, api } = await served(t);
  assert.equal(usageReportSettings(app.store, app.runtime.owner).mode, "off");
  const settings = await api("GET", "/api/usage/report/settings");
  assert.equal(settings.body.usageReport.mode, "off");
  const refused = await api("POST", "/api/usage/report", { range: "7d" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /switched off/);
  const on = await api("POST", "/api/usage/report/settings", { mode: "when-needed" });
  assert.equal(on.body.usageReport.mode, "when-needed");
  assert.equal(on.body.usageReport.enabled, true);
  const ranged = await api("POST", "/api/usage/report/settings", { range: "7d" });
  assert.equal(ranged.body.usageReport.mode, "when-needed", "saving one field keeps the switch where it was");
  assert.equal((await api("POST", "/api/usage/report/settings", { range: "1y" })).status, 400);
});

test("U2: the report adds up the stretch, compares it with the one before, and names tools and people", async (t) => {
  const { app, api } = await served(t, [write("a"), say("one"), write("b"), say("two"), say("three")]);
  const first = await app.runtime.run({ prompt: "first" });
  const second = await app.runtime.run({ prompt: `second ${plantedKey}` });
  const old = await app.runtime.run({ prompt: "an older one" });
  assert.equal(first.status, "completed", first.output);
  backdate(app, old.id, 10);
  const model = recordedModel(app, first.id);
  assert.ok(model, "the scripted task recorded which model answered");
  await api("POST", "/api/pricing", { overrides: { [model]: { input: 1000, output: 1000 } } });
  const sam = app.store.profiles.create({ name: "Sam", pin: "4821" });
  app.store.sqlite.prepare("UPDATE tasks SET owner=? WHERE id=?").run(`profile:${sam.id}`, second.id);
  await api("POST", "/api/usage/report/settings", { mode: "on" });

  const page = await api("POST", "/api/usage/report", { range: "7d", format: "markdown" });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const text = page.body.body;
  assert.equal(page.body.format, "markdown");
  assert.match(text, /# Usage report, last 7 days/);
  assert.match(text, /finished 2 task\(s\), up 100% on the 7 days before \(1\)/);
  assert.match(text, /Estimated cost: \$\d+\.\d\d for the 2 task\(s\) with a price on file/);
  assert.match(text, /not a bill/);
  assert.match(text, /## By model\n\n- [^\n]*2 task\(s\)/);
  assert.match(text, /## Tools used most\n\n- files\.write: 2 call\(s\)/);
  assert.match(text, /## By where tasks came from/);
  assert.match(text, /## By person on this computer\n\n- Sam: 1 task\(s\)[^\n]*\n- You \(the owner\): 1 task\(s\)/);
  assert.match(text, /made 2 tool call\(s\)/, "a call's start and end count once");
  assert.doesNotMatch(text, /4821/, "a profile's PIN never appears");
  assert.doesNotMatch(text, /second/, "no prompt is in the report");
  assert.ok(!text.includes(plantedKey));

  const html = await api("POST", "/api/usage/report", { range: "30d" });
  assert.equal(html.body.format, "html");
  assert.match(html.body.body, /^<!doctype html>/);
  assert.match(html.body.body, /finished 3 task\(s\), new compared with the 30 days before/);
  assert.doesNotMatch(html.body.body, /<script/i);
});

test("U3: a task with no price is said so in words, and the sums keep unknown apart from zero", () => {
  const day = (date, runs, priced, cost, model) => ({
    date, runs, toolCalls: 1, failures: 0, tokens: { input: 10, output: 5 }, estimatedCost: cost,
    pricedRuns: priced, unpricedRuns: runs - priced, topFailures: [],
    presets: [{ id: model, model, runs, tokens: { input: 10, output: 5 }, cost: priced ? cost : null }],
    byConversation: [], byChannel: [{ source: "web", runs, cost: priced ? cost : null }],
  });
  const stretch = rollUp([day("2026-09-02", 2, 0, 0, "mystery"), day("2026-09-01", 1, 1, 0.5, "known")]);
  assert.equal(stretch.tasks, 3);
  assert.equal(stretch.pricedTasks, 1);
  assert.equal(stretch.unpricedTasks, 2);
  assert.equal(stretch.cost, 0.5);
  assert.deepEqual(stretch.days.map((d) => d.date), ["2026-09-01", "2026-09-02"]);
  assert.equal(stretch.models.find((m) => m.name === "mystery").cost, null, "unknown is not zero");
  assert.equal(stretch.channels[0].cost, 0.5);
  assert.equal(money(null), "no price on file");
  assert.equal(money(0.001), "less than $0.01");
  assert.equal(money(0), "$0.00");
  assert.equal(change(12, 10), "up 20% on");
  assert.equal(change(5, 10), "down 50% on");
  assert.equal(change(0, 0), "the same as");
  assert.equal(change(3, 0), "new compared with");
});

// ------------------------------------------------------------ U4: the task counters

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), "waited too long");
}

function memoryStore() {
  const saved = new Map();
  return {
    get: (_kind, owner, key) => (saved.has(`${owner}/${key}`) ? { data: saved.get(`${owner}/${key}`) } : undefined),
    save: (_kind, owner, key, data) => { saved.set(`${owner}/${key}`, data); },
  };
}

test("U4: the counters switch ships off, sends on a press when needed, and after tasks only when on", async () => {
  const store = memoryStore();
  const sent = [];
  let clock = new Date("2026-09-17T10:00:00Z");
  let tracesOn = false;
  const deps = {
    store, owner: "local", now: () => clock,
    sendingOn: () => tracesOn,
    counters: () => [{ name: "branch_runs_total", description: "Tasks", unit: "1", value: 4 }],
    send: async (points, reason) => { sent.push({ points, reason }); return { ok: true, error: null }; },
  };
  assert.equal(executionMetricsSettings(store, "local").mode, "off");
  assert.match((await sendExecutionMetrics(deps)).reason, /switched off/);
  assert.equal((await afterTaskMetrics(deps)).sent, false);

  saveExecutionMetricsSettings(store, "local", { mode: "when-needed" });
  assert.equal((await afterTaskMetrics(deps)).sent, false, "when needed never sends by itself");
  assert.match((await sendExecutionMetrics(deps)).reason, /no address of yours/, "nothing goes while traces are off");
  assert.equal(sent.length, 0);
  tracesOn = true;
  assert.equal((await sendExecutionMetrics(deps)).sent, true);
  assert.equal(sent.length, 1);

  saveExecutionMetricsSettings(store, "local", { mode: "on", minutesBetween: 10 });
  assert.equal((await afterTaskMetrics(deps)).sent, false, "inside the quiet gap after the press");
  clock = new Date("2026-09-17T10:11:00Z");
  assert.equal((await afterTaskMetrics(deps)).sent, true);
  assert.equal((await afterTaskMetrics(deps)).sent, false);
  assert.equal(sent.length, 2);
  assert.throws(() => saveExecutionMetricsSettings(store, "local", { lastSentAt: "x" }), "the send time is not a setting");
});

test("U4: after a task the counters reach the owner's own collector, carrying numbers only", async (t) => {
  const seen = [];
  const collector = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { seen.push({ path: request.url, body: raw }); response.writeHead(200); response.end("{}"); });
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => collector.close(resolve)));
  const { app, api } = await served(t, [say(`finished ${plantedKey}`)]);
  const off = await api("GET", "/api/usage/counters");
  assert.equal(off.body.counters.mode, "off");

  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, destination: "otlp", endpoint: `http://127.0.0.1:${collector.address().port}` });
  const quiet = await app.runtime.run({ prompt: "a private prompt about Sam" });
  await waitFor(() => app.store.events(quiet.id).some((e) => e.kind === "trace.sent" || e.kind === "trace.send_failed"));
  assert.equal(seen.filter((s) => s.path === "/v1/metrics").length, 0, "the counters stay home while their switch is off");

  await api("POST", "/api/usage/counters", { mode: "on" });
  await app.runtime.run({ prompt: "a private prompt about Sam" });
  await waitFor(() => seen.some((s) => s.path === "/v1/metrics"));
  const metrics = seen.find((s) => s.path === "/v1/metrics");
  assert.ok(metrics, "the counters arrived at the owner's address");
  assert.match(metrics.body, /branch_runs_total/);
  assert.match(metrics.body, /branch_tool_failures_total/);
  assert.doesNotMatch(metrics.body, /private prompt|Sam|sk-testonly/);
  const pressed = await api("POST", "/api/usage/counters/send", {});
  assert.equal(pressed.body.sent, true, pressed.body.reason);
  assert.ok(pressed.body.counters.lastSentAt);
  const record = app.store.audit.list(app.runtime.owner, { action: "data.exported" });
  assert.ok(record.some((entry) => /counters/.test(entry.reason)), "every send is written in the record");
});

// ------------------------------------------------------------ U5: the log bridge

test("U5: events reach the embedding program's logger at the right level, cut down to their shape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-logs14-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([write("c"), say("ok")]) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const lines = [];
  const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) =>
    [level, (message, fields) => lines.push({ level, message, fields })]));
  const stop = bridgeLogs(app.store, logger, { prefix: "agent" });
  await app.runtime.run({ prompt: `please keep ${plantedKey} private` });
  stop();
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => l.message === "agent tool.completed" && l.fields.name === "files.write"));
  assert.ok(lines.every((l) => l.level !== "debug"), "debug lines are left out at the default level");
  const all = JSON.stringify(lines);
  assert.ok(!all.includes(plantedKey), "no key reaches the logger");
  assert.ok(!all.includes("please keep"), "no prompt reaches the logger");
  const count = lines.length;
  app.store.event(lines[0].fields.runId, "tool.completed", { name: "late" });
  assert.equal(lines.length, count, "stopping the bridge stops the lines");

  const failures = [];
  const only = bridgeLogs(app.store, { ...logger, error: (m) => failures.push(m), info: () => { throw new Error("broken logger"); } },
    { kinds: ["tool."], level: "warn" });
  app.store.event(lines[0].fields.runId, "tool.failed", { name: "x", error: "no" });
  app.store.event(lines[0].fields.runId, "tool.completed", { name: "y" });
  app.store.event(lines[0].fields.runId, "model.failed", { error: "no" });
  only();
  assert.deepEqual(failures, ["branch tool.failed"], "kinds and level both narrow, and a throwing logger breaks nothing");
  assert.equal(levelFor("model.retry_scheduled"), "warn");
  assert.equal(levelFor("model.stall_recovery"), "warn");
  assert.equal(levelFor("text.delta"), "debug");
  assert.equal(levelFor("run.started"), "info");
});

// ------------------------------------------------------------ U6: the guides

test("U6: the builders' guide says how to log, and the settings page explains the counters and startup tracing", async () => {
  const guide = await readFile(new URL("../docs/handbook/07-for-builders.md", import.meta.url), "utf8");
  assert.match(guide, /## Logging from a program that embeds Branch/);
  assert.match(guide, /bridgeLogs\(app\.store, console/);
  assert.match(guide, /GET \/api\/logs/);
  const docs = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  const has = (pattern) => assert.ok(pattern.test(docs), `configuration.md says ${pattern}`);
  has(/### Usage report, task counters and logging \(A0367, A1751, A1334, A0681\)/);
  has(/There is no telemetry, and there never will be/);
  has(/tracing starts with\s+the\s+engine/);
});

// ------------------------------------------------------------ U7-U8: the two cards

test("U7: every word the two cards show is on file in English and in real French", async () => {
  const script = await readFile(new URL("../public/usage-report.js", import.meta.url), "utf8");
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const keys = new Set([...script.matchAll(/["'`]((?:usage\.report\.|counters\.|action\.usage-report-|action\.counters-|field\.usage-report-|field\.counters-)[\w.-]*)["'`]/g)].map((m) => m[1]));
  for (const mode of ["off", "when-needed", "on"]) { keys.add(`usage.report.mode.${mode}`); keys.add(`counters.mode.${mode}`); }
  for (const range of ["7d", "30d", "90d"]) keys.add(`usage.report.range.${range}`);
  for (const prefix of ["usage.report.mode", "counters.mode", "usage.report.range"]) keys.delete(prefix);
  assert.ok(keys.size >= 20, `the script's keys were not found (${keys.size})`);
  for (const key of keys) {
    assert.ok(english[key], `${key} has no English`);
    assert.ok(french[key] && french[key] !== english[key], `${key} has no French of its own`);
  }
  assert.ok(!/textContent = "[A-Z]/.test(script), "a word is written into the page without a key");
  assert.ok(!/#[0-9a-f]{3,6}\b|rgba?\(/i.test(script), "no colour is written down");
});

test("U8: the report card lives in Data and the counters card in Advanced, at 400 pixels with no page errors", async (t) => {
  const { chromium } = await import("playwright");
  const { openPlace } = await import("./places.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-ui14-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([say("done")]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await app.runtime.run({ prompt: "one task" });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await openPlace(page, "settings:data");
  const choice = page.locator("#lx-page-data #usage-report-mode");
  await choice.waitFor({ state: "visible" });
  assert.equal(await choice.inputValue(), "off");
  assert.equal(await page.locator("#usage-report-body").isHidden(), true, "off shows only the switch");
  await choice.selectOption("on");
  const save = page.getByRole("button", { name: "Save as notes", exact: true }).and(page.locator("#usage-report-card button"));
  await save.waitFor({ state: "visible" });
  assert.equal(await page.locator("#usage-report-card button:not(.quiet)").count(), 1, "one filled button");
  const [download] = await Promise.all([page.waitForEvent("download"), save.click()]);
  assert.match(download.suggestedFilename(), /^usage-report-last-30-days\.md$/);
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(await wide() <= 0, "the report card pushes the page sideways");

  await openPlace(page, "settings:advanced");
  const counters = page.locator("#lx-page-advanced #counters-mode");
  await counters.waitFor({ state: "visible" });
  assert.equal(await counters.inputValue(), "off");
  assert.equal(await page.locator("#counters-send").isHidden(), true);
  await counters.selectOption("when-needed");
  await page.locator("#counters-send").waitFor({ state: "visible" });
  await page.locator("#counters-send").click();
  await page.getByText("Sending traces is off, so there is no address of yours", { exact: false }).waitFor();
  assert.ok(await wide() <= 0, "the counters card pushes the page sideways");
  const text = await page.locator("#counters-card").innerText();
  assert.doesNotMatch(text, /endpoint|payload|SSE|telemetry/i, "plain words only");
  assert.deepEqual(errors, []);
});

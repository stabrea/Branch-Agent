/* Settings › Data & usage. The report card adds up the engine's own usage for the last 7, 30 or 90 days
   (GET /api/usage?range=), and "Open the report" shows the engine's usage report for that stretch
   (POST /api/usage/report { range, format }), which answers only while the usage-report switch is on.
   "Test the model you use" lists the engine's ready-made suites (GET /api/evaluation/suites), runs the chosen one
   against the model in use (POST /api/evaluation/run { suite }), and shows the last run the engine recorded for it
   (GET /api/evaluation/history?suite=, newest first). */
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { api } from "../../core/api.js";
import { toast, openDlg, ic } from "../../core/ui.js";
import { esc, renderNow } from "../../core/dom.js";
import { statusBox } from "../parts.js";

let usage = null;
let range = "30";

async function loadUsage() {
  try { usage = await api(`usage?range=${range}d&by=day`); } catch (error) { usage = null; toast(error.message); }
  renderNow();
}

function reportCard() {
  const days = usage?.data ?? [];
  const cost = days.reduce((sum, d) => sum + (d.estimatedCost ?? 0), 0);
  const tasks = days.reduce((sum, d) => sum + (d.runs ?? 0), 0);
  const head = usage ? `<b>$${cost.toFixed(2)}</b><em>${tasks} tasks · estimated from each model’s price</em>` : "";
  return `<div class="rep15"><div class="rep-h15"><span><small>Last ${range} days</small>${head}</span><span class="seg" role="group" aria-label="Period">${["7", "30", "90"].map((d) => `<button type="button" aria-pressed="${range === d}" data-act="rep15" data-v="${d}">${d} days</button>`).join("")}</span></div><button class="btn sm" type="button" data-act="repopen15">Open the report</button></div>`;
}

async function openReport() {
  try {
    const report = await api("usage/report", { range: `${range}d`, format: "markdown" });
    openDlg({ title: `Usage · last ${range} days`, wide: true, body: `<pre class="code6" data-css="white-space:pre-wrap;margin:0">${esc(report.body)}</pre>`, foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
  } catch (error) { toast(error.message); }
}

/* ---------- Test the model you use ---------- */
let suites = null;
let suiteId = null;
let lastRun = null;
let running = false;

async function loadLastRun() {
  if (!suiteId) return;
  try { lastRun = (await api(`evaluation/history?suite=${encodeURIComponent(suiteId)}`)).runs?.[0] ?? null; } catch (error) { lastRun = null; toast(error.message); }
  renderNow();
}

async function loadSuites() {
  try {
    suites = (await api("evaluation/suites")).suites ?? [];
    if (!suites.some((s) => s.id === suiteId)) suiteId = suites[0]?.id ?? null;
  } catch (error) { suites = null; toast(error.message); }
  await loadLastRun();
}

async function runTest() {
  if (running || !suiteId) return;
  running = true;
  renderNow();
  try { lastRun = await api("evaluation/run", { suite: suiteId }); } catch (error) { toast(error.message); }
  running = false;
  renderNow();
}

/* The time the run took, from the engine's own start and finish. */
function took(run) {
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!(ms >= 0)) return "";
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}

function result(run) {
  const s = run.summary ?? {};
  const cost = s.dollars == null ? "" : ` · cost $${s.dollars.toFixed(2)}`;
  const time = took(run);
  const title = `${s.passed} of ${s.total} right${cost}${time ? ` · ${time}` : ""}`;
  const regressions = run.regressions ?? [];
  const said = run.regressionNote ? run.regressionNote : regressions.length ? "" : "Nothing that used to work stopped working.";
  const missed = (run.tasks ?? []).filter((t) => !t.passed).map((t) => t.problem ?? t.id);
  const text = [said, missed.length ? `Missed: ${missed.join("; ")}` : ""].filter(Boolean).join(" ");
  return statusBox(title, text, regressions.length > 0);
}

function evalCard() {
  const current = (suites ?? []).find((s) => s.id === suiteId);
  const picks = (suites ?? []).map((s) => `<button type="button" aria-pressed="${s.id === suiteId}" data-act="eval-set" data-v="${esc(s.id)}">${esc(s.name)} · ${s.tasks.length}</button>`).join("");
  const state = running && current ? `<p class="hint">${ic("spin", "s spin")} Running ${current.tasks.length} tasks…</p>` : lastRun && !running ? result(lastRun) : "";
  return `<div class="sec"><h2>Test the model you use</h2><p class="hint" data-css="margin:0 0 6px">Run a ready-made set of tasks against the model you use now, see which it got right, what it cost, and whether anything that used to work has stopped.</p>
  <div class="ctl ev15"><b>Test set</b><span class="right"><span class="seg" role="group" aria-label="Test set">${picks}</span></span><small>Each task is checked the same way every time.</small></div>
  ${state}
  <div class="acts" data-css="margin-top:8px"><button class="btn" type="button" data-act="eval-run" ${running || !suiteId ? "disabled" : ""}>${lastRun ? "Run again" : "Run the test"}</button></div></div>`;
}

const LIMITS_EMPTY = `<div class="sec"><h2>What each connection has left</h2></div>`;

const KEEPING = `<div class="sec"><h2>Keeping things</h2><div class="ctl"><b>Keep conversations</b><span class="right"><span class="seg" role="group" aria-label="Keep conversations"><button type="button" aria-pressed="false" data-act="seg">30 days</button><button type="button" aria-pressed="false" data-act="seg">1 year</button><button type="button" aria-pressed="false" data-act="seg">Forever</button></span></span><small>Older ones are deleted for good.</small></div><div class="ctl"><b>Checkpoints</b><span class="right"><button class="btn sm" type="button" data-act="toast">See all</button></span><small>Kept before a Trunk changes files. Put any of them back.</small></div></div>`;

export function draw() {
  return `<h1>Data &amp; usage</h1><p class="lede">What each connection has left, what Branch spent, what it keeps.</p>` + reportCard() + LIMITS_EMPTY + KEEPING + evalCard();
}

export function init() {
  loadUsage();
  loadSuites();
  on("rep15", (el) => { range = el.dataset.v; loadUsage(); });
  on("repopen15", () => openReport());
  on("eval-set", (el) => { if (running) return; suiteId = el.dataset.v; lastRun = null; loadLastRun(); });
  on("eval-run", () => runTest());
  markLive(["rep15", "repopen15", "eval-set", "eval-run"]);
}

export function load() { loadSuites(); return loadUsage(); }

export const live = { "rep15": true, "repopen15": true, "eval-set": true, "eval-run": true };

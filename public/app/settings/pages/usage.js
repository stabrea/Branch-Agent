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
import { seg15 } from "../rows15.js";
import { logo } from "../../core/logos.js";
import { level } from "../../core/state.js";
import { sections17, init17 } from "../p17-usage.js";

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
  /* The engine never lets a figure worked out from its own token count read as a bill; the page's own words say so. */
  const cost = s.dollars == null ? "" : ` · cost $${s.dollars.toFixed(2)}${run.costBasis === "reported" ? "" : " · estimated from each model’s price"}`;
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

/* ---------- What each connection has left (GET /api/usage/glance), 1:1 with the status bar's list ---------- */
let glance = null;
let limits = null;
const CHIP = { measured: '<span class="pill ok">Measured</span>', estimated: '<span class="pill warn">Estimate</span>', not_published: '<span class="pill idle">Not published</span>' };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function windowRow(w, estimated) {
  if (w.kind === "money" || !w.limit || w.remaining == null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span>${w.remaining == null ? "" : esc(String(w.remaining))}</span></div>`;
  const pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span>${pct}% left${w.resetAt ? " · resets " + esc(clock(w.resetAt)) : ""}</span></div>`;
}

function limitRow(r) {
  const body = (r.windows ?? []).map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(r.note)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP[r.state] ?? ""}${r.inUse ? '<span class="pill ok">used next</span>' : ""}</div>${body}</div></div>`;
}

async function loadGlance() {
  const [g, l] = await Promise.all(["usage/glance", "usage/limits/settings"].map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  glance = g; limits = l?.usageLimits ?? null;
  renderNow();
}

/* The ring and the save-progress offer (POST /api/usage/glance/settings, merged) and asking a service what is left
   (POST /api/usage/limits/settings, a three-way switch: on unless "off", turned on as "when-needed"). The tray has no
   route, so it stays greyed; the prototype's "Show me" only played its own demo, so it is not drawn. */
const WIRES = {
  "u-ring": [() => glance?.settings?.ring === "shown", (on) => api("usage/glance/settings", { ring: on ? "shown" : "hidden" })],
  "u-ckpt": [() => glance?.settings?.saveProgress === "ask", (on) => api("usage/glance/settings", { saveProgress: on ? "ask" : "off" })],
  "u-ask": [() => Boolean(limits?.mode) && limits.mode !== "off", (on) => api("usage/limits/settings", { mode: on ? "when-needed" : "off" })],
};
const checked = (id) => (WIRES[id][0]() ? "checked" : "");

function limitsSec() {
  return `<div class="sec"><h2>What each connection has left</h2><p class="hint" data-css="margin:0 0 6px">How much of each service’s allowance is still there: one row per connection, one row per account. Every figure arrived on traffic Branch was already sending.</p><div class="lims flat">${(glance?.rows ?? []).map(limitRow).join("")}</div>
    <div class="ctl"><b>The ring bottom right</b><input class="sw" type="checkbox" id="u-ring" ${checked("u-ring")} aria-label="Show the ring" data-sw="ring"><small>The connection used next, how much of its window is left, and when it refills.</small></div>
    <div class="ctl"><b>Offer to save progress at 95%</b><input class="sw" type="checkbox" id="u-ckpt" ${checked("u-ckpt")} aria-label="Offer to save progress at 95%" data-sw="ckpt"><small>It only asks, once per connection per window, and never for an estimate.</small></div>
    <div class="ctl"><b>Asking a service what is left</b><input class="sw" type="checkbox" id="u-ask" ${checked("u-ask")} aria-label="Asking a service what is left" data-sw="set"><small>Only OpenRouter documents a way to ask. Off until you switch it on. Subscriptions are never asked.</small></div>
    <div class="ctl"><b>Show usage in the tray</b><input class="sw" type="checkbox" id="u-tray" aria-label="Show usage in the tray" data-sw="set"><small>A small ring by the clock opens the same list.</small></div></div>`;
}

/* Spend by Trunk: the engine keeps no spend per Trunk, so no bars are drawn; the month's total is the engine's. */
function spendSec() {
  const month = glance?.month?.pricedRuns ? `<p class="hint">This month: $${Number(glance.month.cost).toFixed(2)}. Plans are billed by their own sites; work on this computer is free.</p>` : "";
  return `<div class="sec"><h2>Spend, last 7 days</h2><div class="bars"></div>${month}</div>`;
}

/* Keeping conversations deletes older ones for good, and checkpoints have no list here yet, so both stay greyed; the
   pressed choice is the engine's own retention setting (GET /api/retention). */
let retention = null;
function keeping() {
  const r = retention;
  const cur = !r ? null : !r.enabled || !r.keepDays ? "forever" : r.keepDays === 30 ? "30" : r.keepDays === 365 ? "365" : null;
  return `<div class="sec"><h2>Keeping things</h2>${seg15("Keep conversations", "Older ones are deleted for good.", [["30", "30 days"], ["365", "1 year"], ["forever", "Forever"]], cur)}<div class="ctl"><b>Checkpoints</b><span class="right"><button class="btn sm" type="button" data-act="soon">See all</button></span><small>Kept before a Trunk changes files. Put any of them back.</small></div></div>`;
}

async function loadRetention() {
  try { retention = (await api("retention")).settings ?? null; } catch (error) { toast(error.message); }
  renderNow();
}

export function draw() {
  return `<h1>Data &amp; usage</h1><p class="lede">What each connection has left, what Branch spent, what it keeps.</p>` + reportCard() + limitsSec() + spendSec() + keeping() + evalCard() + sections17(level());
}

export function init() {
  init17();
  loadUsage();
  loadSuites();
  loadGlance();
  loadRetention();
  markLive(["sw:u-ring", "sw:u-ckpt", "sw:u-ask"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadGlance();
  });
  on("rep15", (el) => { range = el.dataset.v; loadUsage(); });
  on("repopen15", () => openReport());
  on("eval-set", (el) => { if (running) return; suiteId = el.dataset.v; lastRun = null; loadLastRun(); });
  on("eval-run", () => runTest());
  markLive(["rep15", "repopen15", "eval-set", "eval-run"]);
}

export function load() { loadSuites(); loadGlance(); loadRetention(); return loadUsage(); }

export const live = { "rep15": true, "repopen15": true, "eval-set": true, "eval-run": true };

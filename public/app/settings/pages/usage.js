/* Settings › Data & usage. The report card adds up the engine's own usage for the last 7, 30 or 90 days
   (GET /api/usage?range=), and "Open the report" shows the engine's usage report for that stretch
   (POST /api/usage/report { range, format }), which answers only while the usage-report switch is on. */
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { api } from "../../core/api.js";
import { toast, openDlg } from "../../core/ui.js";
import { esc, renderNow } from "../../core/dom.js";

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

const LIMITS_EMPTY = `<div class="sec"><h2>What each connection has left</h2></div>`;

const KEEPING = `<div class="sec"><h2>Keeping things</h2><div class="ctl"><b>Keep conversations</b><span class="right"><span class="seg" role="group" aria-label="Keep conversations"><button type="button" aria-pressed="false" data-act="seg">30 days</button><button type="button" aria-pressed="false" data-act="seg">1 year</button><button type="button" aria-pressed="false" data-act="seg">Forever</button></span></span><small>Older ones are deleted for good.</small></div><div class="ctl"><b>Checkpoints</b><span class="right"><button class="btn sm" type="button" data-act="toast">See all</button></span><small>Kept before a Trunk changes files. Put any of them back.</small></div></div><div class="sec"><h2>Test the model you use</h2><p class="hint" data-css="margin:0 0 6px">Run a ready-made set of tasks against the model you use now, see which it got right, what it cost, and whether anything that used to work has stopped.</p>
  <div class="ctl"><b>Test set</b><span class="right"><span class="seg" role="group" aria-label="Test set"><button type="button" aria-pressed="false" data-act="seg">Everyday - 20</button><button type="button" aria-pressed="false" data-act="seg">Money - 12</button><button type="button" aria-pressed="false" data-act="seg">Research - 15</button></span></span><small>Each task is checked the same way every time.</small></div>

  <div class="acts" data-css="margin-top:8px"><button class="btn" type="button" data-act="eval-run">Run the test</button></div></div>`;

export function draw() {
  return `<h1>Data &amp; usage</h1><p class="lede">What each connection has left, what Branch spent, what it keeps.</p>` + reportCard() + LIMITS_EMPTY + KEEPING;
}

export function init() {
  loadUsage();
  /* "Run the test" stays greyed: POST /api/evaluation/run needs the suite the "Test set" choice names, and that choice
     is not wired to the engine's suites yet. */
  on("rep15", (el) => { range = el.dataset.v; loadUsage(); });
  on("repopen15", () => openReport());
  markLive(["rep15", "repopen15"]);
}

export function load() { return loadUsage(); }

export const live = { "rep15": true, "repopen15": true };

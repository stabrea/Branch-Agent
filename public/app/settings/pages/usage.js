/* Settings > usage: bind costs, limits, and usage data from engine. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";

const REPORT = `<div class="rep15"><div class="rep-h15"><span><small>Last 30 days</small><b>$0.00</b><em>0 tasks</em></span><span class="seg" role="group" aria-label="Period"><button type="button" aria-pressed="false" data-act="rep15" data-v="7">7 days</button><button type="button" aria-pressed="true" data-act="rep15" data-v="30">30 days</button><button type="button" aria-pressed="false" data-act="rep15" data-v="90">90 days</button></span></div><button class="btn sm" type="button" data-act="repopen15">Open the report</button></div>`;

const LIMITS_EMPTY = `<div class="sec"><h2>What each connection has left</h2><p class="hint" data-css="margin:0 0 6px">No accounts configured yet.</p></div>`;

const KEEPING = `<div class="sec"><h2>Keeping things</h2><div class="ctl"><b>Keep conversations</b><span class="right"><span class="seg" role="group" aria-label="Keep conversations"><button type="button" aria-pressed="false" data-act="seg">30 days</button><button type="button" aria-pressed="false" data-act="seg">1 year</button><button type="button" aria-pressed="true" data-act="seg">Forever</button></span></span><small>Older ones are deleted for good.</small></div><div class="ctl"><b>Checkpoints</b><span class="right"><button class="btn sm" type="button" data-act="toast" data-msg="See all checkpoints.">See all</button></span><small>Kept before a Trunk changes files. Put any of them back.</small></div></div><div class="sec"><h2>Test the model you use</h2><p class="hint" data-css="margin:0 0 6px">Run a ready-made set of tasks against the model you use now, see which it got right, what it cost, and whether anything that used to work has stopped.</p>
  <div class="ctl"><b>Test set</b><span class="right"><span class="seg" role="group" aria-label="Test set"><button type="button" aria-pressed="true" data-act="seg">Everyday - 20</button><button type="button" aria-pressed="false" data-act="seg">Money - 12</button><button type="button" aria-pressed="false" data-act="seg">Research - 15</button></span></span><small>Each task is checked the same way every time.</small></div>

  <div class="acts" data-css="margin-top:8px"><button class="btn" type="button" data-act="eval-run">Run the test</button></div></div>`;

export function draw() {
  return `<h1>Data &amp; usage</h1><p class="lede">What each connection has left, what Branch spent, what it keeps.</p>` + REPORT + LIMITS_EMPTY + KEEPING;
}

on("rep15", () => {
  // Handle period change
});

on("repopen15", () => {
  // Open full usage report
});

markLive(["rep15", "repopen15", "eval-run", "sw:u-ring", "sw:u-ckpt", "sw:u-ask", "sw:u-tray"]);

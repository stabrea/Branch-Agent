/* Settings > computer: bind computer list and Trunk-to-computer assignments from engine. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { av, toast } from "../../core/ui.js";

function buildTrunkRow(trunk) {
  const id = esc(trunk.id || "");
  const name = esc(trunk.name || "");
  const avatar = av(trunk, 32);

  return `<div class="prow percomp8">${avatar}<span class="grow"><b>${name}</b><span class="chips8"><button type="button" class="chip6" data-act="comp-chip" data-id="${id}" aria-pressed="false">This computer</button></span></span><label class="max8"><small>At once</small><span class="seg"><button type="button" data-act="comp-max" data-id="${id}" data-v="1" aria-pressed="false">1</button><button type="button" data-act="comp-max" data-id="${id}" data-v="2" aria-pressed="false">2</button><button type="button" data-act="comp-max" data-id="${id}" data-v="3" aria-pressed="false">3</button><button type="button" data-act="comp-max" data-id="${id}" data-v="4" aria-pressed="false">4</button></span></label></div>`;
}

const BASE = `<h1>Computer &amp; browser</h1><p class="lede">The computers your Trunks may use, and the browser they work in. Which Branch you talk to is the switcher at the top of the list.</p>
  <div class="sec"><h2>Computers they may use</h2><div class="grp8">On this PC</div><div class="comps7"><div class="comp7-card"><span class="ico-tile"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="12" rx="2"></rect><path d="M9 20h6M12 16.5V20"></path></svg></span><span class="grow"><b>This computer</b><small>Your Windows desktop</small><span class="c7-reach">Your screen, mouse and apps. It asks before an app it hasn't used, and you can take over any time.</span></span><span class="pill ok"><i></i>Ready</span></div></div>
    <div class="acts" data-css="margin-top:10px"><button class="btn pri" type="button" data-act="comp-add"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add a computer</button></div></div><div class="sec"><h2>Which Trunk uses which</h2><p class="hint" data-css="margin:0 0 8px">A Trunk can use several computers, one task on each, side by side.</p><div class="rows">`;

function buildTrunksSection(trunks) {
  if (!trunks || trunks.length === 0) {
    return `<p class="hint">No Trunks configured yet.</p>`;
  }
  return trunks.map(buildTrunkRow).join("");
}

const COMPUTER_SETTINGS = `</div>
  <div class="sec"><h2>On a computer</h2><div class="ctl"><b>See the screen and use the mouse</b><input class="sw" type="checkbox" id="c-screen" aria-label="See the screen and use the mouse" data-sw="set"><small>Needed for apps without a connection. You can always take over.</small></div><div class="ctl"><b>Ask before opening an app it hasn't used</b><input class="sw" type="checkbox" id="c-ask" aria-label="Ask before opening an app it hasn't used" data-sw="set"><small>Once per app, per Trunk.</small></div><div class="ctl"><b>Where scripts run</b><span class="right"><span class="seg" role="group" aria-label="Where scripts run"><button type="button" aria-pressed="false" data-act="seg">Sealed box</button><button type="button" aria-pressed="false" data-act="seg">This computer</button></span></span><small>A sealed box keeps scripts away from your files unless a task needs them.</small></div></div>
  <div class="sec"><h2>The browser</h2><div class="ctl"><b>Which browser</b><span class="right"><span class="seg" role="group" aria-label="Which browser"><button type="button" aria-pressed="false" data-act="seg">Branch's own</button><button type="button" aria-pressed="false" data-act="seg">Your Chrome</button></span></span><small>Its own profile keeps your tabs and sign-ins separate.</small></div><div class="ctl"><b>Ask before a site it hasn't visited</b><input class="sw" type="checkbox" id="b-new" aria-label="Ask before a site it hasn't visited" data-sw="set"><small>You say yes once per site.</small></div><div class="ctl"><b>Open the browser full size when a task starts</b><input class="sw" type="checkbox" id="b-watch" aria-label="Open the browser full size when a task starts" data-sw="set"><small>Otherwise it stays small in the corner.</small></div></div>
  <p class="hint">Switch to Technical (bottom left) to see file paths, ports and raw settings.</p>`;

const ADVANCED_EXTRA = `<div class="sec x15-sec"><h2>Phones lent to Branch</h2><div class="rows"></div></div>
  <div class="sec x15-sec"><h2>The browser, more</h2><div class="ctl"><b>Run the browser in a sandbox</b><span class="right"><span class="seg" role="group" aria-label="Run the browser in a sandbox"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="false" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">On</button></span></span><small></small></div><div class="ctl"><b>Record browser tasks</b><input class="sw" type="checkbox" id="f15-record-browser-tasks" aria-label="Record browser tasks" data-sw="set"><small>A step-by-step trace you can replay.</small></div><div class="ctl"><b>Number the clickable things</b><input class="sw" type="checkbox" id="f15-number-the-clickable-things" aria-label="Number the clickable things" data-sw="set"><small>Faster and steadier on busy pages.</small></div><div class="ctl"><b>Site skills</b><span class="right"><button class="btn sm" type="button" data-act="site-skills">See the sites</button></span><small>What Branch learned about the sites you use.</small></div><div class="ctl"><b>Page notes and "Send to Branch"</b><input class="sw" type="checkbox" id="f15-page-notes-and-send-to-branch-" aria-label="Page notes and "Send to Branch"" data-sw="set"><small>A right-click in Chrome or Edge sends the page to a Trunk. Turns on when the browser extension is installed.</small></div></div><div class="sec x15-sec"><h2>Code</h2><div class="ctl"><b>Try ideas on a branch</b><input class="sw" type="checkbox" id="f15-try-ideas-on-a-branch" aria-label="Try ideas on a branch" data-sw="set"><small>A plan can be tried, compared and merged; a forked conversation gets its own copy.</small></div><div class="ctl"><b>Code map</b><input class="sw" type="checkbox" id="f15-code-map" aria-label="Code map" data-sw="set"><small>A ranked outline of a repository so a Trunk finds its way.</small></div><div class="ctl"><b>Check and format files after editing</b><input class="sw" type="checkbox" id="f15-check-and-format-files-after-editing" aria-label="Check and format files after editing" data-sw="set"><small></small></div><div class="ctl"><b>AI! and AI? comments start tasks</b><input class="sw" type="checkbox" id="f15-ai-and-ai-comments-start-tasks" aria-label="AI! and AI? comments start tasks" data-sw="set"><small>Write "AI! add tests" in a file and a Trunk picks it up. On because GitHub is connected.</small></div><div class="ctl"><b>Draft a pull request from a task</b><input class="sw" type="checkbox" id="f15-draft-a-pull-request-from-a-task" aria-label="Draft a pull request from a task" data-sw="set"><small>Never merged by Branch.</small></div><div class="ctl"><b>Remember the shell</b><input class="sw" type="checkbox" id="f15-remember-the-shell" aria-label="Remember the shell" data-sw="set"><small>PATH, aliases and functions, so commands behave as in your terminal.</small></div></div>`;

const TECHNICAL_EXTRA = `<div class="sec"><h2>Technical</h2><dl class="kv"><dt>Private computer</dt><dd>Windows Sandbox</dd><dt>Browser profile</dt><dd>%APPDATA%\\Branch Agent\\browser-profile</dd><dt>Screen</dt><dd>1280 x 800, 2 frames a second while watched</dd></dl></div><div class="sec x15-sec"><h2>Phones lent to Branch</h2><div class="rows"></div></div>
  <div class="sec x15-sec"><h2>The browser, more</h2><div class="ctl"><b>Run the browser in a sandbox</b><span class="right"><span class="seg" role="group" aria-label="Run the browser in a sandbox"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="false" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">On</button></span></span><small></small></div><div class="ctl"><b>Record browser tasks</b><input class="sw" type="checkbox" id="f15-record-browser-tasks" aria-label="Record browser tasks" data-sw="set"><small>A step-by-step trace you can replay.</small></div><div class="ctl"><b>Number the clickable things</b><input class="sw" type="checkbox" id="f15-number-the-clickable-things" aria-label="Number the clickable things" data-sw="set"><small>Faster and steadier on busy pages.</small></div><div class="ctl"><b>Site skills</b><span class="right"><button class="btn sm" type="button" data-act="site-skills">See the sites</button></span><small>What Branch learned about the sites you use.</small></div><div class="ctl"><b>Page notes and "Send to Branch"</b><input class="sw" type="checkbox" id="f15-page-notes-and-send-to-branch-" aria-label="Page notes and "Send to Branch"" data-sw="set"><small>A right-click in Chrome or Edge sends the page to a Trunk. Turns on when the browser extension is installed.</small></div></div><div class="sec x15-sec"><h2>Code</h2><div class="ctl"><b>Try ideas on a branch</b><input class="sw" type="checkbox" id="f15-try-ideas-on-a-branch" aria-label="Try ideas on a branch" data-sw="set"><small>A plan can be tried, compared and merged; a forked conversation gets its own copy.</small></div><div class="ctl"><b>Code map</b><input class="sw" type="checkbox" id="f15-code-map" aria-label="Code map" data-sw="set"><small>A ranked outline of a repository so a Trunk finds its way.</small></div><div class="ctl"><b>Check and format files after editing</b><input class="sw" type="checkbox" id="f15-check-and-format-files-after-editing" aria-label="Check and format files after editing" data-sw="set"><small></small></div><div class="ctl"><b>AI! and AI? comments start tasks</b><input class="sw" type="checkbox" id="f15-ai-and-ai-comments-start-tasks" aria-label="AI! and AI? comments start tasks" data-sw="set"><small>Write "AI! add tests" in a file and a Trunk picks it up. On because GitHub is connected.</small></div><div class="ctl"><b>Draft a pull request from a task</b><input class="sw" type="checkbox" id="f15-draft-a-pull-request-from-a-task" aria-label="Draft a pull request from a task" data-sw="set"><small>Never merged by Branch.</small></div><div class="ctl"><b>Remember the shell</b><input class="sw" type="checkbox" id="f15-remember-the-shell" aria-label="Remember the shell" data-sw="set"><small>PATH, aliases and functions, so commands behave as in your terminal.</small></div></div><div class="sec x15-sec"><h2>On a computer, more</h2><div class="ctl"><b>Work in apps in the background</b><input class="sw" type="checkbox" id="f15-work-in-apps-in-the-background" aria-label="Work in apps in the background" data-sw="set"><small>Through the accessibility tree, without taking the screen.</small></div><div class="ctl"><b>Read Jupyter notebooks</b><input class="sw" type="checkbox" id="f15-read-jupyter-notebooks" aria-label="Read Jupyter notebooks" data-sw="set"><small>Cells, outputs and charts.</small></div><div class="ctl"><b>Review checks and a checklist per task</b><input class="sw" type="checkbox" id="f15-review-checks-and-a-checklist-per-task" aria-label="Review checks and a checklist per task" data-sw="set"><small>Checks you write run before a task says it's done; the checklist shows in the task.</small></div><div class="ctl"><b>Write AGENTS.md for a project</b><span class="right"><code class="code15">/init</code></span><small>Branch reads the project and writes its house rules.</small></div></div>`;

async function loadTrunks() {
  try {
    // The Trunks come with the engine's state (core/state.js keeps E.trunks as the list); nothing to replace here.
    render();
  } catch (e) {
    console.error("Failed to load trunks:", e);
  }
}

export function init() {
  loadTrunks();
}

export async function load() {
  await loadTrunks();
}

export const live = {
};

export function draw() {
  const trunks = E.trunks || [];
  const lev = level();
  const trunkRows = buildTrunksSection(trunks);

  let html = BASE + trunkRows + COMPUTER_SETTINGS;

  if (lev >= 1) html += ADVANCED_EXTRA;
  if (lev >= 2) html += TECHNICAL_EXTRA;

  return html;
}

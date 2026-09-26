/* Settings › Computer & browser, 1:1 with the prototype at each level. The computers are this one and the owner's other
   devices (GET /api/devices); the Trunks are the engine's. A switch shows the engine's own value; it is live only where a
   route changes it (WIRES below), and a three-way feature switch reads as on unless its mode is "off", turns on as
   "when-needed" and off as "off". Letting Trunks use the screen, approvals, sandboxes, borrowing your own browser and
   stopping a device's lending change what Branch may do, so those stay greyed. */
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { markLive } from "../../core/features.js";
import { esc, render } from "../../core/dom.js";
import { av, toast, ic } from "../../core/ui.js";
import { id15, sw15, btn15, code15, seg15, sec15 } from "../rows15.js";

const D = { coding: null, notes: null, prs: null, devices: null };
const onMode = (mode) => (mode ? mode !== "off" : false);
const coding = (part) => onMode(D.coding?.modes?.[part]);
const setCoding = (part, on) => api("coding/switch", { part, mode: on ? "when-needed" : "off" });

/* Each live switch: its current value from the engine, and the route that changes it. */
const WIRES = {
  [id15("Page notes and “Send to Branch”")]: [() => onMode(D.notes?.mode), (on) => api("browser/notes/settings", { mode: on ? "when-needed" : "off" })],
  [id15("Try ideas on a branch")]: [() => coding("worktrees"), (on) => setCoding("worktrees", on)],
  [id15("Check and format files after editing")]: [() => coding("format-on-edit"), (on) => setCoding("format-on-edit", on)],
  [id15("Draft a pull request from a task")]: [() => onMode(D.prs?.mode), (on) => api("developer/pull-requests", { mode: on ? "when-needed" : "off" })],
  [id15("Remember the shell")]: [() => coding("shell-snapshot"), (on) => setCoding("shell-snapshot", on)],
  [id15("Read a file before editing it")]: [() => coding("read-first"), (on) => setCoding("read-first", on)],
  [id15("Keep large tool outputs")]: [() => coding("large-output"), (on) => setCoding("large-output", on)],
  [id15("Read Jupyter notebooks")]: [() => coding("notebooks"), (on) => setCoding("notebooks", on)],
  [id15("Review checks and a checklist per task")]: [() => coding("review-checks") && coding("checklist"),
    async (on) => { await setCoding("review-checks", on); await setCoding("checklist", on); }],
};
const sw = (title, sub) => sw15(title, sub, WIRES[id15(title)]?.[0]() ?? false);

async function loadAll() {
  const [c, n, p, d] = await Promise.all(["coding", "browser/notes/settings", "developer/pull-requests", "devices"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { coding: c, notes: n?.settings ?? null, prs: p, devices: d });
  render();
}

export function init() {
  markLive(Object.keys(WIRES).map((id) => "sw:" + id));
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire[1](e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = {};

/* ---------- computers ---------- */
const DESKTOP = ["win32", "darwin", "linux"];
const PLATFORM = { win32: "Windows", darwin: "macOS", linux: "Linux", ios: "iOS", android: "Android" };
const card = (icon, name, sub, extra = "") => `<div class="comp7-card"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${name}</b><small>${sub}</small>${extra}</span></div>`;

function computers() {
  const others = (D.devices?.devices ?? []).filter((d) => DESKTOP.includes(d.platform));
  const mine = card("monitor", "This computer", "Your Windows desktop", `<span class="c7-reach">Your screen, mouse and apps. It asks before an app it hasn’t used, and you can take over any time.</span>`);
  const theirs = others.length ? `<div class="grp8">Your other computers</div><div class="comps7">${others.map((d) => card("monitor", esc(d.name), esc(PLATFORM[d.platform] ?? d.platform))).join("")}</div>` : "";
  const cloud = `<div class="grp8">In the cloud</div><div class="comps7"><div class="comp7-card off7"><span class="ico-tile">${ic("globe", "s")}</span><span class="grow"><b>KeepOak computer</b><small>Linux · in the cloud · stays on</small><span class="c7-reach">Keeps working while this PC sleeps. Hermes Agent and OpenClaw run there too.</span></span><button class="btn sm" type="button" data-act="ko-start">Connect keepoak.com</button></div></div>`;
  return `<div class="sec"><h2>Computers they may use</h2><div class="grp8">On this PC</div><div class="comps7">${mine}</div>${theirs}${cloud}
    <div class="acts" data-css="margin-top:10px"><button class="btn pri" type="button" data-act="comp-add">${ic("plus", "s")}Add a computer</button></div></div>`;
}

/* Which Trunk uses which: the engine keeps no list of computers per Trunk, nor a limit, so the chips stay greyed. */
function trunkRow(trunk) {
  const id = esc(trunk.id ?? trunk.name ?? "");
  const nums = [1, 2, 3, 4].map((n) => `<button type="button" data-act="comp-max" data-id="${id}" data-v="${n}" aria-pressed="false">${n}</button>`).join("");
  return `<div class="prow percomp8">${av(trunk, 32)}<span class="grow"><b>${esc(trunk.name ?? "")}</b><span class="chips8"><button type="button" class="chip6" data-act="comp-chip" data-id="${id}" data-v="this" aria-pressed="false">This computer</button></span></span><label class="max8"><small>At once</small><span class="seg">${nums}</span></label></div>`;
}

function whichTrunk() {
  return `<div class="sec"><h2>Which Trunk uses which</h2><p class="hint" data-css="margin:0 0 8px">A Trunk can use several computers, one task on each, side by side.</p><div class="rows">${(E.trunks ?? []).map(trunkRow).join("")}</div></div>`;
}

const ON_A_COMPUTER = `<div class="sec"><h2>On a computer</h2><div class="ctl"><b>See the screen and use the mouse</b><input class="sw" type="checkbox" id="c-screen" aria-label="See the screen and use the mouse" data-sw="set"><small>Needed for apps without a connection. You can always take over.</small></div><div class="ctl"><b>Ask before opening an app it hasn’t used</b><input class="sw" type="checkbox" id="c-ask" aria-label="Ask before opening an app it hasn’t used" data-sw="set"><small>Once per app, per Trunk.</small></div>${seg15("Where scripts run", "A sealed box keeps scripts away from your files unless a task needs them.", [["sealed", "Sealed box"], ["this", "This computer"]], null)}</div>`;

const BROWSER = `<div class="sec"><h2>The browser</h2>${seg15("Which browser", "Its own profile keeps your tabs and sign-ins separate.", [["own", "Branch’s own"], ["chrome", "Your Chrome"]], null)}<div class="ctl"><b>Ask before a site it hasn’t visited</b><input class="sw" type="checkbox" id="b-new" aria-label="Ask before a site it hasn’t visited" data-sw="set"><small>You say yes once per site.</small></div><div class="ctl"><b>Open the browser full size when a task starts</b><input class="sw" type="checkbox" id="b-watch" aria-label="Open the browser full size when a task starts" data-sw="set"><small>Otherwise it stays small in the corner.</small></div></div>`;

/* Phones lent to Branch: the owner's paired phones. Stopping one takes back a pairing, so it stays greyed. */
function phones() {
  const list = (D.devices?.devices ?? []).filter((d) => !DESKTOP.includes(d.platform));
  const rows = list.map((d) => `<div class="prow"><span class="ico-tile">${ic("phone", "s")}</span><span class="grow"><b>${esc(d.name)}</b><small>${esc((d.enabled ?? []).join(", "))}</small></span><button class="btn ghost sm" type="button" data-act="lend15" data-v="${esc(d.id)}">Stop lending</button></div>`).join("");
  return `<div class="sec x15-sec"><h2>Phones lent to Branch</h2><div class="rows">${rows}</div></div>`;
}

const browserMore = () => sec15("The browser, more",
  seg15("Run the browser in a sandbox", "", [["off", "Off"], ["when-needed", "When needed"], ["on", "On"]], null)
  + sw("Record browser tasks", "A step-by-step trace you can replay.")
  + sw("Number the clickable things", "Faster and steadier on busy pages.")
  + btn15("Site skills", "What Branch learned about the sites you use.", "See sites", "site-skills")
  + sw("Page notes and “Send to Branch”", "A right-click in Chrome or Edge sends the page to a Trunk. Turns on when the browser extension is installed."));

const code = () => sec15("Code",
  sw("Try ideas on a branch", "A plan can be tried, compared and merged; a forked conversation gets its own copy.")
  + sw("Code map", "A ranked outline of a repository so a Trunk finds its way.")
  + sw("Check and format files after editing", "")
  + sw("AI! and AI? comments start tasks", "Write “AI! add tests” in a file and a Trunk picks it up.")
  + sw("Draft a pull request from a task", "Never merged by Branch.")
  + sw("Remember the shell", "PATH, aliases and functions, so commands behave as in your terminal."));

const codeTechnical = () => sec15("Code, technical",
  code15("Files Branch never reads", "Like .gitignore.", ".branchignore")
  + sw("Read a file before editing it", "Refuses an edit to a file it hasn’t read in this task.")
  + sw("Keep large tool outputs", "Saved to a file instead of cut off.")
  + btn15("Branch in CI", "A GitHub Action and a GitLab component.", "Copy the setup"));

const computerMore = () => sec15("On a computer, more",
  sw("Work in apps in the background", "Through the accessibility tree, without taking the screen.")
  + sw("Read Jupyter notebooks", "Cells, outputs and charts.")
  + sw("Review checks and a checklist per task", "Checks you write run before a task says it’s done; the checklist shows in the task.")
  + code15("Write AGENTS.md for a project", "Branch reads the project and writes its house rules.", "/init"));

export function draw() {
  const lev = level();
  let html = `<h1>Computer &amp; browser</h1><p class="lede">The computers your Trunks may use, and the browser they work in. Which Branch you talk to is the switcher at the top of the list.</p>`;
  html += computers() + whichTrunk() + ON_A_COMPUTER + BROWSER;
  if (lev < 2) html += `<p class="hint">Switch to Technical (bottom left) to see file paths, ports and raw settings.</p>`;
  else html += `<div class="sec"><h2>Technical</h2><dl class="kv"></dl></div>`; // the engine gives no sandbox, profile or screen facts
  html += phones();
  if (lev >= 1) html += browserMore() + code();
  if (lev >= 2) html += codeTechnical();
  if (lev >= 1) html += computerMore();
  return html;
}

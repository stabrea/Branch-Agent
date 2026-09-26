/* Settings > permissions: bind Trunks' permissions. Mount Mac/Windows OS permissions module. */
import { level } from "../../core/state.js";
import { E } from "../../core/state.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { render, esc } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { toast, ic } from "../../core/ui.js";
import { setLockdown } from "../../chat/approvals.js";
import { sections17, init17, load17 } from "../p17-permissions.js";

const HEAD = `<h1>Permissions</h1><p class="lede">What Trunks may do without asking you first.</p>`;

const BASE_SWITCHES = `@@STATUS@@
    <div class="sec"><h2>Without asking, Trunks may…</h2>
      <div class="ctl"><b>Read files in Documents and Downloads</b><input class="sw" type="checkbox" id="p-read" @@read@@ aria-label="Read files in Documents and Downloads" data-sw="set"><small>Reading never changes a file.</small></div>
      <div class="ctl"><b>Use the browser on this computer</b><input class="sw" type="checkbox" id="p-browse" @@browse@@ aria-label="Use the browser on this computer" data-sw="set"><small>Signs in with your saved sign-ins. You can take over any time.</small></div>
      <div class="ctl"><b>Send email and messages</b><input class="sw" type="checkbox" id="p-send" @@message@@ aria-label="Send email and messages" data-sw="set"><small>Off means every message waits for your yes.</small></div>
      <div class="ctl"><b>Install tools and packages</b><input class="sw" type="checkbox" id="p-install" aria-label="Install tools and packages" data-sw="set"><small>Off means a request shows up in your Inbox.</small></div>
      <div class="ctl"><b>Record tasks so you can watch them again</b><input class="sw" type="checkbox" id="p-record" aria-label="Record tasks so you can watch them again" data-sw="set"><small>Recordings stay on this computer.</small></div>
    </div>
    <details class="adv"><summary><svg class="i s chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>Advanced</summary>
      <div class="ctl"><b>When tools are loaded</b><span class="right"><span class="seg" role="group" aria-label="When tools are loaded"><button type="button" aria-pressed="false" data-act="seg">Never</button><button type="button" aria-pressed="false" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small>“When needed” keeps a tool one step away until a task calls for it.</small></div>
      <div class="ctl"><b>Stop a Trunk that repeats itself</b><input class="sw" type="checkbox" id="p-loop" aria-label="Stop a Trunk that repeats itself" data-sw="set"><small>After 5 identical steps it pauses and asks you.</small></div>
      <div class="ctl"><b>Trusted folders</b><span class="right"><button class="btn sm" type="button" data-act="soon">Add</button></span><small></small></div>
    </details>
    <div class="danger"><div><b>Lockdown</b><p>One switch that stops every Trunk from sending, changing or spending anything.</p></div><button class="btn bad" type="button" data-act="perm-lock">@@LOCK@@</button></div>`;

const PINNED = `<div class="sec"><h2>Pinned settings</h2><p class="hint" data-css="margin:0 0 8px">A pinned setting is fixed. Someone else who uses this computer sees it pinned and can’t change it any way.</p>@@PINS@@<div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="pin-add8"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Pin a setting</button></div></div>`;

const RULES = `<div class="sec x15-sec"><h2>Rules for each tool and folder</h2><p class="hint" data-css="margin:0 0 6px">The first rule that matches wins. Everything else follows the mode.</p><div class="rows"></div><div class="acts" data-css="margin-top:8px"><button class="btn sm" type="button" data-act="soon"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add a rule</button></div><div class="ctl"><b>Practice runs</b><input class="sw" type="checkbox" id="f15-practice-runs" aria-label="Practice runs" data-sw="set"><small>A Trunk can show what it would do without doing it.</small></div><div class="ctl"><b>Messages per conversation per hour</b><span class="right num15"><input class="inp" id="p-rate" aria-label="Messages per conversation per hour" data-sw="set" disabled></span><small>Stops a runaway loop.</small></div></div><div class="sec x15-sec"><h2>Checks before anything runs</h2><div class="ctl"><b>Scan commands for hidden characters</b><input class="sw" type="checkbox" id="f15-scan-commands-for-hidden-characters" aria-label="Scan commands for hidden characters" data-sw="set"><small>Invisible and look-alike characters that hide what a command does.</small></div><div class="ctl"><b>Scan for personal details</b><input class="sw" type="checkbox" id="f15-scan-for-personal-details" aria-label="Scan for personal details" data-sw="set"><small>Card numbers, ID numbers and addresses are held back from outside services.</small></div><div class="ctl"><b>Authenticator code for sensitive tools</b><input class="sw" type="checkbox" id="f15-authenticator-code-for-sensitive-tools" aria-label="Authenticator code for sensitive tools" data-sw="set"><small>A six-digit code before sending money or deleting a lot.</small></div></div>`;

const ISOLATION = `<div class="sec x15-sec"><h2>Isolation</h2><div class="ctl"><b>A container per Trunk</b><span class="right"><span class="seg" role="group" aria-label="A container per Trunk"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="false" data-act="seg">For code</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small></small></div><div class="ctl"><b>System sandbox for commands</b><span class="right"><span class="seg" role="group" aria-label="System sandbox for commands"><button type="button" aria-pressed="false" data-act="seg">Off</button><button type="button" aria-pressed="false" data-act="seg">When needed</button><button type="button" aria-pressed="false" data-act="seg">Always</button></span></span><small></small></div><div class="ctl"><b>Add sign-ins from outside the sandbox</b><input class="sw" type="checkbox" id="f15-add-sign-ins-from-outside-the-sandbox" aria-label="Add sign-ins from outside the sandbox" data-sw="set"><small>The sandbox never holds a password; Branch adds it on the way out.</small></div><div class="ctl"><b>Verify each release</b><input class="sw" type="checkbox" id="f15-verify-each-release" aria-label="Verify each release" data-sw="set"><small>Checks the signature before installing an update.</small></div><div class="ctl"><b>Pin SSH hosts</b><input class="sw" type="checkbox" id="f15-pin-ssh-hosts" aria-label="Pin SSH hosts" data-sw="set"><small>Refuses a computer whose fingerprint changed.</small></div><div class="ctl"><b>Downloads may come from</b><span class="right"><span class="seg" role="group" aria-label="Downloads may come from"><button type="button" aria-pressed="false" data-act="seg">Anywhere</button><button type="button" aria-pressed="false" data-act="seg">Known sites</button><button type="button" aria-pressed="false" data-act="seg">Ask each time</button></span></span><small></small></div></div>`;

/* The approval policy as the engine keeps it (GET /api/policy, GET /api/approvals/categories, GET /api/lockdown). */
const P = { policy: null, presets: [], categories: [], locked: false, loaded: false, was: {} };
const SWITCH = { "p-read": "read", "p-browse": "browse", "p-send": "message" };

async function load() {
  const [pol, cats, lock, os, kit] = await Promise.all([api("policy").catch(() => null), api("approvals/categories").catch(() => null), api("lockdown").catch(() => null),
    api("os-permissions").catch((error) => { toast(error.message); return null; }), api("settings-kit").catch((error) => { toast(error.message); return null; })]);
  Object.assign(P, { policy: pol?.policy ?? null, presets: pol?.presets ?? [], categories: cats?.categories ?? [], locked: !!lock?.on, loaded: true,
    os: os ?? null, pins: kit?.pins ?? [] });
  render();
}

/* This Mac / This PC (GET /api/os-permissions): one row for each permission the engine checked, in the prototype's words
   and order, with its pill from the engine's state. Opening the computer's own settings stays greyed. */
const OS_ROWS = {
  darwin: [["screen", "screen16", "Screen Recording", "Seeing the screen, so a Trunk can find what to click"],
    ["microphone", "mic", "Microphone", "Talking to Branch and the wake word"], ["camera", "cam16", "Camera", "Photos and scanning a code"]],
  win32: [["microphone", "mic", "Microphone", "Talking to Branch and the wake word"], ["camera", "cam16", "Camera", "Photos and scanning a code"]],
};
const PILL = { allowed: '<span class="pill ok"><i></i>Granted</span>', refused: '<span class="pill bad16"><i></i>Turned off</span>' };
function osSection() {
  const mac = P.os?.platform === "darwin";
  const rows = (OS_ROWS[P.os?.platform] ?? []).map(([cap, icon, title, sub]) => [P.os.permissions.find((x) => x.capability === cap), icon, title, sub]).filter(([x]) => x);
  if (!rows.length) return "";
  const html = rows.map(([x, icon, title, sub]) => `<div class="prow perm16"><span class="ico-tile">${ic(icon, "s")}</span><span class="grow"><b>${title}</b><small>${sub}</small></span>${PILL[x.state] ?? '<span class="pill idle"><i></i>Not yet</span>'}${x.state === "allowed" ? "" : `<button class="btn sm" type="button" data-act="sys16" data-v="${esc(x.capability)}">${mac ? "Open System Settings" : "Open Windows Settings"}</button>`}</div>`).join("");
  const granted = rows.filter(([x]) => x.state === "allowed").length;
  const hint = mac ? `${granted} of ${rows.length} granted. macOS keeps these in System Settings › Privacy &amp; Security; Branch asks for each one the first time a Trunk needs it.`
    : "Windows asks for very little. Seeing the screen and using the mouse need nothing here; Branch still asks you before it takes over.";
  return `<div class="sec x15-sec"><h2>${mac ? "This Mac" : "This PC"}</h2><p class="hint" data-css="margin:0 0 6px">${hint}</p><div class="rows">${html}</div></div>`;
}

/* Pinned settings from GET /api/settings-kit. Unpinning lets someone else change it again, so Unpin stays greyed. */
function pinRows() {
  if (!P.pins?.length) return '<div class="rows"></div>';
  return `<div class="rows">${P.pins.map((x, i) => `<div class="prow"><span class="ico-tile">${ic("pin", "s")}</span><span class="grow"><b>${esc(x.name)}</b><small>${esc(x.label)}</small></span><button class="btn ghost sm" type="button" data-act="pin-rm8" data-i="${i}">Unpin</button></div>`).join("")}</div>`;
}

/* On means "without asking": the kind is set to allow, or it has no rule of its own and the preset lets it through
   (reading is free under every preset; everything is, under No approvals). */
function allowed(id) {
  const decision = P.categories.find((c) => c.id === id)?.decision ?? null;
  if (decision) return decision === "allow";
  return id === "read" || P.policy?.preset === "off";
}

function fill(html) {
  const preset = P.presets.find((x) => x.id === P.policy?.preset);
  const status = preset ? `<div class="status"><span class="sdot ${P.policy.preset === "off" ? "warn" : ""}"></span><div><b>${esc(preset.label)}</b><p>${esc(preset.description)}</p></div></div>` : "";
  return html.replace("@@STATUS@@", status).replace("@@PINS@@", pinRows()).replace("@@LOCK@@", P.locked ? "Turn Lockdown off" : "Turn Lockdown on")
    .replace(/@@(read|browse|message)@@/g, (_, id) => (allowed(id) ? "checked" : ""));
}

/* Lockdown can change elsewhere (the banner's "Turn it off"); the window marks #app "locked" from the engine
   (chat/approvals.js syncLockdown). When that mark changes, the page re-reads the engine once. */
let seenLock = null;
function followLockdown() {
  const mark = document.getElementById("app")?.classList.contains("locked") ?? null;
  if (mark === null || mark === seenLock) return;
  const first = seenLock === null;
  seenLock = mark;
  if (!first && P.loaded) load();
}

export function draw() {
  followLockdown();
  const lev = level();
  let html = HEAD + osSection() + BASE_SWITCHES + PINNED;
  if (lev >= 1) html += RULES;
  if (lev >= 2) html += ISOLATION;
  return fill(html) + sections17(lev);
}

export function init() {
  markLive(["sw:p-read", "sw:p-browse", "sw:p-send", "perm-lock"]);
  // Through the same path as the banner, so the banner and this page agree; then the page re-reads.
  on("perm-lock", async () => { await setLockdown(!P.locked); await load(); });
  document.addEventListener("change", async (e) => {
    const id = SWITCH[e.target.id];
    if (!id) return;
    // Turning a kind back off restores a refusal the owner had written, rather than loosening it to "ask".
    const before = P.categories.find((c) => c.id === id)?.decision ?? null;
    if (e.target.checked) P.was[id] = before;
    const off = P.was[id] === "deny" ? "deny" : "ask";
    try { await api("approvals/categories", { [id]: e.target.checked ? "allow" : off }); } catch (error) { toast(error.message); }
    await load();
  });
  load();
  init17();
}

/* Re-opening the page re-reads both halves. */
const reload = () => Promise.all([load(), load17()]);
export { reload as load };



/* Settings › advanced: bind real engine data and wire controls. */
import { esc, render } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api, token } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";
import { toast, openDlg } from "../../core/ui.js";
import { seg15 } from "../rows15.js";

/* The engine's own values: show the thinking (GET/POST /api/knobs, reasoning card, merged), the activity log
   (GET/POST /api/diagnostics/log/settings, merged; a three-way switch, on unless "off", turned on as "when-needed"),
   the model on this computer (GET /api/local-models), the browser's profiles (GET /api/browser/profiles) and the
   standing orders (GET /api/autonomy/orders). Crash reports need a linked destination first, so they stay greyed. */
const D = { knobs: null, log: null, local: null, profiles: null, orders: null };

const WIRES = {
  "ad-think": (on) => api("knobs", { card: "reasoning", values: { showReasoning: on } }),
  "ad-log": (on) => api("diagnostics/log/settings", { mode: on ? "when-needed" : "off" }),
};

async function loadAll() {
  const [knobs, log, local, profiles, orders] = await Promise.all(["knobs", "diagnostics/log/settings", "local-models", "browser/profiles", "autonomy/orders"]
    .map((path) => api(path).catch((error) => { toast(error.message); return null; })));
  Object.assign(D, { knobs: knobs?.values ?? null, log, local, profiles: profiles?.profiles ?? null, orders: orders?.orders ?? null });
  render();
}

const kv = (rows) => rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");
const tile = (title, rows) => `<div class="tile" data-css="margin-top:12px"><div class="th"><b>${title}</b></div><dl class="kv" data-css="background:none;padding:0">${kv(rows)}</dl><div class="acts"><button class="btn sm" type="button" data-act="soon">Restart</button><button class="btn ghost sm" type="button" data-act="soon">Open logs</button></div></div>`;

/* The first model the engine finds on this computer: its name and how much it can hold. */
function localTile() {
  const l = D.local;
  const m = l?.oneClick?.loaded?.[0] ?? l?.ollama?.models?.[0] ?? l?.lmStudio?.models?.[0] ?? null;
  return tile("Model on this computer", [["Model", m?.name], ["Room", m?.contextLength]]);
}

function browserTile() {
  return tile("Browser", [["Profile", (D.profiles ?? []).map((p) => p.name ?? p.id ?? "").filter(Boolean).join(", ")]]);
}

export function draw() {
  const lv = level();
  const s = E.state || {};

  let html = "<h1>Advanced</h1><p class=\"lede\">What’s running under the hood, for when something needs a look.</p>";

  // Service diagnostics
  html += "<div class=\"tile\" data-css=\"margin-top:12px\"><div class=\"th\"><b>Branch service</b><span class=\"pill done ml\"><i></i>Running</span></div>";
  html += "<dl class=\"kv\" data-css=\"background:none;padding:0\">";
  html += [["Version", s.version], ["Address", location.host]].filter(([, v]) => v).map(([k, v]) => "<dt>" + k + "</dt><dd>" + esc(v) + "</dd>").join("");
  html += "</dl>";
  /* Restart relaunches through the desktop app's bridge only (the engine's own route refuses on Windows and outside a
     supervisor), so it stays greyed here. Open logs shows what the engine wrote down (GET /api/logs) in a new window. */
  html += "<div class=\"acts\"><button class=\"btn sm\" type=\"button\" data-act=\"restart16\">Restart</button><button class=\"btn ghost sm\" type=\"button\" data-act=\"adv-logs\">Open logs</button></div>";
  html += "</div>";
  html += localTile() + browserTile();

  // Seeing more section
  html += "<div class=\"sec\"><h2>Seeing more</h2>";
  html += `<div class="ctl"><b>Show the thinking</b><input class="sw" type="checkbox" id="ad-think" ${D.knobs?.reasoning?.showReasoning === true ? "checked" : ""} aria-label="Show the thinking" data-sw="set"><small>Adds the model’s reasoning under each reply, folded.</small></div>`;
  const keep = D.log?.keepDays ? `Every step, kept for ${esc(D.log.keepDays)} days on this computer.` : "";
  html += `<div class="ctl"><b>Keep an activity log</b><input class="sw" type="checkbox" id="ad-log" ${D.log?.mode && D.log.mode !== "off" ? "checked" : ""} aria-label="Keep an activity log" data-sw="set"><small>${keep}</small></div>`;
  html += "<div class=\"ctl\"><b>Send crash reports</b><input class=\"sw\" type=\"checkbox\" id=\"ad-crash\" aria-label=\"Send crash reports\" data-sw=\"set\"><small>Only the error, never your conversations.</small></div>";
  html += "</div>";

  // Level-specific content (shown at advanced level and above)
  if (lv >= 1) {
    html += "<div class=\"sec x15-sec\"><h2>Memory</h2>";
    html += "<div class=\"ctl\"><b>Most facts it keeps</b><span class=\"right num15\"><input class=\"inp\" id=\"ad-facts\" value=\"" + esc(E.state?.memoryCapacity?.maxFacts ?? "") + "\" aria-label=\"Most facts it keeps\" data-sw=\"set\" disabled><small>facts</small></span><small>Tidy up suggests what to archive when it gets close.</small></div>";
    html += "<div class=\"ctl\"><b>Match by meaning</b><input class=\"sw\" type=\"checkbox\" id=\"f15-match-by-meaning\" aria-label=\"Match by meaning\" data-sw=\"set\"><small>Finds “invoice” when the fact says “bill”.</small></div>";
    html += "<div class=\"ctl\"><b>Share memory between Trunks</b><input class=\"sw\" type=\"checkbox\" id=\"f15-share-memory-between-trunks\" aria-label=\"Share memory between Trunks\" data-sw=\"set\"><small>Off: each Trunk keeps its own.</small></div>";
    html += "<div class=\"ctl\"><b>Outside memory</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Outside memory\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">None</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Mem0</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Honcho</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Hindsight</button></span></span><small></small></div>";
    html += "<div class=\"ctl\"><b>Keep a history in Git</b><input class=\"sw\" type=\"checkbox\" id=\"f15-keep-a-history-in-git\" aria-label=\"Keep a history in Git\" data-sw=\"set\"><small>Every change to memory as a commit, on this computer.</small></div>";
    html += "<div class=\"ctl\"><b>Archive facts unused for</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Archive facts unused for\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">90 days</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">180 days</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Never</button></span></span><small></small></div>";
    html += "</div>";

    html += "<div class=\"sec x15-sec\"><h2>Automations</h2>";
    html += "<div class=\"ctl\"><b>Report only what changed</b><input class=\"sw\" type=\"checkbox\" id=\"f15-report-only-what-changed\" aria-label=\"Report only what changed\" data-sw=\"set\"><small>Checks compare with last time and stay quiet otherwise.</small></div>";
    html += "<div class=\"ctl\"><b>Checks and retries in procedures</b><input class=\"sw\" type=\"checkbox\" id=\"f15-checks-and-retries-in-procedures\" aria-label=\"Checks and retries in procedures\" data-sw=\"set\"><small>A step can check its own result, retry, and clean up.</small></div>";
    html += "<div class=\"ctl\"><b>Procedures that start themselves</b><input class=\"sw\" type=\"checkbox\" id=\"f15-procedures-that-start-themselves\" aria-label=\"Procedures that start themselves\" data-sw=\"set\"><small>On a clock or after a task. Only procedures you set a time for.</small></div>";
    html += "<div class=\"ctl\"><b>Start when a USB device is plugged in</b><input class=\"sw\" type=\"checkbox\" id=\"f15-start-when-a-usb-device-is-plugged-in\" aria-label=\"Start when a USB device is plugged in\" data-sw=\"set\"><small>Only for triggers you make.</small></div>";
    html += "<div class=\"ctl\"><b>Reach webhooks from outside</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Reach webhooks from outside\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Off</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">cloudflared</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">ngrok</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Tailscale</button></span></span><small></small></div>";
    html += "<div class=\"ctl\"><b>Use what the trigger sent</b><input class=\"sw\" type=\"checkbox\" id=\"f15-use-what-the-trigger-sent\" aria-label=\"Use what the trigger sent\" data-sw=\"set\"><small>{{payload}} and {{field.path}} in the prompt.</small></div>";
    html += "</div>";

    html += "<div class=\"sec x15-sec\"><h2>Tools and skills</h2>";
    html += "<div class=\"ctl\"><b>Check a skill is ready first</b><input class=\"sw\" type=\"checkbox\" id=\"f15-check-a-skill-is-ready-first\" aria-label=\"Check a skill is ready first\" data-sw=\"set\"><small>Programs, keys and systems it needs.</small></div>";
    html += "<div class=\"ctl\"><b>Only signed skill packages</b><input class=\"sw\" type=\"checkbox\" id=\"f15-only-signed-skill-packages\" aria-label=\"Only signed skill packages\" data-sw=\"set\"><small></small></div>";
    html += "<div class=\"ctl\"><b>Check install requests for malware</b><input class=\"sw\" type=\"checkbox\" id=\"f15-check-install-requests-for-malware\" aria-label=\"Check install requests for malware\" data-sw=\"set\"><small>Against the OSV database, before you approve.</small></div>";
    html += "<div class=\"ctl\"><b>Web search</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Web search\"><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">DuckDuckGo</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Brave</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">SearXNG</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Tavily</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Exa</button></span></span><small>DuckDuckGo needs no key, so search works from the first minute.</small></div>";
    html += "<div class=\"ctl\"><b>Search X</b><input class=\"sw\" type=\"checkbox\" id=\"f15-search-x\" aria-label=\"Search X\" data-sw=\"set\"><small>Turns on when an X account is connected.</small></div>";
    html += "<div class=\"ctl\"><b>Video tools</b><input class=\"sw\" type=\"checkbox\" id=\"f15-video-tools\" aria-label=\"Video tools\" data-sw=\"set\"><small>Download, read captions, and make short videos.</small></div>";
    html += "</div>";

    html += "<div class=\"sec x15-sec\"><h2>Trunks, more</h2>";
    html += "<div class=\"ctl\"><b>Projects pick up matching work</b><input class=\"sw\" type=\"checkbox\" id=\"f15-projects-pick-up-matching-work\" aria-label=\"Projects pick up matching work\" data-sw=\"set\"><small>A message in a project goes to that project by itself.</small></div>";
    html += "<div class=\"ctl\"><b>Follow-up tasks</b><input class=\"sw\" type=\"checkbox\" id=\"f15-follow-up-tasks\" aria-label=\"Follow-up tasks\" data-sw=\"set\"><small>A Trunk can leave itself a task for later, shown in the Board.</small></div>";
    html += "<div class=\"ctl\"><b>Standing orders</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">See " + esc(D.orders?.length ?? "") + "</button></span><small>Named programmes a Trunk keeps running; ESCALATE pauses one and asks you.</small></div>";
    html += "<div class=\"ctl\"><b>“From now on” for a specialist</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Add one</button></span><small>A standing instruction kept by one specialist.</small></div>";
    html += "<div class=\"ctl\"><b>Share a Trunk</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Export…</button></span><small>Through Git, as a skill bundle, or exported with memory details removed.</small></div>";
    html += "<div class=\"ctl\"><b>Custom modes</b><span class=\"right\"><code class=\"code15\">.branch/modes.json</code></span><small>Your own modes; one can hand the work back when it’s done.</small></div>";
    html += "<div class=\"ctl\"><b>Agent marketplace</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Browse</button></span><small>Trunks others made, each with a fingerprint you can check.</small></div>";
    html += "</div>";

    html += "<div class=\"sec x15-sec\"><h2>Library, more</h2>";
    html += "<div class=\"ctl\"><b>Search documents by meaning</b><input class=\"sw\" type=\"checkbox\" id=\"f15-search-documents-by-meaning\" aria-label=\"Search documents by meaning\" data-sw=\"set\"><small>Finds the lease clause about repairs when you ask who fixes the boiler.</small></div>";
    html += "<div class=\"ctl\"><b>A local index of mail, calendar and messages</b><input class=\"sw\" type=\"checkbox\" id=\"f15-a-local-index-of-mail-calendar-and-messa\" aria-label=\"A local index of mail, calendar and messages\" data-sw=\"set\"><small>Built and kept on this computer, for faster answers. Off until you choose: it uses a lot of disk and reads everything.</small></div>";
    html += "<div class=\"ctl\"><b>Keep versions of what Trunks make</b><input class=\"sw\" type=\"checkbox\" id=\"f15-keep-versions-of-what-trunks-make\" aria-label=\"Keep versions of what Trunks make\" data-sw=\"set\"><small>Every file in Made for you keeps its versions and a checksum.</small></div>";
    html += "<div class=\"ctl\"><b>Rewrite short notes</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Try it</button></span><small>Clearer, shorter, fixed or more formal.</small></div>";
    html += "</div>";

    html += "<div class=\"sec x15-sec\"><h2>Pinned skills</h2>";
    // The choices are the engine's own skills (E.state.skills), never the prototype's examples.
    const skills = (E.state?.skills ?? []).map((k) => [String(k.name ?? k.id ?? ""), String(k.name ?? k.id ?? "")]).filter(([v]) => v);
    html += seg15("Always read in full", "A pinned skill’s whole instructions go with every message, not only when it seems to fit.", [["none", "None"], ...skills], null);
    html += "</div>";
  }

  return html;
}

/* GET /api/logs answers lines of JSON (what the owner's tasks wrote down, keys and passwords taken out), not one JSON
   document, so it is read as text and shown as it is. */
async function openLogs() {
  try {
    const key = token.get();
    const response = await fetch("/api/logs", { cache: "no-store", headers: key ? { authorization: "Bearer " + key } : {} });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    /* The desktop app refuses new windows (src/desktop/main.ts), so there the same lines open in a dialog instead. */
    if (window.open(url, "_blank")) toast("Logs open in a new window.");
    else openDlg({ title: "Open logs", wide: true, body: `<pre class="code6" data-css="white-space:pre-wrap;margin:0;max-height:60vh;overflow:auto">${esc(text)}</pre>`, foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
  } catch (error) { toast(error.message); }
}

export function init() {
  on("adv-logs", () => openLogs());
  markLive(["adv-logs", "sw:ad-think", "sw:ad-log"]);
  document.addEventListener("change", async (e) => {
    const wire = WIRES[e.target.id];
    if (!wire) return;
    try { await wire(e.target.checked); } catch (error) { toast(error.message); }
    await loadAll();
  });
  loadAll();
}

export async function load() { await loadAll(); }

export const live = { "adv-logs": true };

/* Settings › self: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc } from "../../core/dom.js";
import { markLive, isLive } from "../../core/features.js";
import { on } from "../../core/actions.js";

let history = [];

async function loadHistory() {
  try {
    const res = await api("self-development/requests");
    history = res.requests || [];
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

export function init() {
  loadHistory();
}

const SVG_CHECK = "<svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"></path></svg>";
const SVG_RESTART = "<svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5\"></path></svg>";

function statusSection() {
  const s = E.state || {};
  const version = s.version || "0.0.0";
  const uptime = s.uptime || "unknown";
  const pid = s.pid || "unknown";
  const memory = s.memory ? Math.round(s.memory / 1024 / 1024) + " MB" : "unknown";
  return "<div class=\"status\"><span class=\"sdot \"></span><div><b>Running · " + esc(uptime) + "</b><p>Engine " + esc(version) + " · process " + esc(pid) + " · " + esc(memory) + " · the gateway watches it and starts it again if it stops.</p></div></div>" +
         "<div class=\"acts\" data-css=\"margin-top:12px\"><button class=\"btn\" type=\"button\" data-act=\"doctor\">" + SVG_CHECK + "Check and fix</button><button class=\"btn\" type=\"button\" data-act=\"gw-restart\">" + SVG_RESTART + "Restart the engine</button><button class=\"btn ghost\" type=\"button\" data-act=\"toast\" data-msg=\"Reloaded without dropping work: 2 tasks carried on.\">Reload without dropping work</button></div>";
}

function policySection() {
  const s = E.state || {};
  const askFirst = s.askFirst !== false;
  const loosen = s.loosen !== false;
  const gwTiming = s.gwTiming || "suggest";
  const restart = s.restart !== false;
  const update = s.update !== false;
  const devChecked = E.state?.devMode ? "checked" : "";
  return "<div class=\"sec\"><h2>What Branch may change about itself</h2>" +
    "<div class=\"ctl\"><b>Its own settings</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Its own settings\"><button type=\"button\" aria-pressed=\"" + askFirst + "\" data-act=\"seg\">Ask me first</button><button type=\"button\" aria-pressed=\"" + (!askFirst) + "\" data-act=\"seg\">Never</button></span></span><small>It shows you the change first, tried on a throwaway copy.</small></div>" +
    "<div class=\"ctl\"><b>Loosening what it may do</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Loosening what it may do\"><button type=\"button\" aria-pressed=\"" + loosen + "\" data-act=\"seg\">Ask every time</button></span></span><small>Asked every time; the answer is never kept.</small></div>" +
    "<div class=\"ctl\"><b>The gateway’s timings</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"The gateway’s timings\"><button type=\"button\" aria-pressed=\"" + (gwTiming === "suggest") + "\" data-act=\"seg\">Suggest</button><button type=\"button\" aria-pressed=\"" + (gwTiming === "never") + "\" data-act=\"seg\">Never</button></span></span><small>It can suggest; you decide.</small></div>" +
    "<div class=\"ctl\"><b>Restarting its own engine</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Restarting its own engine\"><button type=\"button\" aria-pressed=\"" + restart + "\" data-act=\"seg\">Allowed</button><button type=\"button\" aria-pressed=\"" + (!restart) + "\" data-act=\"seg\">Ask me first</button></span></span><small>When it’s stuck. Safe steps carry on after.</small></div>" +
    "<div class=\"ctl\"><b>Updating itself</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Updating itself\"><button type=\"button\" aria-pressed=\"" + update + "\" data-act=\"seg\">Allowed</button><button type=\"button\" aria-pressed=\"" + (!update) + "\" data-act=\"seg\">Ask me first</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Never</button></span></span><small>Only when nothing is working, with a safety copy.</small></div>" +
    "<div class=\"ctl\"><b>Its own program and your saved work</b><span class=\"right\"><span class=\"pill idle\">Never, by itself</span></span><small>This one can’t be switched on.</small></div>" +
    "<div class=\"ctl\"><b>Work on its own code in a separate copy</b><input class=\"sw\" type=\"checkbox\" id=\"self-dev\" aria-label=\"Work on its own code in a separate copy\" " + devChecked + " data-sw=\"set\"><small>A private copy of Branch’s source. The installed app is never touched. Off until you switch it on.</small></div></div>";
}

function neverDiesSection() {
  return "<div class=\"sec\"><h2>Never dies</h2><dl class=\"kv\"><dt>If the engine stops</dt><dd>The gateway starts it again, holding messages for up to 20 seconds</dd><dt>If it keeps crashing</dt><dd>After 4 quick crashes it rolls back to the last good settings and tells you</dd><dt>Interrupted work</dt><dd>Safe steps carry on by themselves; anything that sends or changes something asks first</dd><dt>Last good settings</dt><dd>Today 09:00 · kept automatically</dd></dl></div>";
}

function timelineSection() {
  if (!history.length) {
    return "<div class=\"sec\"><h2>Every change</h2><p>No changes yet.</p></div>";
  }
  const SVG_PERSON = "<svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"9\" cy=\"8.5\" r=\"3\"></circle><path d=\"M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.5a3 3 0 0 1 0 6M17 13.5a5.5 5.5 0 0 1 3.5 5.5\"></path></svg>";
  const items = history.slice(0, 3).map(item => {
    const icon = item.ok ? SVG_CHECK : SVG_PERSON;
    const time = esc(item.time || "");
    const desc = esc(item.description || "A change");
    const okClass = item.ok ? "ok" : "";
    const rollback = item.ok ? "" : "<button class=\"btn ghost sm\" type=\"button\" data-act=\"toast\" data-msg=\"Rolled back to before that change.\">Roll back</button>";
    return "<li class=\"" + okClass + "\">" + icon + "<span>" + desc + "<small>" + time + "</small></span>" + rollback + "</li>";
  }).join("");
  return "<div class=\"sec\"><h2>Every change</h2><ol class=\"tl\">" + items + "</ol></div>";
}

function draw() {
  const lvl = ["regular", "advanced", "technical"][level()];
  let html = `<h1>Branch itself</h1><p class="lede">What Branch may change about itself, how it stays running, and every change it made, each one reversible.</p>`;
  html += statusSection();
  html += policySection();
  html += neverDiesSection();
  html += timelineSection();
  return html;
}

export { draw };

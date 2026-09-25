/* Settings › self: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";

let history = [];
let neverBreakData = null;

async function loadData() {
  try {
    const [histRes, nbRes] = await Promise.all([
      api("self-development/requests"),
      api("never-break")
    ]);
    history = histRes.requests || [];
    neverBreakData = nbRes || {};
    render();
  } catch (e) {
    console.error("Failed to load self settings:", e);
  }
}

export function init() {
  loadData();

  on("doctor", (el) => {
    api("deployment/doctor?fix=1")
      .then(() => {
        loadData();
      })
      .catch((e) => console.error("Doctor check failed:", e));
  });

  on("gw-restart", (el) => {
    api("dashboard/restart", {})
      .then(() => {
        loadData();
      })
      .catch((e) => console.error("Gateway restart failed:", e));
  });

  markLive(["doctor", "gw-restart"]);
}

export async function load() {
  await loadData();
}

export const live = {
  "doctor": true,
  "gw-restart": true,
};

const SVG_CHECK = "<svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"></path></svg>";
const SVG_RESTART = "<svg class=\"i s\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5\"></path></svg>";

function statusSection() {
  const s = E.state || {};
  const version = s.version;
  let html = "<div class=\"status\"><span class=\"sdot \"></span><div>";
  html += "<b>Running</b>";
  if (version) html += "<p>Engine " + esc(version) + " · the gateway watches it and starts it again if it stops.</p>";
  html += "</div></div>";
  html += "<div class=\"acts\" data-css=\"margin-top:12px\"><button class=\"btn\" type=\"button\" data-act=\"doctor\">" + SVG_CHECK + "Check and fix</button><button class=\"btn\" type=\"button\" data-act=\"gw-restart\">" + SVG_RESTART + "Restart the engine</button></div>";
  return html;
}

function policySection() {
  const askFirstRules = E.state?.askFirst;
  const askFirst = askFirstRules && Object.keys(askFirstRules).length > 0;
  return "<div class=\"sec\"><h2>What Branch may change about itself</h2>" +
    "<div class=\"ctl\"><b>Its own settings</b><span class=\"right\"><span class=\"seg\" role=\"group\" aria-label=\"Its own settings\"><button type=\"button\" aria-pressed=\"true\" data-act=\"seg\">Ask me first</button><button type=\"button\" aria-pressed=\"false\" data-act=\"seg\">Never</button></span></span><small>It shows you the change first, tried on a throwaway copy.</small></div>" +
    "<div class=\"ctl\"><b>Its own program and your saved work</b><span class=\"right\"><span class=\"pill idle\">Never, by itself</span></span><small>This one can’t be switched on.</small></div>" +
    "<div class=\"ctl\"><b>Work on its own code in a separate copy</b><input class=\"sw\" type=\"checkbox\" id=\"self-dev\" aria-label=\"Work on its own code in a separate copy\" data-sw=\"set\"><small>A private copy of Branch’s source. The installed app is never touched. Off until you switch it on.</small></div></div>";
}

function neverDiesSection() {
  return "<div class=\"sec\"><h2>Never dies</h2><dl class=\"kv\"><dt>If the engine stops</dt><dd>The gateway starts it again</dd><dt>Interrupted work</dt><dd>Safe steps carry on by themselves; anything that sends or changes something asks first</dd></dl></div>";
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
    return "<li class=\"" + okClass + "\">" + icon + "<span>" + desc + "<small>" + time + "</small></span></li>";
  }).join("");
  return "<div class=\"sec\"><h2>Every change</h2><ol class=\"tl\">" + items + "</ol></div>";
}

function draw() {
  let html = `<h1>Branch itself</h1><p class="lede">What Branch may change about itself, how it stays running, and every change it made, each one reversible.</p>`;
  html += statusSection();
  html += policySection();
  html += neverDiesSection();
  html += timelineSection();
  return html;
}

export { draw };

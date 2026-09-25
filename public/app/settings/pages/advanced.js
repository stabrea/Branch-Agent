/* Settings › advanced: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";

export function init() {
  // No live controls yet - waiting for engine routes for advanced settings
}

function draw() {
  const s = E.state || {};
  const lvl = ["regular", "advanced", "technical"][level()];
  let html = "";

  if (lvl === "regular") {
    html = "<h1>General</h1><p class=\"lede\">How Branch starts and behaves on this computer.</p>";
    html += "<div class=\"status\"><span class=\"sdot \"></span><div><b>Branch starts with Windows</b><p>It waits in the tray and keeps scheduled work running when the window is closed.</p></div></div>";
    html += "<div class=\"sec\"><h2>Starting up</h2>";
    html += "<div class=\"ctl\"><b>Start with Windows</b><input class=\"sw\" type=\"checkbox\" id=\"g-start\" checked aria-label=\"Start with Windows\" data-sw=\"set\"><small>Opens quietly in the tray.</small></div>";
    html += "<div class=\"ctl\"><b>Keep working when the window closes</b><input class=\"sw\" type=\"checkbox\" id=\"g-tray\" checked aria-label=\"Keep working when the window closes\" data-sw=\"set\"><small>Trunks finish what they started.</small></div>";
    html += "</div>";
    html += "<div class=\"sec\"><h2>Projects</h2><div class=\"rows\"><p>No projects yet.</p></div></div>";
    html += "<div class=\"sec\"><h2>Keyboard</h2><div class=\"ctl\"><b>Keyboard shortcuts</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"shortcuts\">Show all</button></span><small>Ctrl K to find anything, Ctrl N for a new conversation.</small></div></div>";
  } else {
    html = "<h1>Advanced</h1><p class=\"lede\">What's running under the hood, for when something needs a look.</p>";
    html += "<div class=\"tile\" data-css=\"margin-top:12px\"><div class=\"th\"><b>Branch service</b><span class=\"pill done ml\"><i></i>Running</span></div>";
    html += "<dl class=\"kv\" data-css=\"background:none;padding:0\">";
    html += "<dt>Version</dt><dd>" + esc(s.version || "0.19.4") + "</dd>";
    html += "<dt>Address</dt><dd>" + esc(s.address || "127.0.0.1:3210") + "</dd>";
    html += "<dt>Process</dt><dd>" + esc(s.pid || "unknown") + "</dd>";
    html += "</dl>";
    html += "<div class=\"acts\"><button class=\"btn sm\" type=\"button\" data-act=\"toast\" data-msg=\"Branch service restarted.\">Restart</button><button class=\"btn ghost sm\" type=\"button\" data-act=\"toast\" data-msg=\"Logs open in a new window.\">Open logs</button></div>";
    html += "</div>";
    html += "<div class=\"sec\"><h2>Seeing more</h2>";
    html += "<div class=\"ctl\"><b>Show the thinking</b><input class=\"sw\" type=\"checkbox\" id=\"ad-think\" " + (s.showThinking ? "checked" : "") + " aria-label=\"Show the thinking\" data-sw=\"ad-think\"><small>Adds the model's reasoning under each reply, folded.</small></div>";
    html += "<div class=\"ctl\"><b>Keep an activity log</b><input class=\"sw\" type=\"checkbox\" id=\"ad-log\" " + (s.keepActivityLog !== false ? "checked" : "") + " aria-label=\"Keep an activity log\" data-sw=\"ad-log\"><small>Every step, kept for 30 days on this computer.</small></div>";
    html += "<div class=\"ctl\"><b>Send crash reports</b><input class=\"sw\" type=\"checkbox\" id=\"ad-crash\" " + (s.sendCrashReports ? "checked" : "") + " aria-label=\"Send crash reports\" data-sw=\"ad-crash\"><small>Only the error, never your conversations.</small></div>";
    html += "</div>";
  }

  return html;
}

export { draw };

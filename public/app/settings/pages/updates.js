/* Settings › updates: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";

export function init() {
  // No live controls yet - waiting for engine routes for updates
}

function draw() {
  const s = E.state || {};
  const version = s.version || "0.0.0";
  const platform = s.platform || "Windows";

  let html = "<h1>Updates &amp; about</h1>";
  html += "<p class=\"lede\">Branch Agent " + esc(version) + " on " + esc(platform) + ".</p>";
  html += "<div class=\"status\"><span class=\"sdot \"></span><div><b>" + esc(version) + " is up to date</b><p>No newer version available.</p></div></div>";

  html += "<div class=\"sec\"><h2>Updating</h2>";
  html += "<div class=\"ctl\"><b>Keep Branch up to date by itself</b><input class=\"sw\" type=\"checkbox\" id=\"u-auto\" aria-label=\"Keep Branch up to date by itself\" data-sw=\"set\"><small>Checks every day.</small></div>";
  html += "</div>";

  html += "<div class=\"sec danger8\"><h2>Remove Branch</h2><div class=\"rows\">";
  html += "<div class=\"prow\"><span class=\"grow\"><b data-css=\"font-weight:500\">The app</b></span><span class=\"meta\">Removed · 412 MB</span></div>";
  html += "<div class=\"prow\"><span class=\"grow\"><b data-css=\"font-weight:500\">Programs it downloaded to run models</b></span><span class=\"meta\">Removed · 1.1 GB</span></div>";
  html += "<div class=\"prow\"><span class=\"grow\"><b data-css=\"font-weight:500\">Models on this computer</b></span><span class=\"meta\">Removed · 19.8 GB</span></div>";
  html += "<div class=\"ctl\"><b>Keep my conversations and settings</b><input class=\"sw\" type=\"checkbox\" id=\"dz-keep\" checked aria-label=\"Keep my conversations and settings\"><small>Kept · 86 MB. Branch finds them again if you install it later.</small></div>";
  html += "</div>";
  html += "<div class=\"ctl\"><b>Type Branch Agent to confirm</b><span class=\"right\"><input class=\"inp\" id=\"dz-confirm\" autocomplete=\"off\" data-css=\"width:180px\" aria-label=\"Type Branch Agent to confirm\"></span><small>It is there so a misclick can't remove Branch.</small></div>";
  html += "<div class=\"acts\"><button class=\"btn dz\" type=\"button\" id=\"dz-go\" data-act=\"uninstall\" disabled>Remove Branch and everything it installed</button></div>";
  html += "</div>";

  return html;
}

export { draw };

/* Settings › updates: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc, render } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { toast } from "../../core/ui.js";

let comfortData = null;

async function loadComfort() {
  try {
    const res = await api("comfort");
    comfortData = res.values || {};
    render();
  } catch (e) {
    toast(e.message);
  }
}

/* The switch is drawn after init, so its change is caught on the document (POST /api/comfort merges the one value
   into the notify card). */
async function saveAutoUpdate(on) {
  try {
    comfortData = (await api("comfort", { card: "notify", values: { autoUpdate: on ? "check" : "off" } })).values ?? comfortData;
  } catch (e) {
    toast(e.message);
  }
  render();
}

export function init() {
  loadComfort();
  document.addEventListener("change", (e) => { if (e.target.id === "u-auto") saveAutoUpdate(e.target.checked); });
  markLive(["sw:u-auto"]);
}

export async function load() {
  await loadComfort();
}

function draw() {
  const s = E.state || {};
  const version = s.version;
  const autoUpdate = comfortData?.notify?.autoUpdate !== "off";

  let html = "<h1>Updates &amp; about</h1>";
  if (version) html += "<p class=\"lede\">Branch Agent " + esc(version) + ".</p>";

  html += "<div class=\"sec\"><h2>Updating</h2>";
  html += "<div class=\"ctl\"><b>Keep Branch up to date by itself</b><input class=\"sw\" type=\"checkbox\" id=\"u-auto\" " + (autoUpdate ? "checked" : "") + " aria-label=\"Keep Branch up to date by itself\" data-sw=\"set\"><small>Checks every day.</small></div>";
  html += "</div>";

  html += "<div class=\"sec danger8\"><h2>Remove Branch</h2><div class=\"rows\">";
  html += "<div class=\"ctl\"><b>Keep my conversations and settings</b><input class=\"sw\" type=\"checkbox\" id=\"dz-keep\" aria-label=\"Keep my conversations and settings\"><small>Branch finds them again if you install it later.</small></div>";
  html += "</div>";
  html += "<div class=\"ctl\"><b>Type Branch Agent to confirm</b><span class=\"right\"><input class=\"inp\" id=\"dz-confirm\" autocomplete=\"off\" data-css=\"width:180px\" aria-label=\"Type Branch Agent to confirm\"></span><small>It is there so a misclick can't remove Branch.</small></div>";
  html += "<div class=\"acts\"><button class=\"btn dz\" type=\"button\" id=\"dz-go\" data-act=\"uninstall\" disabled>Remove Branch and everything it installed</button></div>";
  html += "</div>";

  return html;
}

export { draw };

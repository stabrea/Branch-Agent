/* Settings › developer: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).
   Bind real engine data and wire controls in place; never add text that is not here. */
import { E, level } from "../../core/state.js";
import { api } from "../../core/api.js";
import { esc } from "../../core/dom.js";
import { markLive } from "../../core/features.js";
import { on } from "../../core/actions.js";

let devSettings = { address: "127.0.0.1:3210", sessionKey: null };

async function loadDevSettings() {
  try {
    const data = await api("dev-settings");
    devSettings = data;
  } catch (e) {
    console.error("Failed to load dev settings:", e);
  }
}

export function init() {
  markLive(["dv-ls", "dv-dbg"]);
  loadDevSettings();
  for (const id of ["dv-ls", "dv-dbg"]) {
    on("sw:" + id, (el) => {
      api("dev-setting", { id, enabled: el.checked }).catch(e => {
        el.checked = !el.checked;
        console.error("Failed to update setting:", e);
      });
    });
  }
}

function draw() {
  const lvl = ["regular", "advanced", "technical"][level()];
  let html = "";

  if (lvl === "regular" || lvl === "advanced") {
    html = "<h1>General</h1><p class=\"lede\">How Branch starts and behaves on this computer.</p>";
    html += "<div class=\"status\"><span class=\"sdot \"></span><div><b>Branch starts with Windows</b><p>It waits in the tray and keeps scheduled work running when the window is closed.</p></div></div>";
    html += "<div class=\"sec\"><h2>Starting up</h2>";
    html += "<div class=\"ctl\"><b>Start with Windows</b><input class=\"sw\" type=\"checkbox\" id=\"g-start\" checked aria-label=\"Start with Windows\" data-sw=\"set\"><small>Opens quietly in the tray.</small></div>";
    html += "<div class=\"ctl\"><b>Keep working when the window closes</b><input class=\"sw\" type=\"checkbox\" id=\"g-tray\" checked aria-label=\"Keep working when the window closes\" data-sw=\"set\"><small>Trunks finish what they started.</small></div>";
    html += "</div>";
  } else {
    html = "<h1>Developer</h1><p class=\"lede\">For people building on Branch.</p>";
    html += "<div class=\"sec\"><h2>Local address</h2>";
    html += "<div class=\"ctl\"><b>" + esc(devSettings.address || "127.0.0.1:3210") + "</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"toast\" data-msg=\"Copied.\">Copy</button></span><small>Only this computer can reach it. Requests need your session key.</small></div>";
    html += "<div class=\"ctl\"><b>Session key</b><span class=\"right\"><span data-css=\"font:12px var(--mono);color:var(--ink-3)\">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span><button class=\"btn sm\" type=\"button\" data-act=\"toast\" data-msg=\"A new key was made. Apps using the old one must connect again.\">Make a new one</button></span><small>Never shown in full here.</small></div>";
    html += "</div>";
    html += "<div class=\"sec\"><h2>Help with code</h2>";
    html += "<div class=\"ctl\"><b>Use language servers</b><input class=\"sw\" type=\"checkbox\" id=\"dv-ls\" " + (E.state?.useLanguageServers ? "checked" : "") + " aria-label=\"Use language servers\" data-sw=\"dv-ls\"><small>Programs you already installed, one per line.</small></div>";
    html += "<div class=\"ctl\"><b>Use a debugger</b><input class=\"sw\" type=\"checkbox\" id=\"dv-dbg\" " + (E.state?.useDebugger ? "checked" : "") + " aria-label=\"Use a debugger\" data-sw=\"dv-dbg\"><small>Nothing downloads, and nothing runs until this is on.</small></div>";
    html += "</div>";
  }

  return html;
}

export { draw };

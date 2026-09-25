/* Settings › developer: bind real engine data and wire controls. */
import { esc } from "../../core/dom.js";
import { level, E } from "../../core/state.js";
import { api } from "../../core/api.js";
import { on } from "../../core/actions.js";
import { markLive } from "../../core/features.js";

export function draw() {
  let html = "<h1>Developer</h1><p class=\"lede\">For people building on Branch.</p>";
  html += "<div class=\"sec\"><h2>Local address</h2>";
  html += "<div class=\"ctl\"><b>Local server</b><span class=\"right\"><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Copy</button></span><small>Only this computer can reach it. Requests need your session key.</small></div>";
  html += "<div class=\"ctl\"><b>Session key</b><span class=\"right\"><span data-css=\"font:12px var(--mono);color:var(--ink-3)\">&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;</span><button class=\"btn sm\" type=\"button\" data-act=\"soon\">Make a new one</button></span><small>Never shown in full here.</small></div>";
  html += "</div>";
  html += "<div class=\"sec\"><h2>Help with code</h2>";
  html += "<div class=\"ctl\"><b>Use language servers</b><input class=\"sw\" type=\"checkbox\" id=\"dv-ls\" aria-label=\"Use language servers\" data-sw=\"set\"><small>Programs you already installed, one per line.</small></div>";
  html += "<div class=\"ctl\"><b>Use a debugger</b><input class=\"sw\" type=\"checkbox\" id=\"dv-dbg\" aria-label=\"Use a debugger\" data-sw=\"set\"><small>Nothing downloads, and nothing runs until this is on.</small></div>";
  html += "</div>";

  return html;
}

export function init() {
  // Wire controls to real routes when needed
}

export const live = {
  // No controls wired yet
};

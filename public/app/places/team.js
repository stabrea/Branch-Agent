/* Team: people, shared work, usage, rules (greyed until KeepOak connects). */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { tabBar } from "./parts.js";

const tabs = [["live", "Live now"], ["people", "People"], ["groups", "Groups"],
  ["shared", "Shared"], ["agents", "Teams of specialists"], ["activity", "Activity"],
  ["usage", "Usage"], ["rules", "Rules"], ["signin", "Signing in"]];

function liveTab() {
  const running = E.state.runs?.filter(r => r.status === "running" || r.status === "needs_input") || [];
  let html = `<div class="runs6">`;
  running.slice(0, 4).forEach((r, i) => {
    html += `<div class="run6"><div class="run-h">${av({}, 30)}<span class="grow"><b>${esc(r.prompt?.split("\n")[0]?.slice(0, 40) || "Task")}</b><small>${esc(r.sessionId || "")}</small></span><span class="pill ok"><i></i>Working</span></div><div class="acts"><button class="btn sm" type="button" data-act="run-watch" data-i="${i}"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>Watch</button><button class="btn ghost sm" type="button" data-act="toast" data-msg="Asked to let you join. They get a notification.">Ask to join</button></div></div>`;
  });
  html += `</div>`;
  return html;
}

function peopleTab() {
  let html = `<div class="runs6"><div class="run6"><div class="run-h">${av({kind: "main"}, 30)}<span class="grow"><b>You</b><small>This computer · Branch ${esc(E.state?.version ?? "")}</small></span></div></div></div>`;
  return html;
}

function otherTab(label) {
  return `<div class="runs6"></div>`;
}

export function draw() {
  const tab = S.tabs.team || "live";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <div class="team-top"><h1>People</h1></div>
    <p class="lede">Everyone who uses Branch, and what their Trunks are doing right now.</p>
    <div class="ko-banner"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>Your keepoak.com team is optional</b><small>People on this computer and on their own devices work without it.</small></span><button class="btn pri sm" type="button" data-act="ko-start">Connect</button></div>
    ${tabBar(tabs, "team", tab)}`;

  if (tab === "live") {
    html += liveTab();
  } else if (tab === "people") {
    html += peopleTab();
  } else {
    html += otherTab(tab);
  }

  html += `</div></div></main>`;
  return html;
}

export function init() {
  markLive(["ptab"]);
}

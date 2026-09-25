/* Team: people, shared work, usage, rules (greyed until KeepOak connects). */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av, mi, openPop, toast } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { on } from "../core/actions.js";
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
  const profiles = E.profiles?.profiles ?? [];
  const owner = E.profiles?.roleLabels?.owner?.label || "You";
  let html = `<div class="runs6">`;

  // Show owner/current user
  html += `<div class="run6"><div class="run-h">${av({kind: "main"}, 30)}<span class="grow"><b>${owner}</b><small>This computer · Branch ${E.state?.version || "0.19.4"}</small></span></div></div>`;

  // Show other profiles
  profiles.forEach((p) => {
    html += `<div class="run6"><div class="run-h">${av({name: p.name}, 30)}<span class="grow"><b>${esc(p.name || "")}</b><small>${esc(p.device || "")} · ${p.role || "User"}</small></span></div></div>`;
  });

  html += `<div class="run6"><div class="acts"><button class="btn pri" type="button" data-act="p-invite"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Invite someone</button></div></div>`;
  html += `</div>`;
  return html;
}

function groupsTab() {
  return `<div class="sec"><p class="hint">Groups aren't set up yet.</p><div class="acts"><button class="btn pri sm" type="button" data-act="toast" data-msg="Coming soon.">New group</button></div></div>`;
}

function sharedTab() {
  return `<div class="sec"><p class="hint">Nothing shared yet.</p><div class="acts"><button class="btn pri sm" type="button" data-act="share10"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 12 0"/><path d="M4 18a12 12 0 0 1 16 0"/><circle cx="12" cy="6" r="3"/></svg>Share</button></div></div>`;
}

function otherTab(label) {
  return `<div class="sec"><p class="hint">Coming soon.</p></div>`;
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
  } else if (tab === "groups") {
    html += groupsTab();
  } else if (tab === "shared") {
    html += sharedTab();
  } else {
    html += otherTab(tab);
  }

  html += `</div></div></main>`;
  return html;
}

export function init() {
  on("p-invite", (el) => {
    openPop(el, `<div class="ph">Invite someone</div><p>They'll see your conversations and Trunks.</p><div class="fld"><label><span>Their name</span><input type="text" placeholder="First name" autocomplete="off"></label></div><div class="acts"><button class="btn pri" type="button" data-act="p-inv-go">Send invite</button><button class="btn ghost" type="button" data-act="closepop">Cancel</button></div>`, { right: true });
  });
  on("share10", (el) => {
    openPop(el, `<div class="ph">Share</div><p>Choose what to share with who.</p><p class="hint">Coming soon.</p>`, { right: true });
  });
  markLive(["ptab", "p-invite", "share10"]);
}

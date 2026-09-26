/* Team: people, shared work, usage, rules (greyed until KeepOak connects).
   Live now: each task working on this computer (state.runs), under the person using Branch here (GET /api/profiles) and
   the Trunk whose conversation it is (its chatSessionId), else Branch's own assistant (state.identity). Watching, asking
   to join and inviting stay greyed. */

import { esc, renderNow } from "../core/dom.js";
import { S, E, personHere } from "../core/state.js";
import { ic, av, closePop } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { on } from "../core/actions.js";
import { tabBar } from "./parts.js";

const tabs = [["live", "Live now"], ["people", "People"], ["groups", "Groups"],
  ["shared", "Shared"], ["agents", "Teams of specialists"], ["activity", "Activity"],
  ["usage", "Usage"], ["rules", "Rules"], ["signin", "Signing in"]];

const EYE = `<svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>`;
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 80);

function person() {
  const name = personHere();
  const version = E.state?.version ? ` · Branch ${esc(E.state.version)}` : "";
  return `<span class="tav6" data-css="--c:var(--accent);width:30px;height:30px;font-size:11px">${esc(initials(name))}<i class="st st-online"></i></span><span class="grow"><b>${esc(name)}</b><small>This computer${version}</small></span>`;
}

function liveRow(r, i) {
  const waiting = r.status === "needs_input";
  const trunk = (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.chatSessionId === r.sessionId);
  const session = E.sessions.find((s) => (s.sessionId ?? s.id) === r.sessionId);
  const who = trunk ? av(trunk, 30) : av({ kind: "main" }, 30);
  const name = trunk?.name ?? E.state?.identity?.name ?? "";
  const pill = waiting ? `<span class="pill work"><i></i>Needs you</span>` : `<span class="pill ok"><i></i>Working</span>`;
  return `<div class="run6 ${waiting ? "wait6" : ""}"><div class="run-h">${person()}${pill}</div>
    <div class="run-b">${who}<span class="grow"><b>${esc(name)}</b><span>${esc(firstLine(session?.opening) || firstLine(r.prompt))}</span>${r.model ? `<small>${esc(r.model)}</small>` : ""}</span></div>
    <div class="acts"><button class="btn sm" type="button" data-act="run-watch" data-i="${i}">${EYE}Watch</button><button class="btn ghost sm" type="button" data-act="toast">Ask to join</button></div></div>`;
}

const liveRuns = () => E.state.runs?.filter((r) => r.status === "running" || r.status === "needs_input") || [];
function liveTab() {
  return `<div class="runs6">${liveRuns().map(liveRow).join("")}</div>`;
}
/* Live now counts the tasks working here; People counts the rows its tab draws (the person using Branch here). */
const counts = () => ({ live: liveRuns().length, people: personHere() ? 1 : 0 });

function peopleTab() {
  return `<div class="runs6"><div class="run6"><div class="run-h">${person()}</div></div></div>
    <div class="acts" data-css="margin-top:12px"><button class="btn pri" type="button" data-act="team-invite">${ic("plus", "s")}Invite someone</button></div>`;
}

export function draw() {
  const tab = S.tabs.team || "live";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <div class="team-top"><h1>People</h1></div>
    <p class="lede">Everyone who uses Branch, and what their Trunks are doing right now.</p>
    <div class="ko-banner"><span class="ko-mark" aria-hidden="true"></span><span class="grow"><b>Your keepoak.com team is optional</b><small>People on this computer and on their own devices work without it.</small></span><button class="btn pri sm" type="button" data-act="ko-start">Connect</button></div>
    ${tabBar(tabs.map(([id, label]) => [id, label, counts()[id] ?? 0]), "team", tab)}`;

  if (tab === "live") html += liveTab();
  else if (tab === "people") html += peopleTab();
  else html += `<div class="runs6"></div>`;

  html += `</div></div></main>`;
  return html;
}

export function init() {
  markLive(["ptab", "p-open-team"]);
  /* From Settings › People: opens one of the Team tabs. */
  on("p-open-team", (el) => { S.view = "team"; S.tabs.team = el.dataset.v; closePop(); renderNow(); });
}

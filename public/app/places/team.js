/* Team: people, shared work, usage, rules (greyed until KeepOak connects). */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { tabBar } from "./parts.js";

const tabs = [["live", "Live now"], ["people", "People"], ["shared", "Shared"],
  ["agents", "Teams of Trunks"], ["activity", "Activity"], ["usage", "Usage"], ["rules", "Rules"]];

export function draw() {
  const tab = S.tabs.team || "live";
  if (!E.state) return `<div class="scroll"><div class="place"></div></div>`;

  let html = `<div class="scroll"><div class="place" data-note="team6">
    <div class="team-top"><h1>Team</h1><span class="ws-pill">${ic('users', 's')}Sample team</span></div>
    <p class="lede">Who's here, what their Trunks are doing right now, and what you share.</p>
    <div class="ko-banner"><span class="ko-mark"></span><span class="grow">
      <b>Team comes from your keepoak.com workspace</b>
      <small>This is sample data until you connect.</small></span>
      <button class="btn pri sm" data-act="toast" data-msg="Connect to keepoak.com">Connect</button></div>
    ${tabBar(tabs, "team", tab)}<div class="rows">`;

  if (tab === "live") {
    const runs = E.state.runs?.filter(r => r.status === 'running' || r.status === 'waiting') || [];
    if (runs.length) {
      html += runs.slice(0, 3).map((r, i) => `<div class="run6"><div class="run-h">${av({}, 30)}<span class="grow">
        <b>${esc(r.title || 'Task')}</b><small>${esc(r.model || '')}</small></span>
        <span class="pill work"><i></i>Working</span></div>
        <div class="acts"><button class="btn sm" data-act="run-watch" data-i="${i}">Watch</button></div></div>`).join('');
    } else {
      html += `<p>Nothing running in the team right now.</p>`;
    }
  } else if (tab === "people") {
    html += `<div class="prow">${av({}, 34)}<span class="grow"><b>You · Owner</b><small>This computer</small></span></div>
      <div class="acts" data-css="margin-top:12px"><button class="btn pri" data-act="team-invite">Invite someone</button></div>`;
  } else if (tab === "shared") {
    html += `<p>No shared Trunks or automations yet.</p>`;
  } else if (tab === "agents") {
    html += `<p>No teams of Trunks yet.</p>`;
  } else if (tab === "activity") {
    html += `<p>No team activity yet.</p>`;
  } else if (tab === "usage") {
    html += `<p>No usage data.</p>`;
  } else if (tab === "rules") {
    html += `<p>Set team rules once you connect to keepoak.com.</p>`;
  }

  html += `</div></div></div>`;
  return html;
}

export function init() {
  markLive(["ptab",]);
}

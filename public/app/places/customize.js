/* Customize: Trunks, Tools, Specialists, Channels, Everywhere. */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";
import { tabBar } from "./parts.js";

const tabs = [["trunks", "Trunks"], ["tools", "Tools"], ["specialists", "Specialists"],
  ["channels", "Channels"], ["everywhere", "Everywhere"]];
const tab = S.tabs.customize || "trunks";

export function draw() {
  if (!E.state) return `<div class="scroll"><div class="place"></div></div>`;

  let html = `<div class="scroll"><div class="place">
    <h1>Customize</h1><p class="lede">Who your Trunks are, what they can do, and where you can reach them.</p>
    ${tabBar(tabs, "customize", tab)}<div class="rows">`;

  if (tab === "trunks") {
    html += `<div class="acts"><button class="btn pri" data-act="chat" data-id="new">${ic('plus', 's')}A new Trunk</button>
      <button class="btn" data-act="toast" data-msg="Pick two or more Trunks and give the room a name.">A new room</button></div>`;
    const trunks = E.trunks || [];
    if (trunks.length) {
      html += trunks.map(t => `<div class="prow">${av(t, 36)}<span class="grow">
        <b>${esc(t.name || '')}${t.paused ? ' · paused' : ''}</b><small>${esc(t.role || '')}</small></span>
        <button class="btn sm" data-act="edit" data-id="${esc(t.id || '')}">Edit</button>
        <button class="btn ghost sm" data-act="pausetrunk" data-id="${esc(t.id || '')}">${t.paused ? 'Resume' : 'Pause'}</button></div>`).join('');
    }
  } else if (tab === "tools") {
    html += `<p class="hint">Apps and tool servers your Trunks can use.</p><p>No tools yet.</p>`;
  } else if (tab === "specialists") {
    html += `<p class="hint">Helpers a Trunk calls in for one job, then lets go.</p><p>No specialists yet.</p>`;
  } else if (tab === "channels") {
    html += `<p class="hint">Talk to Branch from other apps.</p><div class="grid2">
      <div class="tile"><div class="th">${ic('chat', 's')}<b>Telegram</b></div><p>Messages from Telegram reach Branch.</p>
      <div class="acts"><span class="pill ok"><i></i>Connected</span></div></div>
      <div class="tile"><div class="th">${ic('chat', 's')}<b>Discord</b></div><p>Not connected.</p>
      <div class="acts"><button class="btn sm" data-act="toast" data-msg="Setting up Discord.">Set up</button></div></div>
      </div>`;
  } else if (tab === "everywhere") {
    html += `<p>Windows, Mac, Terminal, iPhone, Android, keepoak.com — Branch stays in sync.</p>`;
  }

  html += `</div></div></div>`;
  return html;
}

export function init() {
  markLive(["ptab", "chat", "toast", "edit", "pausetrunk"]);
}

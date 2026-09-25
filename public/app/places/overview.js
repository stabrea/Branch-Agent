/* Overview: status dashboard and controls. */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";

export function draw() {
  if (!E.state) return `<div class="scroll"><div class="place"></div></div>`;
  const waiting = E.state.trunkWaiting?.length || 0;
  const recent = E.state.runs?.slice(0, 4) || [];

  let html = `<div class="scroll"><div class="place" data-css="max-width:1000px">
    <h1>Overview</h1><p class="lede">What's happening across your Trunks, at a glance.</p>
    <div class="ov"><div class="tile"><h2>Now</h2>`;

  if (!recent.length) html += `<p>Nothing is running right now.</p>`;
  else recent.forEach(c => html += `<div class="row" data-act="chat" data-id="${esc(c.id || '')}">
    <span class="avw">${av({}, 34)}</span><div class="inf"><b>${esc(c.title || 'Task')}</b></div></div>`);

  html += `<div class="acts">${waiting ? `<button class="btn pri sm" data-act="view" data-v="inbox">Answer ${waiting} waiting</button>` :
    `<span class="pill done"><i></i>Nothing waiting</span>`}</div></div>`;

  html += `<div class="tile"><h2>Health</h2>`;
  [['This computer', 'Online'], ['Model', 'Loaded'], ['Telegram', 'Connected']].forEach(([l, s]) =>
    html += `<div data-css="display:flex;gap:8px;font-size:13px;margin:8px 0"><span class="dot"></span><span>${esc(l)}</span>
    <span data-css="color:var(--ink-3);margin-left:auto">${esc(s)}</span></div>`);
  html += `</div><div class="tile"><h2>Controls</h2><p>Mode: <b>Ask first</b>
    <button class="link" data-act="setgo" data-v="permissions">change</button></p>
    <div class="acts"><button class="btn sm" data-act="lock">Lockdown</button>
    <button class="btn sm" data-act="pauseall">Pause all Trunks</button></div></div></div></div></div>`;

  return html;
}

export function init() {
  markLive(["view", "ptab", "setgo", "lock", "pauseall", "chat"]);
}

/* Inbox: approvals, finished tasks, history - matches reference place-inbox-*.html */

import { esc } from "../core/dom.js";
import { S, E } from "../core/state.js";
import { ic, av } from "../core/ui.js";
import { markLive } from "../core/features.js";

const tab = S.tabs.inbox || "needs";

export function draw() {
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const waiting = E.state.trunkWaiting || [];
  const finished = E.state.runs?.filter(r => r.status === 'done') || [];
  const history = E.state.runs || [];

  let html = `<main class="main enter11" id="main"><div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <h1>Inbox</h1><p class="lede">Everything a Trunk is waiting on you for, what finished, and a record of what ran.</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === 'needs' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="needs">Needs you${waiting.length ? `<span class="n">${waiting.length}</span>` : ''}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'finished' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="finished">Finished</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'history' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="history">History</button></div>
    <div class="rows">`;

  if (tab === "needs") {
    if (waiting.length > 1) html += `<div class="acts" data-css="margin:4px 0 6px"><button class="btn" type="button" data-act="allowall">Allow all ${waiting.length}…</button></div>`;
    html += waiting.length ? waiting.map((w, i) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(w.title || 'Request')}</b><small>${esc(w.trunk || '')}${w.detail ? ' · ' + esc(w.detail) : ''}</small></span><button class="btn ghost sm" type="button" data-act="xdo" data-id="${esc(w.id || i)}" data-v="denied">Don't</button><button class="btn pri sm" type="button" data-act="ask" data-id="${esc(w.id || i)}" data-v="allowed">Allow</button></div>`).join('') : `<p class="empty">Nothing is waiting for you. Trunks show up here when they need a yes.</p>`;
  } else if (tab === "finished") {
    html += finished.length ? finished.slice(0, 20).map(r => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.title || 'Task')}</b><small>${esc(r.trunk || '')}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(r.id || '')}">Open</button></div>`).join('') : `<p class="empty">Nothing finished.</p>`;
  } else if (tab === "history") {
    html += history.length ? history.slice(0, 50).map(r => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.title || 'Task')}</b><small>${esc(r.trunk || '')}</small></span><span class="meta">0s · ${r.cost ? '$' + r.cost.toFixed(2) : 'free'}</span><button class="btn ghost sm" type="button" data-act="toast" data-msg="Plays...">Watch again</button></div>`).join('') : `<p class="empty">Nothing matches.</p>`;
  }

  html += `</div></div></div></main>`;
  return html;
}

export function init() {
  markLive(["ptab", "ask", "chat",]);
}

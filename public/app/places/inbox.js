/* Inbox: approvals, finished tasks, history - matches reference place-inbox-*.html.
   "Needs you" lists two kinds of request, each answered only by its own route: a task waiting on a yes (GET /api/policy;
   Allow names it by session and fingerprint, the chat's exact-match "ask"), and a message one Trunk wants to send
   another (state.trunkWaiting; POST /api/trunks/messages/<id>/answer or /decline). */

import { esc, renderNow } from "../core/dom.js";
import { S, E, refresh } from "../core/state.js";
import { ic, av, toast } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";

let asks = [];
const trunkName = (id) => (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.id === id || t.name === id)?.name ?? id ?? "";

function askRow(q) {
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(q.question || q.label || "")}</b><small>${esc([trunkName(q.trunk), q.question ? q.label : q.target].filter(Boolean).join(" · "))}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(q.sessionId)}">Open</button><button class="btn pri sm" type="button" data-act="ask" data-v="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint || "")}">Allow</button></div>`;
}
function messageRow(m) {
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(m.message)}</b><small>${esc(trunkName(m.from))} → ${esc(trunkName(m.to))}</small></span><button class="btn ghost sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="decline">Don’t</button><button class="btn pri sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="answer">Allow</button></div>`;
}

export function draw() {
  const tab = S.tabs.inbox || "needs";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const waiting = E.state.trunkWaiting || [];
  const finished = E.state.runs?.filter(r => r.status === 'done') || [];
  const history = E.state.runs || [];

  let html = `<main class="main enter11" id="main"><div class="lock-banner">${ic('lock', 's')}Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <h1>Inbox</h1><p class="lede">Everything a Trunk is waiting on you for, what finished, and a record of what ran.</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === 'needs' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="needs">Needs you${waiting.length ? `<span class="n">${waiting.length}</span>` : ''}</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'finished' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="finished">Finished</button><button class="tab" role="tab" type="button" aria-selected="${tab === 'history' ? 'true' : 'false'}" data-act="ptab" data-place="inbox" data-v="history">History</button></div>
    <div class="rows">`;

  if (tab === "needs") {
    const count = asks.length + waiting.length;
    if (count > 1) html += `<div class="acts" data-css="margin:4px 0 6px"><button class="btn" type="button" data-act="allowall">Allow all ${count}…</button></div>`;
    html += count ? asks.map(askRow).join("") + waiting.map(messageRow).join("") : `<p class="empty">Nothing is waiting for you. Trunks show up here when they need a yes.</p>`;
  } else if (tab === "finished") {
    html += finished.length ? finished.slice(0, 20).map(r => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.title || 'Task')}</b><small>${esc(r.trunk || '')}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(r.id || '')}">Open</button></div>`).join('') : `<p class="empty">Nothing finished.</p>`;
  } else if (tab === "history") {
    html += history.length ? history.slice(0, 50).map(r => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.title || 'Task')}</b><small>${esc(r.trunk || '')}</small></span><span class="meta">0s · ${r.cost ? '$' + r.cost.toFixed(2) : 'free'}</span><button class="btn ghost sm" type="button" data-act="toast" data-msg="Plays...">Watch again</button></div>`).join('') : `<p class="empty">Nothing matches.</p>`;
  }

  html += `</div></div></div></main>`;
  return html;
}

/* After a draw: re-read the tasks waiting on a yes, and draw again only if the list changed. */
export async function after() {
  const fresh = (await api("policy").catch(() => ({}))).waiting ?? [];
  const key = (list) => list.map((q) => q.sessionId + q.fingerprint).join();
  if (key(fresh) !== key(asks)) { asks = fresh; renderNow(); }
}

export function init() {
  markLive(["ptab", "chat", "tmsg"]);
  on("tmsg", async (el) => {
    try { await api(`trunks/messages/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "answer" ? "answer" : "decline"}`, {}); } catch (error) { toast(error.message); }
    await refresh().catch(() => {});
    renderNow();
  });
}

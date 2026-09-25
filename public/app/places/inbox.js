/* Inbox: approvals, finished tasks, history - matches reference place-inbox-*.html.
   "Needs you" lists two kinds of request, each answered only by its own route: a task waiting on a yes (GET /api/policy;
   Allow names it by session and fingerprint, the chat’s exact-match "ask"), and a message one Trunk wants to send
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

function needsTab() {
  const count = asks.length + E.state.trunkWaiting.length;
  let html = `<div class="rows">`;
  if (count > 1) html += `<div class="acts" data-css="margin:4px 0 6px"><button class="btn" type="button" data-act="allowall">Allow all ${count}…</button></div>`;
  html += asks.map(askRow).join("");
  html += E.state.trunkWaiting.map(messageRow).join("");
  html += `</div>`;
  return html;
}

function finishedTab() {
  const finished = E.state.runs?.filter(r => r.status === "completed") || [];
  let html = `<div class="rows">`;
  html += finished.slice(0, 20).map(r => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.prompt?.split("\n")[0]?.slice(0, 50) || "Task")}</b><small>${esc(r.sessionId || "")}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(r.sessionId || "")}">Open</button></div>`).join("");
  html += `</div>`;
  return html;
}

function historyTab() {
  const history = E.state.runs || [];
  let html = `<div class="rows"><div class="nl"><input class="inp" id="histq" placeholder="Search what ran" value="" aria-label="Search history"><button type="button" class="rec15" data-act="verify15" data-tip="Every entry is linked to the one before it, so a removed or rewritten entry shows."><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3z"></path><path d="M8.8 12.2l2.2 2.2 4.2-4.4"></path></svg><span>Record intact</span><u>Verify</u></button></div>`;
  html += history.slice(0, 50).map(r => {
    const duration = r.updatedAt && r.createdAt ? Math.round((new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000) : 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.prompt?.split("\n")[0]?.slice(0, 50) || "Task")}</b><small>${esc(r.sessionId || "")}</small></span><span class="meta">${durationStr} · ${esc(typeof r.cost?.amount === "number" ? "$" + r.cost.amount.toFixed(2) : r.cost?.display ?? "")}</span><button class="btn ghost sm" type="button" data-act="toast" data-msg="Plays the task back step by step.">Watch again</button></div>`;
  }).join("");
  html += `</div>`;
  return html;
}

export function draw() {
  const tab = S.tabs.inbox || "needs";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const count = asks.length + E.state.trunkWaiting.length;
  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    <div class="recbar"><span class="mark mark-face rec-mark" aria-hidden="true"></span><span class="rec-t"><b>Keep your Trunks running when Branch is closed?</b><span class="rec">Recommended</span><small>The gateway keeps Telegram, your phone and automations working, and restarts Branch if it ever stops.</small></span>
    <button class="btn pri sm" type="button" data-act="rec" data-k="gw" data-v="yes">Yes</button><button class="btn sm" type="button" data-act="rec" data-k="gw" data-v="later">Not now</button><button class="btn ghost sm" type="button" data-act="rec" data-k="gw" data-v="never">Don’t ask again</button></div>
    <h1>Inbox</h1><p class="lede">Everything a Trunk is waiting on you for, what finished, and a record of what ran.</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === "needs" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="needs">Needs you<span class="n">${count}</span></button><button class="tab" role="tab" type="button" aria-selected="${tab === "finished" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="finished">Finished</button><button class="tab" role="tab" type="button" aria-selected="${tab === "history" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="history">History</button></div>`;

  if (tab === "needs") {
    html += needsTab();
  } else if (tab === "finished") {
    html += finishedTab();
  } else if (tab === "history") {
    html += historyTab();
  }

  html += `</div></div></main>`;
  return html;
}

/* After a draw: re-read the tasks waiting on a yes, and draw again only if the list changed. */
export async function after() {
  const fresh = (await api("policy").catch(() => ({}))).waiting ?? [];
  const key = (list) => list.map((q) => q.sessionId + q.fingerprint).join();
  if (key(fresh) !== key(asks)) { asks = fresh; renderNow(); }
}

export function init() {
  markLive(["ptab", "chat", "tmsg", "ask", "verify15"]);
  on("tmsg", async (el) => {
    try { await api(`trunks/messages/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "answer" ? "answer" : "decline"}`, {}); } catch (error) { toast(error.message); }
    await refresh().catch(() => {});
    renderNow();
  });
  on("ask", async (el) => {
    const sessionId = el.dataset.sid;
    const fingerprint = el.dataset.fp;
    if (!sessionId || fingerprint === undefined) return; // Must have exact ids
    try {
      await api("policy/approve", { sessionId, fingerprint, decision: "allow", remember: "never", carryOn: true });
    } catch (error) {
      toast(error.message);
    }
    await refresh().catch(() => {});
    renderNow();
  });
  on("allowall", async (el) => {
    // Check that all asks have exact sessionId and fingerprint
    const allExact = asks.every(q => q.sessionId && q.fingerprint !== undefined);
    if (!allExact) return; // Grey it if any row is missing exact ids
    try {
      for (const q of asks) {
        await api("policy/approve", { sessionId: q.sessionId, fingerprint: q.fingerprint, decision: "allow", remember: "never", carryOn: true });
      }
    } catch (error) {
      toast(error.message);
    }
    await refresh().catch(() => {});
    renderNow();
  });
  on("verify15", async (el) => {
    // Verify activity chain integrity
    try {
      const result = await api("safety-extras/activity/verify", {});
      toast(`Activity chain verified: ${result.count || 0} entries`);
    } catch (error) {
      toast(error.message);
    }
  });
}

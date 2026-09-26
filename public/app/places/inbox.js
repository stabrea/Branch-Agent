/* Inbox: approvals, finished tasks, history - matches reference place-inbox-*.html.
   "Needs you" lists two kinds of request, each answered only by its own route: a task waiting on a yes (GET /api/policy;
   Allow names it by session and fingerprint, the chat’s exact-match "ask"), and a message one Trunk wants to send
   another (state.trunkWaiting; POST /api/trunks/messages/<id>/answer or /decline).
   Above every tab: each task Branch closed on that can be continued (state.attention with canContinue), picked up with
   POST /api/runs/<id>/resume or left with POST /api/runs/<id>/cancel. At the bottom of "Needs you": each request to change
   Branch itself (GET /api/self-development/requests); its review shows the request, and answering it stays greyed.
   History's "Verify" walks the activity chain (POST /api/safety-extras/activity/verify) and shows what the engine found.
   "Watch again" plays a task back from its recording (GET /api/runs/<id>/recording): the engine's own frames, stepped or
   played; with recordings switched off the engine's sentence is shown. It never runs the task again. */

import { $, esc, renderNow, paint } from "../core/dom.js";
import { S, E, refresh, level } from "../core/state.js";
import { ic, av, toast, openDlg, dialog } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { openConversation } from "../chat/chat.js";
import { recBar } from "../chat/rec.js";

let asks = [];
let installs = [];
let changeRequests = [];
let chain = null;
const trunkName = (id) => (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.id === id || t.name === id)?.name ?? id ?? "";
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 60);
const runById = (id) => (E.state.runs ?? []).find((r) => r.id === id);
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

function askRow(q) {
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(q.question || q.label || "")}</b><small>${esc([trunkName(q.trunk), q.question ? q.label : q.target].filter(Boolean).join(" · "))}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(q.sessionId)}">Open</button><button class="btn pri sm" type="button" data-act="ask" data-v="allow" data-sid="${esc(q.sessionId)}" data-fp="${esc(q.fingerprint || "")}">Allow</button></div>`;
}
/* A request for a package or a tool server (GET /api/flows-boards/installs, status waiting). Answering it only writes the
   answer down: a yes comes back with the exact next step, and nothing is installed. */
function installRow(r) {
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(r.ask?.why ?? "")}</b><small>${esc(r.from)} wants “${esc(r.ask?.name ?? "")}”. Nothing is installed until you allow it.</small></span><button class="btn ghost sm" type="button" data-act="xdo" data-id="${esc(r.id)}" data-v="denied">Don’t</button><button class="btn pri sm" type="button" data-act="xdo" data-id="${esc(r.id)}" data-v="allowed">Allow</button></div>`;
}
function messageRow(m) {
  return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(m.message)}</b><small>${esc(trunkName(m.from))} → ${esc(trunkName(m.to))}</small></span><button class="btn ghost sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="decline">Don’t</button><button class="btn pri sm" type="button" data-act="tmsg" data-id="${esc(m.id)}" data-v="answer">Allow</button></div>`;
}

/* A task Branch closed on, from the engine's attention list; its name is the task's own first line. */
function cutCard(a) {
  const trunk = a.who ? (Array.isArray(E.trunks) ? E.trunks : []).find((t) => t.name === a.who) : null;
  const name = firstLine(runById(a.runId)?.prompt) || a.question;
  return `<div class="cut15" role="status">${trunk ? av(trunk, 30) : av({ kind: "main" }, 30)}<span class="grow"><b>Pick up what the update cut off</b><small>${esc(name)}</small></span><button class="btn ghost sm" type="button" data-act="cutno15" data-id="${esc(a.runId)}">Leave it</button><button class="btn pri sm" type="button" data-act="cutgo15" data-id="${esc(a.runId)}" data-sid="${esc(a.sessionId)}">Pick it up</button></div>`;
}
const cutCards = () => (E.state.attention ?? []).filter((a) => a.canContinue).map(cutCard).join("");

function selfCard(r) {
  return `<div class="self15"><span class="ico-tile">${ic("branch", "s")}</span><span class="grow"><b>Branch wants to improve itself</b><small>${esc(firstLine(r.text))} · waiting for you</small></span><button class="btn sm" type="button" data-act="selfrev15" data-id="${esc(r.id)}">Review</button></div>`;
}
const waitingChanges = () => changeRequests.filter((r) => r.status === "waiting");

const waitingCount = () => asks.length + E.state.trunkWaiting.length + installs.length;
function needsTab() {
  const count = waitingCount();
  let html = `<div class="rows">`;
  if (count > 1) html += `<div class="acts" data-css="margin:4px 0 6px"><button class="btn" type="button" data-act="allowall">Allow all ${count}…</button></div>`;
  html += asks.map(askRow).join("");
  html += installs.map(installRow).join("");
  html += E.state.trunkWaiting.map(messageRow).join("");
  html += `</div>`;
  return html + waitingChanges().map(selfCard).join("");
}

function finishedTab() {
  const finished = E.state.runs?.filter((r) => r.status === "completed") || [];
  const rows = finished.slice(0, 20).map((r) => `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(firstLine(r.prompt))}</b><small>${esc(firstLine(r.output))}</small></span><button class="btn sm" type="button" data-act="chat" data-id="${esc(r.sessionId || "")}">Open</button></div>`);
  return `<div class="rows">${rows.join("")}</div>`;
}

function duration(r) {
  const secs = r.updatedAt && r.createdAt ? Math.round((new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 1000) : 0;
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}
/* The newest finished task, offered to watch again; the tile is not drawn when nothing has finished. */
function replayTile() {
  const done = (E.state.runs ?? []).filter((r) => r.status === "completed"), last = done[0];
  if (!last) return "";
  const before = done.find((r) => r !== last && r.prompt === last.prompt);
  const day = before ? dayWord(before.createdAt) : "";
  const compare = before ? `<button class="btn ghost sm" type="button" data-act="compare" data-id="${esc(last.id)}" data-v="${esc(before.id)}">Compare it with ${esc(day.charAt(0).toLowerCase() + day.slice(1))}’s</button>` : "";
  return `<div class="tile" data-css="margin:10px 0 12px"><div class="th"><b>Watch a task again</b></div><p>Step through what a task did, see the path it took, and keep it as a page or a workflow that repeats it.</p><div class="acts"><button class="btn sm" type="button" data-act="replay" data-id="${esc(last.id)}">${ic("play", "s")}Watch “${esc(firstLine(last.prompt))}”</button>${compare}</div></div>`;
}

/* A task's day as the prototype names it: Today, Last <weekday> within the week, else the date. */
function dayWord(iso) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  if (now.getTime() - d.getTime() < 7 * 86400000) return `Last ${d.toLocaleDateString([], { weekday: "long" })}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/* Two tasks side by side, both read from GET /api/runs/<id>/inspect (the record the inspector reads): the cost, the time,
   the rounds and the tools used, then how the answers differ line by line. */
async function openCompare(el) {
  let older, newer;
  try { [older, newer] = await Promise.all([api(`runs/${encodeURIComponent(el.dataset.v)}/inspect`), api(`runs/${encodeURIComponent(el.dataset.id)}/inspect`)]); } catch (error) { toast(error.message); return; }
  const secs = (s) => { const n = Math.round(Number(s) || 0); return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`; };
  const rows = [["Cost", older.cost?.display ?? "", newer.cost?.display ?? ""], ["Time", secs(older.seconds), secs(newer.seconds)], ["Rounds", older.rounds?.length ?? 0, newer.rounds?.length ?? 0], ["Tools used", older.calls?.length ?? 0, newer.calls?.length ?? 0]];
  const table = `<table class="cmp6"><thead><tr><th></th><th>${esc(dayWord(older.run.createdAt))}</th><th>${esc(dayWord(newer.run.createdAt))}</th></tr></thead><tbody>${rows.map(([n, a, b]) => `<tr><th>${n}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join("")}</tbody></table>`;
  const was = String(older.run.output ?? "").split("\n"), now = String(newer.run.output ?? "").split("\n");
  const diff = [...was.filter((l) => !now.includes(l)).map((l) => `<span class="d-del">- ${esc(l)}</span>`), ...now.map((l) => (was.includes(l) ? `<span>  ${esc(l)}</span>` : `<span class="d-add">+ ${esc(l)}</span>`))].join("");
  openDlg({ title: "Two tasks side by side", wide: true, body: `${table}<pre class="diff6">${diff}</pre><p class="hint">Read from the same “Look inside” record the inspector uses; nothing new is worked out.</p>`, foot: '<button class="btn pri" type="button" data-act="dlg-close">Done</button>' });
}

function historyTab() {
  const verify = `<button type="button" class="rec15" data-act="verify15" data-tip="Every entry is linked to the one before it, so a removed or rewritten entry shows.">${ic("shield15", "s")}<span>${chain?.ok ? "Record intact" : ""}</span><u>Verify</u></button>`;
  const rows = (E.state.runs || []).slice(0, 50).map((r) => {
    const cost = typeof r.cost?.amount === "number" ? "$" + r.cost.amount.toFixed(2) : r.cost?.display ?? "";
    return `<div class="prow">${av({}, 34)}<span class="grow"><b>${esc(firstLine(r.prompt))}</b><small>${esc(when(r.createdAt))}</small></span><span class="meta">${[duration(r), cost].filter(Boolean).map(esc).join(" · ")}</span><button class="btn ghost sm" type="button" data-act="replay" data-id="${esc(r.id)}">Watch again</button></div>`;
  });
  return `${replayTile()}<div class="rows"><div class="nl"><input class="inp" id="histq" placeholder="Search what ran" value="" aria-label="Search history">${verify}</div>${rows.join("")}</div>`;
}

export function draw() {
  const tab = S.tabs.inbox || "needs";
  if (!E.state) return `<main class="main enter11" id="main"><div class="scroll"><div class="place"></div></div></main>`;

  const count = waitingCount();
  let html = `<main class="main enter11" id="main"><div class="lock-banner"><svg class="i s" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z"></path></svg>Lockdown is on. Trunks can read, but nothing leaves this computer and nothing is changed.<button type="button" data-act="lock">Turn it off</button></div><div class="scroll"><div class="place">
    ${recBar()}
    <h1>Inbox</h1><p class="lede">Everything a Trunk is waiting on you for, what finished, and a record of what ran.</p>
    <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" aria-selected="${tab === "needs" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="needs">Needs you<span class="n">${count}</span></button><button class="tab" role="tab" type="button" aria-selected="${tab === "finished" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="finished">Finished</button><button class="tab" role="tab" type="button" aria-selected="${tab === "history" ? "true" : "false"}" data-act="ptab" data-place="inbox" data-v="history">History</button></div>`;

  html += cutCards();
  if (tab === "needs") html += needsTab();
  else if (tab === "finished") html += finishedTab();
  else if (tab === "history") html += historyTab();

  html += `</div></div></main>`;
  return html;
}

/* A refusal while re-reading is said once, not on every redraw, and the list it was for is drawn empty. */
const said = new Set();
function sayOnce(error) {
  if (!said.has(error.message)) { said.add(error.message); toast(error.message); }
  return {};
}

/* The waiting requests for packages and tool servers; with that part switched off (GET /api/flows-boards) there are none. */
async function readInstalls() {
  const modes = (await api("flows-boards").catch(sayOnce)).modes ?? {};
  if (!modes["install-requests"] || modes["install-requests"] === "off") return [];
  return ((await api("flows-boards/installs").catch(sayOnce)).requests ?? []).filter((r) => r.status === "waiting");
}

/* Don’t declines, Allow approves (POST /api/flows-boards/installs/<id>/decline|approve); a yes shows the engine's next step. */
async function answerInstall(el) {
  const yes = el.dataset.v === "allowed";
  el.disabled = true;
  try {
    const { request } = await api(`flows-boards/installs/${encodeURIComponent(el.dataset.id)}/${yes ? "approve" : "decline"}`, {});
    if (yes && request?.nextStep) toast(request.nextStep);
  } catch (error) { toast(error.message); }
  installs = await readInstalls();
  renderNow();
}

/* After a draw: re-read what the tab shows from the engine, and draw again only if it changed. */
export async function after() {
  const tab = S.tabs.inbox || "needs";
  let changed = false;
  const fresh = (await api("policy").catch(sayOnce)).waiting ?? [];
  const key = (list) => list.map((q) => q.sessionId + q.fingerprint).join();
  if (key(fresh) !== key(asks)) { asks = fresh; changed = true; }
  if (tab === "needs") {
    const requests = (await api("self-development/requests").catch(sayOnce)).requests ?? [];
    if (JSON.stringify(requests) !== JSON.stringify(changeRequests)) { changeRequests = requests; changed = true; }
    const waiting = await readInstalls();
    if (JSON.stringify(waiting) !== JSON.stringify(installs)) { installs = waiting; changed = true; }
  }
  if (tab === "history" && !chain) {
    try { chain = (await api("safety-extras/activity/verify", {})).check; changed = true; } catch (error) { toast(error.message); chain = { ok: false }; }
  }
  if (changed) renderNow();
}

/* Checking the record: the engine walks the whole chain and answers whether it is unbroken, and where not. */
async function verifyRecord() {
  openDlg({ title: "Checking the record", body: `<div class="ver15"><div class="ver-ring15"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27"/><circle class="ver-arc15" cx="32" cy="32" r="27" pathLength="100"/></svg>${ic("shield15")}</div><b id="ver-t15"></b><p class="hint" id="ver-s15">Each entry carries a fingerprint of the one before it.</p></div>`, foot: '<button class="btn" type="button" data-act="dlg-close">Close</button>' });
  let check;
  try { check = (await api("safety-extras/activity/verify", {})).check; } catch (error) { toast(error.message); return; }
  chain = check;
  const box = dialog()?.querySelector(".ver15");
  if (!box) return renderNow();
  box.classList.toggle("ok15", check.ok);
  $("#ver-t15").textContent = check.ok ? "Record intact" : check.reason;
  $("#ver-s15").innerHTML = `${check.ok ? esc(check.reason) : ""}${level() >= 2 ? `<br><code>chain head ${esc(String(check.tip).slice(0, 4))}…${esc(String(check.tip).slice(-4))} · sha-256</code>` : ""}`;
  renderNow();
}

/* ---------- watching a task again: the engine's recording, one frame at a time ---------- */
const RP = { frames: [], i: 0, timer: null };
function stopReplay() { clearInterval(RP.timer); RP.timer = null; }
function drawReplay(i) {
  RP.i = i;
  const box = dialog()?.querySelector(".replay6");
  if (!box) return stopReplay();
  const n = RP.frames.length;
  const path = RP.frames.map((_, j) => `<i class="${j < i ? "rp-d" : j === i ? "rp-n" : ""}"></i>`).join("<b></b>");
  const steps = RP.frames.map((f, j) => `<li class="${j < i ? "ok" : ""} ${j === i ? "now6" : ""}">${ic(j < i ? "check" : j === i ? "play" : "info", "s")}<span>${esc(f.label)}<small>${esc(f.detail)}</small></span></li>`).join("");
  paint(box, `<div class="rp-path">${path}</div><ol class="tl">${steps}</ol><span class="meter6"><u data-css="width:${n ? ((i + 1) / n) * 100 : 0}%"></u></span>`);
}
async function openReplay(id) {
  let recording;
  try { recording = await api(`runs/${encodeURIComponent(id)}/recording`); } catch (error) { toast(error.message); return; }
  stopReplay();
  RP.frames = recording.frames ?? [];
  openDlg({ title: "Watch a task again", wide: true, body: '<div class="replay6"></div>',
    foot: `<button class="btn ghost" type="button" data-act="rp" data-v="step">Step</button><button class="btn" type="button" data-act="rp" data-v="play">${ic("play", "s")}Play</button><span class="grow"></span><button class="btn ghost" type="button" data-act="toast">Save as a page</button><button class="btn" type="button" data-act="toast">Make a workflow</button>` });
  drawReplay(0);
}
/* Step moves one frame on; Play runs from here (or from the start, once at the end) through the frames already loaded. */
function stepReplay(el) {
  stopReplay();
  const last = RP.frames.length - 1;
  if (last < 0) return;
  if (el.dataset.v === "step") return drawReplay(Math.min(last, RP.i + 1));
  let i = RP.i >= last ? 0 : RP.i;
  drawReplay(i);
  RP.timer = setInterval(() => { if (++i > last || !dialog()?.querySelector(".replay6")) return stopReplay(); drawReplay(i); }, 800);
}

/* The request as it was sent, who sent it and from which app; answering it needs the owner's contract terms and stays greyed. */
function reviewChange(id) {
  const r = changeRequests.find((x) => x.id === id);
  if (!r) return;
  const stages = [["Approve the edits"], ["Publish a draft pull request"]].map(([t], i) => `<li class="${i === 0 ? "now" : ""}"><em>${i + 1}</em>${t}</li>`).join("");
  openDlg({ title: "A change to Branch’s own code", wide: true,
    body: `<p data-css="margin:0 0 10px">${esc(r.text)}</p><p class="hint">${esc([r.from?.senderName, r.from?.channel, when(r.at)].filter(Boolean).join(" · "))}</p>${r.problem ? `<p class="hint">${esc(r.problem)}</p>` : ""}<ol class="stages15">${stages}</ol>`,
    foot: `<button class="btn ghost" type="button" data-act="selfdo15" data-v="gone" data-id="${esc(r.id)}">Decline</button><button class="btn pri" type="button" data-act="selfdo15" data-v="editing" data-id="${esc(r.id)}">Approve the edits</button>` });
}

export function init() {
  markLive(["ptab", "chat", "tmsg", "cutgo15", "cutno15", "verify15", "selfrev15", "replay", "rp", "compare", "xdo"]);
  on("replay", (el) => openReplay(el.dataset.id));
  on("compare", (el) => openCompare(el));
  on("xdo", (el) => answerInstall(el));
  on("rp", (el) => stepReplay(el));
  on("tmsg", async (el) => {
    try { await api(`trunks/messages/${encodeURIComponent(el.dataset.id)}/${el.dataset.v === "answer" ? "answer" : "decline"}`, {}); } catch (error) { toast(error.message); }
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
  /* Continues the task from its saved transcript in its own conversation; the engine answers once it has run. */
  on("cutgo15", (el) => {
    const run = api(`runs/${encodeURIComponent(el.dataset.id)}/resume`, {});
    openConversation(el.dataset.sid);
    run.catch((error) => toast(error.message)).finally(() => refresh().catch((error) => toast(error.message)));
  });
  /* Leaving it ends the task, so the card does not come back. */
  on("cutno15", async (el) => {
    try { await api(`runs/${encodeURIComponent(el.dataset.id)}/cancel`, {}); } catch (error) { toast(error.message); }
    await refresh().catch((error) => toast(error.message));
    renderNow();
  });
  on("verify15", () => verifyRecord());
  on("selfrev15", (el) => reviewChange(el.dataset.id));
}

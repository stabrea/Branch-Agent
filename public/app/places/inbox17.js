/* Inbox, pass 17 (patch17b.js, SHOWCASE17 rows 6, 113 and 114).
   - Needs you: each task that stopped for want of something (GET /api/adapt stops) as its own card. "What it needs" asks
     the engine what is missing, what would fix it and what that costs (POST /api/adapt/plan, which changes nothing) and
     shows the engine's own sentence. "Leave it stopped" keeps the stop but no longer offers it (POST /api/adapt/leave).
     "Fetch it and carry on" and the pick stay greyed: a yes installs a program through the one button and starts the task
     again, which is for the security review.
   - Later: every job a task handed over to finish later (GET /api/deferred), with its own words; one still waiting is
     answered with Done (POST /api/deferred/settle), which carries its task on in its own conversation.
   - History › Signed receipts: the engine's tamper-evident chain of what happened (GET /api/safety-extras/activity), each
     entry with its fingerprint and the one it links to, the break the engine's own check found (POST
     /api/safety-extras/activity/verify), and "Check this run" reads that run's signed receipts (GET
     /api/runs/<id>/receipts). "What a break looks like" would draw made-up entries, so it stays greyed. */

import { esc, renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { av, toast, openDlg, closeDlg, dialog } from "../core/ui.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { pill17, prow17, sec17, btn17, when17, short17 } from "./parts17.js";

let stops = [];
let deferred = [];
const trunks = () => (Array.isArray(E.trunks) ? E.trunks : []);
/* The Trunk a conversation belongs to, or none. */
function trunkOf(sessionId) {
  const s = E.sessions.find((x) => (x.sessionId ?? x.id) === sessionId);
  return trunks().find((t) => t.id === s?.trunkId || (t.chatSessionId && t.chatSessionId === sessionId)) ?? null;
}
const faceOf = (sessionId, size) => av(trunkOf(sessionId) ?? { kind: "main" }, size);
const nameOf = (sessionId) => trunkOf(sessionId)?.name ?? E.state?.identity?.name ?? "";

/* ---------- Needs you: a stopped task says what it needs ---------- */
export function adaptCards() {
  return stops.map((s) => `<div class="adapt-b17">${faceOf(s.sessionId, 30)}<span class="grow"><b>${esc(s.what)}</b><small>${esc(s.blocker?.said ?? "")}</small></span><button class="btn pri sm" type="button" data-act="adaptb17" data-id="${esc(s.id)}">What it needs</button></div>`).join("");
}

async function openAdapt(id) {
  const stop = stops.find((s) => s.id === id);
  if (!stop) return;
  let view;
  try { view = await api("adapt/plan", { stopId: id }); } catch (error) { toast(error.message); return; }
  const fix = view.fix && !view.fix.instead ? view.fix : null;
  const facts = [["Stopped at", stop.nextStep], ["Missing", (view.blocker ?? stop.blocker)?.what ?? ""], ["Kept", stop.done.join(", ")]];
  const picked = Boolean(fix);
  const option = fix ? `<div class="opts-b17"><button type="button" class="upd-o15" data-act="adaptpickb17" data-id="${esc(id)}" aria-pressed="${picked}"><b>${esc(fix.what)}</b><small>${esc([fix.from, fix.size].filter(Boolean).join(" · "))}</small></button></div>` : "";
  openDlg({
    title: `What ${nameOf(stop.sessionId)} needs to carry on`,
    body: `<p class="lead-b17">${esc(view.message)}</p><div class="scope15 s3-b17">${facts.map(([a, b]) => `<div><small>${a}</small><b>${esc(b)}</b></div>`).join("")}</div>${option}`,
    foot: `<button class="btn ghost" type="button" data-act="adaptnob17" data-id="${esc(id)}">Leave it stopped</button><button class="btn pri" type="button" data-act="adaptgob17" data-id="${esc(id)}" ${fix ? "" : "disabled"}>Fetch it and carry on</button>`,
  });
}

async function leaveStopped(id) {
  try { await api("adapt/leave", { stopId: id }); } catch (error) { toast(error.message); return; }
  closeDlg();
  await readStops();
  renderNow();
}

/* ---------- Later: work handed over to finish later ---------- */
const HOW = { "user.task": "A step you do by hand", "web.page": "A step you do by hand", "web.crawl": "A step you do by hand" };
export const laterCount = () => deferred.filter((d) => !d.settledAt).length;

function laterRow(d) {
  const settled = Boolean(d.settledAt);
  const line = settled ? d.outcome : when17(d.createdAt);
  const right = settled ? pill17("done", "Settled") : btn17("laterb17", "Done", `data-id="${esc(d.id)}"`);
  return `<div class="prow later-b17">${faceOf(d.sessionId, 34)}<span class="grow"><b>${esc(String(d.description ?? "").split("\n")[0])}</b><small>${esc(line)}</small><small class="how-b17">${esc(HOW[d.tool] ?? "Handed over")}</small></span>${right}</div>`;
}
export function laterTab() {
  return `<p class="hint" data-css="margin:4px 0 8px">Work that finishes later: by a reply it waits for, a step only you can do, or a job handed over to another time.</p><div class="rows">${deferred.map(laterRow).join("")}</div>`;
}

async function settle(el) {
  el.disabled = true;
  try { await api("deferred/settle", { id: el.dataset.id, outcome: "Done." }); } catch (error) { toast(error.message); }
  await readDeferred();
  renderNow();
}

/* ---------- History: signed receipts ---------- */
export const receiptsSection = () => sec17("Signed receipts", prow17("shield", "Every tool call leaves a signed receipt", "Each run’s receipts link to the one before, so nothing can be cut or rewritten quietly.", btn17("chainb17", "See the chain")));

const CH = { entries: [], check: null, rc: {} };
const RECEIPT_BAD = ["forged", "modified", "unsigned"];

function chainItem(e) {
  const broken = CH.check && !CH.check.ok && CH.check.brokenAt === e.seq;
  const rc = e.runId ? CH.rc[e.runId] : null;
  let right = "";
  if (broken) right = pill17("no", "Link broken");
  else if (rc) right = rc.ok ? pill17("ok", "Signed · matches") : pill17("no", rc.bad.join(", "));
  else if (e.runId) right = btn17("rcptb17", "Check this run", `data-id="${esc(e.runId)}"`);
  return `<li class="${broken ? "bad-b17" : ""}"><span class="grow"><b>${esc(e.detail || e.kind)}</b><small>${esc(when17(e.at))} · <code>${esc(short17(e.hash))}</code> · links to <code>${esc(short17(e.prev))}</code></small></span>${right}</li>`;
}
function drawChain() {
  const scroll = dialog()?.querySelector(".dlg-b")?.scrollTop ?? 0;
  openDlg({ title: "The chain of receipts", wide: true,
    body: `<p class="lead-b17">Newest first. Each entry carries the fingerprint of the one before it.</p><ol class="chain-b17">${CH.entries.map(chainItem).join("")}</ol><p class="hint">${CH.check && !CH.check.ok ? esc(CH.check.reason) : "Checking a run re-reads its receipts and the tool answers they cover."}</p>`,
    foot: '<button class="btn ghost" type="button" data-act="chaintamperb17">What a break looks like</button><button class="btn" type="button" data-act="dlg-close">Close</button>' });
  const body = dialog()?.querySelector(".dlg-b");
  if (body) body.scrollTop = scroll;
}
async function openChain() {
  try {
    const [list, verified] = await Promise.all([api("safety-extras/activity?limit=50"), api("safety-extras/activity/verify", {})]);
    CH.entries = list.entries ?? [];
    CH.check = verified.check ?? null;
  } catch (error) { toast(error.message); return; }
  drawChain();
}
async function checkRun(el) {
  let answer;
  try { answer = await api(`runs/${encodeURIComponent(el.dataset.id)}/receipts`); } catch (error) { toast(error.message); return; }
  const bad = RECEIPT_BAD.filter((k) => (answer.counts?.[k] ?? 0) > 0);
  CH.rc[el.dataset.id] = { ok: bad.length === 0, bad };
  drawChain();
  if (!bad.length) toast("Receipts for this run match the tool answers they cover.");
}

/* ---------- reading and actions ---------- */
async function readStops() { stops = (await api("adapt")).stops ?? []; }
async function readDeferred() { deferred = (await api("deferred")).deferred ?? []; }

/* After the Inbox draws: the stops (Needs you) and the handed-over jobs (every tab, for the Later count). */
export async function readInbox17(tab) {
  const before = JSON.stringify([stops, deferred]);
  const tasks = [readDeferred()];
  if (tab === "needs") tasks.push(readStops());
  const failed = (await Promise.allSettled(tasks)).find((r) => r.status === "rejected");
  if (failed) return { changed: false, error: failed.reason };
  return { changed: JSON.stringify([stops, deferred]) !== before };
}

export function initInbox17() {
  markLive(["adaptb17", "adaptnob17", "laterb17", "chainb17", "rcptb17"]);
  on("adaptb17", (el) => openAdapt(el.dataset.id));
  on("adaptnob17", (el) => leaveStopped(el.dataset.id));
  on("laterb17", (el) => settle(el));
  on("chainb17", () => openChain());
  on("rcptb17", (el) => checkRun(el));
}

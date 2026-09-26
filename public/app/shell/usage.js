/* The status bar's version popover says what the engine plans to do about updates (POST /api/comfort/update-plan);
   installing goes through the desktop app's updater, so Install stays greyed here. Its usage popover is 1:1 with the
   prototype's "What each connection has left": one row per connection from GET /api/usage/glance, a bar only where the service gave a limit, and the engine's own sentence when it gave none.
   Accounts are shown side by side, never added together.
   Near a limit (a window the service measured at 95% used) while tasks run, and only while the owner leaves the offer on
   (GET /api/usage/glance settings.saveProgress "ask"), the prototype's save-progress offer: Save progress asks every
   running task to write down where it is (POST /api/usage/save-progress), Not now dismisses it. Each window is offered once. */

import { $, esc, renderNow } from "../core/dom.js";
import { openPop, closePop, mi, toast, app, ic } from "../core/ui.js";
import { ACT } from "./activity.js";
import { S, E } from "../core/state.js";
import { api } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive } from "../core/features.js";
import { logo } from "../core/logos.js";

const CHIP = { measured: '<span class="pill ok">Measured</span>', estimated: '<span class="pill warn">Estimate</span>', not_published: '<span class="pill idle">Not published</span>' };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function windowRow(w, estimated) {
  if (w.kind === "money" || !w.limit || w.remaining == null) return `<div class="lim-w"><span>${esc(w.title)}</span><span></span><span>${w.remaining == null ? "" : esc(String(w.remaining))}</span></div>`;
  const pct = Math.max(0, Math.min(100, Math.round((w.remaining / w.limit) * 100)));
  return `<div class="lim-w"><span>${esc(w.title)}</span><span class="lim-bar ${estimated ? "est" : ""}"><i data-css="width:${pct}%;${pct < 15 ? "background:var(--warn)" : ""}"></i></span><span>${pct}% left${w.resetAt ? " · resets " + esc(clock(w.resetAt)) : ""}</span></div>`;
}

function limitRow(r) {
  const body = r.windows?.length
    ? r.windows.map((w) => windowRow(w, w.state === "estimated")).join("") + `<small>${esc(r.note)}</small>`
    : `<small>${esc(r.note)}</small>`;
  return `<div class="lim">${logo(r.connection, r.connectionName, 28)}<div><div class="lim-h"><b>${esc(r.connectionName)}</b><span class="muted">${esc(r.accountLabel ?? "")}</span>${CHIP[r.state] ?? ""}${r.inUse ? '<span class="pill ok">used next</span>' : ""}</div>${body}</div></div>`;
}

function popHTML(g) {
  const month = g?.month?.pricedRuns ? `<span>This month: <b>$${Number(g.month.cost).toFixed(2)}</b></span>` : "";
  return `<div class="lims"><div class="ph" data-css="padding:4px 6px 6px">What each connection has left</div>${(g?.rows ?? []).map(limitRow).join("")}
    <p data-css="font-size:12px;color:var(--ink-3);margin:8px 6px 4px">${esc(g?.summary ?? "")}</p>
    <div class="lim-foot">${month}<span class="tb-grow"></span><button class="btn sm" type="button" data-act="setgo" data-v="usage">Open Usage</button></div></div>`;
}

function updatePop(plan) {
  const version = E.state?.version ?? "";
  return `<div class="pt">Branch ${esc(version)}</div><p class="pp">${esc(plan?.reason ?? "")}</p>${mi("install", "check", "Install when nothing is running")}${mi("closepop", "clock", "Remind me tomorrow")}`;
}

/* ---------- the save-progress offer ---------- */
const OFFERED = "branch-save-progress-asked"; // the key the old window kept, so a window asked about there is not asked again
function offered() {
  try { return JSON.parse(localStorage.getItem(OFFERED) ?? "[]"); } catch (error) { console.warn(error.message); return []; }
}
function remember(key) {
  try { localStorage.setItem(OFFERED, JSON.stringify([...offered(), key].slice(-50))); } catch (error) { console.warn(error.message); }
}
/* "as of just now" only when the window was read in the last 90 seconds, the engine's own cut-off for those words. */
function fresh(g, key) {
  const [connection, , id] = key.split("|");
  const w = g.rows?.find((r) => r.connection === connection)?.windows?.find((x) => x.id === id);
  return w?.measuredAt ? Date.now() - Date.parse(w.measuredAt) < 90_000 : false;
}
function offerHTML(c, justNow) {
  return `<svg class="ck-ring" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--line-2)" stroke-width="3"/><circle class="ck-arc" cx="18" cy="18" r="15" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="94.2" stroke-dashoffset="0" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" class="ck-n">5</text></svg>
    <div class="grow"><b>Almost out on ${esc(c.connectionName)}. Ask running tasks to save their progress?</b><small>${esc(String(c.percentUsed))}% of this window is used. ${justNow ? "Measured, as of just now." : "Measured."} Nothing is paused.</small></div>
    <button class="btn pri sm" type="button" data-act="ckpt-save">Save progress</button><button class="btn ghost sm" type="button" data-act="ckpt-no">Not now</button>`;
}
/* The prototype's five-second ring: the offer goes away by itself when it runs out. */
function countDown(el) {
  const t0 = Date.now(), total = 5000;
  const tick = () => {
    if (!el.isConnected) return;
    const left = Math.max(0, total - (Date.now() - t0));
    el.querySelector(".ck-arc").setAttribute("stroke-dashoffset", String(94.2 * (1 - left / total)));
    el.querySelector(".ck-n").textContent = String(Math.ceil(left / 1000));
    if (left <= 0) el.remove(); else setTimeout(tick, 100);
  };
  tick();
}
async function checkLimits() {
  if (!E.state || document.querySelector(".ckpt-q")) return; // nothing is asked before sign-in
  const g = await api("usage/glance").catch(() => null);
  if (!g?.available || g.settings?.saveProgress !== "ask" || !g.running) return;
  const seen = offered(), c = (g.crossings ?? []).find((x) => !seen.includes(x.key));
  if (!c) return;
  remember(c.key);
  const el = document.createElement("div");
  el.className = "ckpt-q";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-label", "Save progress?");
  el.innerHTML = offerHTML(c, fresh(g, c.key));
  app().appendChild(el);
  countDown(el);
}
async function saveProgress() {
  document.querySelector(".ckpt-q")?.remove();
  try {
    const { asked } = await api("usage/save-progress", {});
    toast(`Asked ${asked} running task${asked === 1 ? "" : "s"} to save progress. Nothing was paused.`);
  } catch (error) { toast(error.message); }
}

/* "Running in the background": each task the engine lists, named by its Trunk or conversation, with the engine's own
   words for what it is doing (for one that waits, why: its question); a spinner while it works, a clock while it waits. "Start something in the background"
   puts /bg in the message box, as the prototype does; sending it goes to the engine's /bg (chat.js, POST
   /api/commands/run). It stays greyed while the engine's command list for this window has no /bg (GET /api/commands). */
function tasksPop(bgListed) {
  const rows = ACT.list.map((a) => {
    const s = E.sessions.find((x) => (x.sessionId ?? x.id) === a.sessionId), t = E.trunks.find((x) => x.id === s?.trunkId || (x.chatSessionId && x.chatSessionId === a.sessionId));
    // A task that waits is listed with the engine's words for why: the question it asked (task.reason, Q51).
    const on = (a.task?.state ?? "working") === "working", said = (on ? "" : a.task?.reason) || a.current || a.working ||String(a.prompt ?? "").split("\n")[0];
    return `<div class="mi" role="menuitem"><span class="ico">${ic(on ? "spin" : "clock", on ? "s spin" : "s")}</span><span><span class="mi-t">${esc(t?.name || s?.opening || s?.title || "")}</span><span class="mi-s">${esc(said)}</span></span></div>`;
  }).join("");
  return `<div class="ph">Running in the background</div>${rows}<hr>${mi(bgListed ? "bg-new" : "bg-new-off", "plus", "Start something in the background", "<kbd>/bg</kbd>")}`;
}
async function openTasks(el) {
  let listed = false;
  try { listed = ((await api("commands?surface=window")).commands ?? []).some((c) => c.name === "bg"); } catch (error) { toast(error.message); }
  openPop(el, tasksPop(listed));
}
function startInBackground() {
  closePop();
  S.view = "chat";
  S.drafts[S.chat ?? "new"] = "/bg ";
  renderNow();
  const box = $("#prompt");
  box?.focus();
  box?.setSelectionRange(box.value.length, box.value.length);
}

export function initUsage() {
  markLive(["usagepop", "updmenu", "ckpt-save", "ckpt-no", "tasks10", "bg-new"]);
  on("tasks10", (el) => openTasks(el));
  on("bg-new", () => startInBackground());
  on("ckpt-save", saveProgress);
  on("ckpt-no", () => document.querySelector(".ckpt-q")?.remove());
  checkLimits();
  setInterval(checkLimits, 20000);
  on("updmenu", async (el) => openPop(el, updatePop(await api("comfort/update-plan", {}).catch(() => null)), { right: true }));
  on("usagepop", async (el) => openPop(el, popHTML(await api("usage/glance").catch(() => null)), { right: true }));
}

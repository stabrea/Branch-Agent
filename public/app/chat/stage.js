/* The full-size view of the computer or browser a conversation's task works in (design doc A.5, the prototype's stageHTML
   and renderStage7), with only what the engine really has:
   - the screen is the newest picture the conversation's tasks took: the browser's from GET /api/panels/work (its
     `browser.picture`), the computer's from the conversation's own desktop.screenshot results; each picture's bytes come
     from GET /api/artifacts/file. With no picture the prototype's own "Nothing open" is shown. A picture is not a live
     stream, so the chip says "Now", never "Live".
   - the steps are the task's plan (GET /api/runs/<id>/plan); showing the screen at an earlier step needs recorded frames
     with their pictures, which the engine does not hand the window, so those chips stay greyed.
   - Stop is POST /api/runs/<id>/cancel.
   - Take over and Hand back are the engine's only take-over: the shared Linux desktop Branch drives (GET /api/linux-desktop,
     POST /api/linux-desktop/take-over and /hand-back, each the owner's alone). Take over is drawn on the computer view only
     while that desktop runs with Branch in control; while the owner holds it, "You have control" and Hand back are drawn on
     both views, so control can always be given back. The viewer's address and password are never fetched here. Branch's
     own browser has no live hand-over, so the browser view offers no Take over.
   Which view is open, picture in picture and the side conversation are window state only. */

import { $, esc, applyCss, onRender } from "../core/dom.js";
import { ic, av, toast, app, closePop } from "../core/ui.js";
import { S, E, refresh, trunkIntro } from "../core/state.js";
import { api, token } from "../core/api.js";
import { on } from "../core/actions.js";
import { markLive, greyOut } from "../core/features.js";
import { work, loadWork } from "./terminal.js";
import { t } from "../../i18n.js";
import { pickChip } from "../flows/computers17.js"; // pass 17 part D §9: the conversation's computer menu

const G = { kind: null, pip: null, dock: true, sid: null, messages: [], plan: null, at: 0, desk: null };
const SHOT = new Map(); // picture path → its bytes as a blob: address ("" while loading or after the engine refused it)
const STOPPABLE = new Set(["running", "needs_input", "interrupted"]);

const name = () => E.state?.identity?.name ?? "";
const runsHere = () => (E.state?.runs ?? []).filter((r) => S.chat && r.sessionId === S.chat)
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
const working = () => runsHere().some((r) => r.status === "running");

function parsed(text) {
  try { return JSON.parse(text); } catch { return null; } // a result that is not JSON names no picture
}

/* The newest picture a desktop.screenshot call in this conversation kept ({ok, result: {path}} in its tool message). */
function desktopPicture() {
  const calls = new Set(G.messages.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === "desktop.screenshot").map((c) => c.id));
  const found = G.messages.filter((m) => m.role === "tool" && calls.has(m.toolCallId)).map((m) => parsed(m.content)?.result?.path).filter(Boolean);
  return found.at(-1) ?? "";
}
const picturePath = (kind) => (kind === "browser" ? work(G.sid)?.browser?.picture ?? "" : desktopPicture());
/* The page the picture was taken on: the address of the last browser.screenshot step, which took that picture. */
const pageUrl = () => work(G.sid)?.browser?.entries?.filter((e) => e.tool === "browser.screenshot" && /^https?:\/\//.test(e.what)).at(-1)?.what ?? "";

/* The picture's bytes through the artifacts route, signed like every other request. Each picture is kept under its own
   path, so one view never shows the other's picture; a picture neither view names any more is let go. */
async function fetchShot(path) {
  SHOT.set(path, "");
  try {
    const headers = token.get() ? { authorization: "Bearer " + token.get() } : {};
    const response = await fetch("/api/artifacts/file?path=" + encodeURIComponent(path), { cache: "no-store", headers });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || String(response.status));
    const url = URL.createObjectURL(await response.blob());
    if (SHOT.has(path)) SHOT.set(path, url); else URL.revokeObjectURL(url);
  } catch (error) {
    toast(error.message);
  }
  drawStage();
}
function shotUrl(path) {
  if (!path) return "";
  const wanted = new Set([picturePath("browser"), picturePath("computer")]);
  for (const [kept, url] of SHOT) if (!wanted.has(kept)) { if (url) URL.revokeObjectURL(url); SHOT.delete(kept); }
  if (!SHOT.has(path)) fetchShot(path);
  return SHOT.get(path) ?? "";
}

/* The screen: the picture as it was taken, or the prototype's own empty page. */
function screen(kind) {
  const url = shotUrl(picturePath(kind));
  if (url && kind === "computer") return `<div class="desk7"><img class="shot7" src="${esc(url)}" alt="${esc(name())}"></div>`;
  const address = kind === "browser" && url ? pageUrl() : "";
  const page = url ? `<img class="shot7" src="${esc(url)}" alt="${esc(address)}">`
    : `<div class="dk-app blank7">${ic("globe")}<b>${t("window.chat.stage.nothing-open")}</b><small>${t("window.chat.stage.no-page", { name: esc(name()) })}</small></div>`;
  const bar = address ? `<div class="dk-url">${ic("lock", "s")}${esc(address)}</div>` : "";
  return `<div class="desk7 brfull7"><div class="dk-win br7">${bar}${page}</div></div>`;
}

/* Who holds the shared Linux desktop, as the engine last said: "agent", "user" or "none". */
const holder = () => (G.desk?.running ? G.desk.control : "none");

function top(kind, steps) {
  const run = runsHere()[0], now = steps.findIndex((s) => s.status === "working"), yours = holder() === "user";
  const title = kind === "browser" ? t("window.chat.stage.browser-of", { name: esc(name()) }) : t("window.chat.stage.computer-of", { name: esc(name()) });
  const pill = yours ? `<span class="pill you"><i></i>${t("window.chat.stage.you-control")}</span>`
    : working() ? `<span class="pill work"><i></i>${t("strip.status.working")}${now >= 0 ? ` · ${t("window.chat.stage.step-of", { n: now + 1, total: steps.length })}` : ""}</span>` : `<span class="pill idle"><i></i>${t("window.chat.stage.idle")}</span>`;
  const take = kind === "computer" && holder() === "agent" ? `<button class="btn pri sm" type="button" data-act="takeover">${t("action.take-over")}</button>` : "";
  const stop = run && STOPPABLE.has(run.status) ? `<button class="btn ghost sm" type="button" data-act="stage-stop" data-id="${esc(run.id)}">${t("dashboard.stop")}</button>` : "";
  const ctl = yours ? `<button class="btn pri sm" type="button" data-act="handback">${t("window.chat.stage.hand-back-to", { name: esc(name()) })}</button>` : take + stop;
  const sw = [["computer", "monitor", t("strip.kind.computer")], ["browser", "globe", t("pane.browser")]].map(([v, i, l]) => `<button type="button" data-act="stage" data-v="${v}" aria-pressed="${kind === v}">${ic(i, "s")}${l}</button>`).join("");
  return `<div class="st7-top"><button class="st7-back" type="button" data-act="stage-close">${ic("back", "s")}${esc(name())}</button>
    <span class="st7-title"><b>${title}</b>${kind === "computer" ? pickChip(S.chat) : ""}</span>${pill}<span class="tb-grow"></span>${ctl}
    <span class="st7-sw" role="group" aria-label="${t("dashboard.filter.label")}">${sw}</span>
    <button class="icon-btn" type="button" aria-label="${t("window.chat.stage.shrink")}" data-tip="${t("window.chat.stage.pip")}" data-act="stage-pip">${ic("layers")}</button>
    <button class="icon-btn" type="button" aria-label="${G.dock ? t("window.chat.stage.hide-conversation") : t("window.chat.stage.show-conversation")}" data-tip="${G.dock ? t("window.chat.stage.full-screen") : t("window.chat.stage.show-conversation")}" data-act="stage-dock" aria-pressed="${G.dock}">${ic("panel")}</button></div>`;
}

const STEP = { done: "done", working: "now", failed: "", waiting: "" };
function dock(steps) {
  const plan = steps.length ? `<ul class="dk7-plan">${steps.map((s) => { const c = STEP[s.status] ?? ""; return `<li class="${c}">${ic(c === "done" ? "check" : c === "now" ? "spin" : "info", c === "now" ? "s spin" : "s")}${esc(s.title)}</li>`; }).join("")}</ul>` : "";
  const said = G.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content && !trunkIntro(m)).slice(-3)
    .map((m) => `<div class="dk7-m ${m.role === "user" ? "me7" : ""}">${esc(String(m.content).slice(0, 180))}</div>`).join("");
  return `<aside class="st7-dock" aria-label="${t("onscreen.group.middle")}"><div class="dk7-h">${av({ kind: "main" }, 28)}<b>${esc(name())}</b></div>${plan}<div class="dk7-msgs">${said}</div></aside>`;
}

function stageHTML(kind) {
  const steps = G.plan?.steps ?? [];
  const chips = steps.map((s, i) => `<button type="button" class="st7-chip ${STEP[s.status] ?? ""}" data-act="stage-step" data-v="${i}"><em>${i + 1}</em>${esc(s.title)}</button>`).join("");
  return `${top(kind, steps)}<div class="st7-body ${G.dock ? "" : "nodock"}"><div class="st7-wrap"><div class="st7-screen"><div class="st7-scale">${screen(kind)}</div></div></div>${G.dock ? dock(steps) : ""}</div>
    ${steps.length ? `<div class="st7-steps">${chips}<button type="button" class="st7-chip live7" data-act="stage-step" data-v="live">${t("dashboard.area.now")}</button></div>` : ""}`;
}

function pipHTML() {
  const kind = G.pip.kind;
  return `<div class="pip7-screen" data-act="stage" data-v="${kind}" role="button" aria-label="${t("window.chat.stage.full-size")}"><div class="st7-scale">${screen(kind)}</div></div><div class="pip7-bar"><span>${esc(name())}${kind === "browser" ? ` · ${t("window.chat.stage.browser-lower")}` : ""}</span><button type="button" data-act="stage" data-v="${kind}" aria-label="${t("window.chat.stage.full-size")}">${ic("up", "s")}</button><button type="button" data-act="pip-x" aria-label="${t("window.chat.stage.close-small")}">${ic("x", "s")}</button></div>`;
}

/* The screen is drawn at 1280 × 800 and scaled to fit, as the prototype's fitStage does. */
function fit(root) {
  for (const scr of root.querySelectorAll(".st7-screen,.pip7-screen")) {
    const wrap = scr.classList.contains("st7-screen") ? scr.parentElement : null;
    let w = scr.clientWidth;
    if (wrap) { w = Math.max(240, Math.min(wrap.clientWidth - 36, (wrap.clientHeight - 36) * 1.6)); scr.style.width = w + "px"; scr.style.height = w / 1.6 + "px"; }
    const s = scr.querySelector(".st7-scale");
    if (s) s.style.transform = `scale(${w / 1280})`;
  }
}

/* One region each for the full-size view and the small window, made once and removed when closed. */
function region(id, cls, show, html) {
  let el = document.getElementById(id);
  if (!show) { el?.remove(); return; }
  if (!el) { el = Object.assign(document.createElement("div"), { id, className: cls }); app()?.appendChild(el); }
  el.innerHTML = html();
  applyCss(el);
  greyOut(el);
  fit(el);
}

export function drawStage() {
  const here = S.view === "chat" && !!S.chat;
  if (G.pip && G.pip.chat !== S.chat) G.pip = null;
  if (!here) G.kind = null;
  region("stage7", "stage7", here && !!G.kind, () => stageHTML(G.kind));
  $("#stage7")?.setAttribute("role", "region");
  $("#stage7")?.setAttribute("aria-label", t("window.stage.label"));
  region("pip7", "pip7", here && !G.kind && !!G.pip, pipHTML);
  if (here && (G.kind || G.pip)) load();
}

/* The conversation's messages and its newest task's plan, read again at most every two seconds. */
async function load() {
  const sid = S.chat;
  loadWork(sid);
  if (sid === G.sid && Date.now() - G.at < 2000) return;
  G.at = Date.now();
  const newest = runsHere()[0];
  try {
    const [session, planned, desk] = await Promise.all([api(`sessions/${encodeURIComponent(sid)}`), newest ? api(`runs/${encodeURIComponent(newest.id)}/plan`) : null, api("linux-desktop")]);
    const next = { sid, messages: session?.messages ?? [], plan: planned?.plan ?? null, desk: { running: desk?.running === true, control: desk?.control }, said: "" };
    const same = JSON.stringify([G.sid, G.messages, G.plan, G.desk]) === JSON.stringify([next.sid, next.messages, next.plan, next.desk]);
    Object.assign(G, next);
    if (!same && S.chat === sid) drawStage();
  } catch (error) {
    // Said once, not again every two seconds while the engine keeps refusing for the same reason.
    if (error.message !== G.said) toast(error.message);
    G.said = error.message;
  }
}

async function stop(el) {
  try {
    await api(`runs/${encodeURIComponent(el.dataset.id)}/cancel`, {});
    G.kind = null;
    await refresh();
  } catch (error) { toast(error.message); }
  drawStage();
}

/* Take over or Hand back: the engine's answer is the desktop's state now, drawn straight away. */
async function hold(path, done) {
  try {
    const desk = await api(path, {});
    G.desk = { running: desk?.running === true, control: desk?.control };
    if (done) toast(done);
  } catch (error) { toast(error.message); }
  drawStage();
}

/* Opens the full-size view (from the side panel's Browser tab or the view's own switch). */
export function openStage(kind) {
  G.kind = kind === "browser" ? "browser" : "computer";
  G.pip = null;
  closePop();
  drawStage();
}

export function initStage() {
  markLive(["stage", "stage-close", "stage-dock", "stage-pip", "pip-x", "stage-stop", "takeover", "handback"]);
  on("stage", (el) => openStage(el.dataset.v));
  on("stage-close", () => { G.kind = null; drawStage(); });
  on("stage-pip", () => { G.pip = { kind: G.kind, chat: S.chat }; G.kind = null; drawStage(); });
  on("pip-x", () => { G.pip = null; drawStage(); });
  on("stage-dock", () => { G.dock = !G.dock; drawStage(); });
  on("stage-stop", (el) => stop(el));
  on("takeover", () => hold("linux-desktop/take-over"));
  on("handback", () => hold("linux-desktop/hand-back", t("window.chat.stage.handed-back")));
  onRender(drawStage);
  // Before the window's own Escape (which closes a menu or dialog first), as the prototype listens.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && G.kind && !document.querySelector(".dlg, .pop")) { G.kind = null; drawStage(); } }, true);
  window.addEventListener("resize", () => { for (const id of ["stage7", "pip7"]) { const el = document.getElementById(id); if (el) fit(el); } });
}

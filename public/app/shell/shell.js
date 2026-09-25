/* The frame around every view: the title bar (merged with the conversation header on wide windows, design doc 3), the
   sidebar (machine, search, Places, the conversation list, the person) and the status bar. Real data only. */

import { $, esc, paint, renderNow } from "../core/dom.js";
import { S, E, save } from "../core/state.js";
import { on } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, toast } from "../core/ui.js";
import { greyOut, markLive } from "../core/features.js";
import { head as chatHead, openConversation, startConversation } from "../chat/chat.js";
import { initExtras } from "./extras.js";
import { initUsage } from "./usage.js";
import { api } from "../core/api.js";
import { SQ, searchHTML, askEngine } from "./search.js";

const WIDE = matchMedia("(min-width: 761px)");
const PLACES = [["overview", "home", "Overview"], ["inbox", "inbox", "Inbox"], ["automations", "clock", "Automations"],
  ["library", "book", "Library"], ["team", "users", "Team"], ["customize", "sliders", "Customize"]];

const sessionId = (s) => s.sessionId ?? s.id;
const sessionTitle = (s) => s.title || s.opening || "New conversation";
const when = (t) => {
  if (!t) return "";
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { weekday: "short" });
};

function waitingCount() {
  const a = E.state?.attention;
  return (Array.isArray(a) ? a.length : a?.count ?? 0) + (E.state?.trunkWaiting?.length ?? 0);
}

function row(s) {
  const id = sessionId(s);
  const trunk = E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id);
  return `<button class="row" type="button" data-act="chat" data-id="${esc(id)}" aria-current="${S.chat === id}">
    <span class="avw">${av(trunk ?? { kind: "main" }, 40)}</span>
    <b><span class="ellip14">${esc(sessionTitle(s))}</span></b><time>${esc(when(s.updatedAt ?? s.createdAt))}</time>
    <p>${esc(s.lastMessage ?? "")}</p></button>`;
}

/* Typing in search asks the engine for words inside conversations after a short pause; the box keeps focus and caret. */
let searchTimer;
function searchInside(q) {
  clearTimeout(searchTimer);
  if (!q.trim()) return;
  searchTimer = setTimeout(async () => {
    if (!(await askEngine(q.trim()))) return;
    const box = $("#side-q"), typing = document.activeElement === box, from = box?.selectionStart, to = box?.selectionEnd;
    renderNow();
    if (typing) { const again = $("#side-q"); again?.focus(); again?.setSelectionRange(from, to); }
  }, 200);
}

function list() {
  if (SQ.q.trim()) return `<nav class="list searching9" aria-label="Conversations">${searchHTML()}</nav>`;
  const rows = E.sessions;
  const pinned = rows.filter((s) => s.pinned);
  const recent = rows.filter((s) => !s.pinned);
  return `<nav class="list" aria-label="Conversations">
    <button class="lh lh-btn" type="button" data-act="projtoggle" aria-expanded="false">${ic("chev", "s")}Projects</button>
    ${pinned.length ? `<div class="lh">Pinned</div>${pinned.map(row).join("")}` : ""}
    ${recent.length ? `<div class="lh">Recent</div>${recent.map(row).join("")}` : ""}</nav>`;
}

function side() {
  const n = waitingCount();
  const active = E.profiles?.profiles?.find((p) => p.id === E.profiles.active);
  const person = active?.name || E.profiles?.roleLabels?.owner?.label || "";
  return `<div class="resizer" data-resize="side"><i class="grip9"></i></div>
    <button class="machine" type="button" data-act="machines" data-tip="Which computer you’re talking to"><span class="mico">${ic("monitor", "s")}</span><span class="mach14"><b>This computer</b><i class="dot"></i></span>${ic("chev", "s")}</button>
    <div class="side-top"><label class="sq9">${ic("search", "s")}<input id="side-q" type="search" placeholder="Search" value="${esc(SQ.q)}" autocomplete="off" aria-label="Search chats, Trunks, messages and past sessions">${SQ.q ? `<button type="button" class="sq-x" data-act="sq-clear" aria-label="Clear the search">${ic("x", "s")}</button>` : "<kbd>Ctrl K</kbd>"}</label><button class="icon-btn" type="button" aria-label="New conversation, Trunk, room or automation" data-act="newmenu">${ic("plus")}</button></div>
    <button class="lh lh-btn places-h14" type="button" data-act="places14" aria-expanded="${!S.placesShut}">${ic("chev", "s")}Places</button>
    <div class="side-nav nav7">${PLACES.map(([v, i, l]) => `<button class="nav" type="button" data-act="view" data-v="${v}" aria-current="${S.view === v}">${ic(i)}${l}${v === "inbox" && n ? `<span class="cnt">${n}</span>` : ""}</button>`).join("")}</div>
    ${list()}
    <div class="owner-wrap"><div class="owner-row"><button class="owner" type="button" data-act="owner" aria-haspopup="menu" data-tip="Who is using Branch, look, lock"><span class="me" aria-hidden="true">${esc(person.slice(0, 1).toUpperCase())}</span><span class="who14"><b>${esc(person)}</b></span>${ic("chev", "s")}</button><button class="icon-btn" type="button" aria-label="Settings" data-act="view" data-v="settings">${ic("gear")}</button></div></div>`;
}

function titleActions() {
  const theme = document.documentElement.dataset.theme === "dark" ? "sun" : "moon";
  return `<button class="tb-btn" type="button" data-act="guide" aria-haspopup="menu">${ic("bulb", "s")}Guide</button>
    <button class="tb-btn" type="button" aria-label="Switch light or dark" data-act="theme-flip">${ic(theme, "s")}</button>
    <button class="tb-btn" type="button" aria-label="Hide the list (Ctrl+B)" data-act="side-toggle" aria-pressed="${!document.getElementById("app").classList.contains("side-hidden")}" data-tip="Hide the list · Ctrl+B">${ic("sidebar", "s")}</button>`;
}

function status() {
  const version = E.state?.version ?? "";
  const model = modelLabel();
  return `<button class="sb" type="button" data-act="machines"><span class="dot"></span>Connected · this computer</button>
    <button class="sb" type="button" data-act="gwpop" data-tip="The gateway keeps Branch running in the background"><span class="dot off"></span>Gateway</button>
    <span class="tb-grow"></span>
    ${model ? `<button class="sb usage" type="button" data-act="usagepop" data-tip="What each connection has left: 5-hour, daily and weekly limits"><span class="hide-sm">${esc(model)}</span></button>` : ""}
    ${version ? `<button class="sb hide-sm" type="button" data-act="updmenu" data-tip="Version and updates">${esc(version)}</button>` : ""}`;
}

export const modelLabel = () => { const m = E.state?.activeModel; return m ? [m.presetName || m.model, m.reasoning].filter(Boolean).join(" · ") : ""; };

export function drawShell() {
  const app = document.getElementById("app");
  const merged = WIDE.matches && S.view === "chat";
  app.dataset.surface = /Mac/.test(navigator.platform) ? "mac" : "desktop";
  app.classList.toggle("mac", app.dataset.surface === "mac");
  app.classList.toggle("places-shut14", S.placesShut);
  app.classList.toggle("merged14", merged);
  const header = app.querySelector(".titlebar");
  header.classList.toggle("merged14", merged);
  header.style.setProperty("--side-w", getComputedStyle($("#body")).getPropertyValue("--side-w") || "292px");
  const slot = header.querySelector(".tb-head14") ?? header.querySelector(".tb-grow").insertAdjacentElement("afterend", Object.assign(document.createElement("div"), { className: "tb-head14" }));
  paint(slot, merged ? chatHead() : "");
  paint($("#tbActions"), titleActions());
  paint($("#side"), side());
  paint($("#statusbar"), status());
  for (const region of [header, $("#side"), $("#statusbar")]) greyOut(region);
}

export function initShell() {
  markLive(["sq-f", "sq-clear"]);
  on("sq-f", (el) => { SQ.f = el.dataset.v; renderNow(); });
  on("sq-clear", () => { SQ.q = ""; SQ.f = "all"; renderNow(); $("#side-q")?.focus(); });
  document.addEventListener("keydown", (e) => { if (e.target.id === "side-q" && e.key === "Escape") { SQ.q = ""; e.target.blur(); renderNow(); } });
  initExtras();
  initUsage();
  markLive(["chat", "newconv", "newmenu", "places14", "owner", "themeset", "theme-flip", "side-toggle", "guide"]);
  on("chat", (el) => openConversation(el.dataset.id));
  on("newconv", () => { closePop(); startConversation(); });
  on("newmenu", (el) => openPop(el, mi("newconv", "chat", "New conversation", "<kbd>Ctrl N</kbd>") + mi("new-trunk", "plus", "New Trunk") + mi("new-room", "room", "New room") + mi("ptab", "clock", "New automation", "", 'data-place="automations" data-v="scheduled"')));
  on("places14", () => { S.placesShut = !S.placesShut; save(); renderNow(); });
  on("owner", (el) => openPop(el, ownerMenu()));
  on("themeset", (el) => setTheme(el.dataset.v === "system" ? null : el.dataset.v));
  on("theme-flip", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  on("side-toggle", () => { document.getElementById("app").classList.toggle("side-hidden"); renderNow(); });
  on("guide", (el) => openPop(el, mi("tour", "spark", "Take the tour", "2 min") + mi("whatsnew", "star", "What’s new")));
  document.addEventListener("input", (e) => { if (e.target.id === "side-q") { if (!SQ.q.trim()) SQ.f = "all"; SQ.q = e.target.value; searchInside(SQ.q); const pos = e.target.selectionStart; renderNow(); const box = $("#side-q"); box?.focus(); box?.setSelectionRange(pos, pos); } });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#side-q")?.focus(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); startConversation(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); document.getElementById("app").classList.toggle("side-hidden"); }
  });
  WIDE.addEventListener("change", () => renderNow());
}

function ownerMenu() {
  const current = document.documentElement.dataset.theme || "system";
  return `<div class="row-in"><span>Look</span><span class="seg">${[["light", "Light"], ["dark", "Dark"], ["system", "Auto"]].map(([v, l]) => `<button type="button" data-act="themeset" data-v="${v}" aria-pressed="${current === v}">${l}</button>`).join("")}</span></div><hr>
    ${mi("switchperson", "users", "Switch person")}${mi("view", "gear", "Settings", "<kbd>Ctrl ,</kbd>", 'data-v="settings"')}${mi("shortcuts", "keyboard", "Keyboard shortcuts", "<kbd>?</kbd>")}`;
}

function setTheme(value) {
  if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme;
  S.theme = value;
  save();
  closePop();
  renderNow();
}

export { toast };

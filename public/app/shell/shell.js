/* The frame around every view: the title bar (merged with the conversation header on wide windows, design doc 3), the
   sidebar (machine, search, Places, the conversation list, the person) and the status bar. Real data only. */

import { $, esc, paint, renderNow } from "../core/dom.js";
import { S, E, refresh, save, activeId, personHere } from "../core/state.js";
import { on, run } from "../core/actions.js";
import { ic, av, mi, openPop, closePop, openDlg, toast } from "../core/ui.js";
import { greyOut, markLive } from "../core/features.js";
import { head as chatHead, openConversation, startConversation } from "../chat/chat.js";
import { statusItems } from "../chat/messages.js";
import { initExtras } from "./extras.js";
import { initUsage } from "./usage.js";
import { initCelebrate } from "./celebrate.js";
import { api, link } from "../core/api.js";
import { SQ, searchHTML, askEngine, initSearch } from "./search.js";
import { loadLook, applyLook, savePrefs } from "./look.js";
import { initThemes } from "./themes.js";
import { loadDelight, drawBackground, drawPet, petHTML, pat, D } from "./scene.js";
import { initPalette } from "./palette.js";
import { ACT, working, readActivity } from "./activity.js";
import { K, loadKeys, pressed, binding, spoken } from "./keys.js";
import { M, machineName, loadMachineName } from "./machines.js";
import { chatOwner, pinChat, renameDlg } from "../flows/trunk.js";
import { unreadDot, recentClass, markAllButton, unreadItem, initUnread } from "../chat/unread.js"; // pass 17
import { initQuick, quickItem } from "../chat/quick.js";

const WIDE = matchMedia("(min-width: 761px)");
const PLACES = [["overview", "home", "Overview"], ["inbox", "inbox", "Inbox"], ["automations", "clock", "Automations"],
  ["library", "book", "Library"], ["team", "users", "Team"], ["customize", "sliders", "Customize"]];

const sessionId = (s) => s.sessionId ?? s.id;
const hidden = (part) => (E.state?.preferences?.hidden ?? []).includes(part);
/* The Trunk that answers a conversation: its own chat, or the one the conversation names. */
const trunkFor = (s) => E.trunks.find((t) => t.id === s.trunkId || t.id === s.trunk?.id || (t.chatSessionId && t.chatSessionId === sessionId(s)));
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

/* A conversation with a task still going (E.state.runs) reads Working in its row, as the conversation header does. */
const runningIn = (id) => (E.state?.runs ?? []).some((r) => r.sessionId === id && ["running", "queued"].includes(r.status));

function row(s) {
  const id = sessionId(s);
  const trunk = trunkFor(s);
  const busy = runningIn(id);
  return `<button class="row" type="button" data-act="chat" data-id="${esc(id)}" aria-current="${S.chat === id}"${busy ? ' data-running="true"' : ""}>
    <span class="avw">${av(trunk ?? { kind: "main" }, 40)}</span>
    <b><span class="ellip14">${esc(sessionTitle(s))}</span></b><time>${esc(when(s.updatedAt ?? s.createdAt))}</time>
    ${busy ? '<p class="attn">Working</p>' : `<p>${esc(s.lastMessage ?? "")}</p>`}${unreadDot(s)}</button>`;
}

/* Typing in search asks the engine for words inside conversations after a short pause; the box keeps focus and caret. */
let searchTimer;
function searchInside(q) {
  clearTimeout(searchTimer);
  if (q.trim().length < 2) return;
  searchTimer = setTimeout(async () => {
    if (!(await askEngine(q.trim()))) return;
    const box = $("#side-q"), typing = document.activeElement === box, from = box?.selectionStart, to = box?.selectionEnd;
    renderNow();
    if (typing) { const again = $("#side-q"); again?.focus(); again?.setSelectionRange(from, to); }
  }, 200);
}

/* The engine's projects (GET /api/projects), read when the fold is opened. A project's own page is not in this window yet. */
let projects = [];
const projectRows = () => projects.map((pr) => `<button class="nav" type="button" data-act="project" data-v="${esc(pr.id)}" aria-current="${S.activeProject === pr.id}">${ic("folder", "s")}${esc(pr.name)}</button>`).join("");
async function toggleProjects() {
  S.projOpen = !S.projOpen;
  const got = S.projOpen ? await api("projects").catch(() => null) : null;
  projects = got?.all ?? projects;
  S.activeProject = got?.active?.id ?? S.activeProject; // chosen in chat/messages.js (POST /api/projects/active)
  renderNow();
}

/* A row is pinned when the engine keeps its Trunk or room pinned (POST /api/trunks/<id>, /api/trunks/rooms/<id>). */
const pinnedRow = (s) => !!(s.pinned || chatOwner(sessionId(s))?.pinned);

/* The rooms this person is in (GET /api/trunks rooms) that the conversation list does not already have: for a household
   person GET /api/sessions holds only their own conversations, so their rooms get a row from here. */
function roomRows() {
  const have = new Set(E.sessions.map(sessionId));
  return E.rooms.filter((r) => r.sessionId && !have.has(r.sessionId))
    .map((r) => ({ sessionId: r.sessionId, opening: r.name, lastMessage: r.latest ?? "", updatedAt: r.at, pinned: r.pinned }));
}

function list() {
  if (SQ.q.trim()) return `<nav class="list searching9" aria-label="Conversations">${searchHTML()}</nav>`;
  const rows = [...E.sessions, ...roomRows()];
  const pinned = rows.filter(pinnedRow);
  const recent = rows.filter((s) => !pinnedRow(s));
  return `<nav class="list" aria-label="Conversations">
    ${hidden("projects") ? "" : `<button class="lh lh-btn" type="button" data-act="projtoggle" aria-expanded="${!!S.projOpen}" data-hide="projects">${ic(S.projOpen ? "down" : "chev", "s")}Projects</button>${S.projOpen ? projectRows() : ""}`}
    ${pinned.length ? `<div class="lh">Pinned</div>${pinned.map(row).join("")}` : ""}
    ${recent.length ? `<div class="lh${recentClass()}">Recent${markAllButton()}</div>${recent.map(row).join("")}` : ""}</nav>`;
}

function side() {
  const n = waitingCount();
  const person = personHere();
  return `<div class="resizer" data-resize="side"><i class="grip9"></i></div>
    <button class="machine" type="button" data-act="machines" data-tip="Which computer you’re talking to"><span class="mico">${ic("monitor", "s")}</span><span class="mach14"><b>${esc(machineName() || "This computer")}</b><i class="dot"></i></span>${ic("chev", "s")}</button>
    <div class="side-top"><label class="sq9">${ic("search", "s")}<input id="side-q" type="search" placeholder="Search" value="${esc(SQ.q)}" autocomplete="off" aria-label="Search chats, Trunks, messages and past sessions">${SQ.q ? `<button type="button" class="sq-x" data-act="sq-clear" aria-label="Clear the search">${ic("x", "s")}</button>` : binding("palette") ? `<kbd>${esc(spoken(binding("palette")))}</kbd>` : ""}</label><button class="icon-btn" type="button" aria-label="New conversation, Trunk, room or automation" data-act="newmenu">${ic("plus")}</button></div>
    <button class="lh lh-btn places-h14" type="button" data-act="places14" aria-expanded="${!S.placesShut}">${ic("chev", "s")}Places</button>
    <div class="side-nav nav7">${PLACES.map(([v, i, l]) => `<button class="nav" type="button" data-act="view" data-v="${v}" aria-current="${S.view === v}">${ic(i)}${l}${v === "inbox" && n ? `<span class="cnt">${n}</span>` : ""}</button>`).join("")}</div>
    ${list()}
    ${petHTML("side")}
    <div class="owner-wrap"><div class="owner-row"><button class="owner" type="button" data-act="owner" aria-haspopup="menu" data-tip="Who is using Branch, look, lock"><span class="me" aria-hidden="true">${esc(person.slice(0, 1).toUpperCase())}</span><span class="who14"><b>${esc(person)}</b></span>${ic("chev", "s")}</button><button class="icon-btn" type="button" aria-label="Settings" data-act="view" data-v="settings">${ic("gear")}</button></div></div>`;
}

function titleActions() {
  const theme = document.documentElement.dataset.theme === "dark" ? "sun" : "moon", keys = esc(binding("sideList"));
  return `${hidden("notes") ? "" : `<button class="tb-btn" type="button" data-act="guide" aria-haspopup="menu" data-hide="notes">${ic("bulb", "s")}Guide</button>`}
    <button class="tb-btn" type="button" aria-label="Switch light or dark" data-act="theme-flip">${ic(theme, "s")}</button>
    <button class="tb-btn" type="button" aria-label="Hide the list${keys ? ` (${keys})` : ""}" data-act="side-toggle" aria-pressed="${!document.getElementById("app").classList.contains("side-hidden")}" data-tip="Hide the list${keys ? ` · ${keys}` : ""}">${ic("sidebar", "s")}</button>`;
}

function status() {
  const version = E.state?.version ?? "";
  const model = modelLabel();
  return `<button class="sb" type="button" data-act="machines"><span class="dot ${link.up ? "" : "off"}"></span>${link.up ? "Connected" : "Not connected"} · ${esc(machineName() || "this computer")}</button>
    ${hidden("gateway") ? "" : '<button class="sb" type="button" data-act="gwpop" data-hide="gateway" data-tip="The gateway keeps Branch running in the background"><span class="dot off"></span>Gateway</button>'}
    ${statusItems()}
    <button class="sb tasks10" type="button" data-act="tasks10" data-tip="What is running in the background"><i class="${working() ? "lit10" : ""}"></i>${working()} running</button>
    ${petHTML("status")}
    <span class="tb-grow"></span>
    ${model && !hidden("usage") ? `<button class="sb usage" type="button" data-act="usagepop" data-hide="usage" data-tip="What each connection has left: 5-hour, daily and weekly limits"><span class="hide-sm">${esc(model)}</span></button>` : ""}
    ${version ? `<button class="sb hide-sm" type="button" data-act="updmenu" data-tip="Version and updates">${esc(version)}</button>` : ""}`;
}

export const modelLabel = () => { const m = E.state?.activeModel; return m ? [m.presetName || m.model, m.reasoning].filter(Boolean).join(" · ") : ""; };

export function drawShell() {
  const app = document.getElementById("app");
  loadLook();
  if (!D.asked && E.loaded) loadDelight().then(() => renderNow());
  if (!K.asked && E.loaded) loadKeys().then(() => renderNow(), (error) => toast(error.message));
  if (!M.asked && E.loaded) loadMachineName().then(() => renderNow(), (error) => toast(error.message));
  readActivity();
  app.classList.toggle("no-status", hidden("statusbar"));
  $("#statusbar").dataset.hide = "statusbar";
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
  drawBackground();
  drawPet();
}

export function initShell() {
  markLive(["sq-f", "sq-clear", "projtoggle", "sw:side-q"]);
  on("projtoggle", () => toggleProjects());
  on("sq-f", (el) => { SQ.f = el.dataset.v; renderNow(); });
  on("sq-clear", () => { SQ.q = ""; SQ.f = "all"; renderNow(); $("#side-q")?.focus(); });
  document.addEventListener("keydown", (e) => { if (e.target.id === "side-q" && e.key === "Escape") { SQ.q = ""; e.target.blur(); renderNow(); } });
  initExtras();
  initUsage();
  initCelebrate();
  initSearch();
  initThemes();
  initPalette();
  initPerson();
  initUnread();
  initQuick();
  markLive(["chat", "newconv", "newmenu", "places14", "themeset", "theme-flip", "side-toggle", "guide", "focus", "new-with", "pin-id", "rename-id"]);
  // With no id (Settings' back button before any conversation is open) it just goes back to the conversation view.
  // area places: "new" is a new Trunk (flows/trunk.js).
  on("chat", (el) => { closePop(); if (el.dataset.id === "new") return run("new-trunk", el); if (el.dataset.id) openConversation(el.dataset.id); else { S.view = "chat"; renderNow(); } });
  on("newconv", () => { closePop(); startConversation(); });
  on("newmenu", (el) => openPop(el, mi("newconv", "chat", "New conversation", binding("newConversation") ? `<kbd>${esc(spoken(binding("newConversation")))}</kbd>` : "") + mi("new-trunk", "plus", "New Trunk") + mi("new-room", "room", "New room") + mi("ptab", "clock", "New automation", "", 'data-place="automations" data-v="scheduled"') + quickItem()));
  on("places14", () => { S.placesShut = !S.placesShut; save(); renderNow(); });
  on("themeset", (el) => setTheme(el.dataset.v === "system" ? null : el.dataset.v));
  on("theme-flip", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  on("side-toggle", () => { document.getElementById("app").classList.toggle("side-hidden"); renderNow(); });
  on("guide", (el) => openPop(el, mi("whatsnew13", "star", "What’s new", "this version") + '<div class="ph">New here?</div>' + mi("onboard", "spark", "Set up Branch", "3 min") + mi("tour", "help", "Take the walkthrough", "2 min")));
  on("focus", () => toggleFocus());
  on("new-with", (el) => newWith(el.dataset.id));
  document.addEventListener("input", (e) => { if (e.target.id === "side-q") { if (!SQ.q.trim()) SQ.f = "all"; SQ.q = e.target.value; searchInside(SQ.q); const pos = e.target.selectionStart; renderNow(); const box = $("#side-q"); box?.focus(); box?.setSelectionRange(pos, pos); } });
  on("pin-id", (el) => pinChat(el.dataset.id));
  on("rename-id", (el) => renameDlg(el.dataset.id));
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (pressed(e, "newConversation")) { e.preventDefault(); startConversation(); }
    if (pressed(e, "sideList")) { e.preventDefault(); document.getElementById("app").classList.toggle("side-hidden"); }
    if (mod && key === ".") { e.preventDefault(); toggleFocus(); }
  });
  document.addEventListener("contextmenu", (e) => rowMenu(e) || hideMenu(e));
  WIDE.addEventListener("change", () => renderNow());
}

/* Focus mode: the list and the status bar step aside until it is left (the button, or Ctrl+. again). */
function toggleFocus() { document.getElementById("app").classList.toggle("focus"); }

/* A row's own menu (right-click), 1:1 with the prototype's: a conversation a Trunk answers offers a new one with it.
   Pin and Rename change the Trunk or room whose own conversation the row is (flows/trunk.js); the engine keeps no pin
   or name for any other conversation, so there they stay greyed. */
function rowMenu(e) {
  const row = e.target.closest?.("#side .row[data-id]");
  if (!row) return false;
  e.preventDefault();
  const id = esc(row.dataset.id), s = E.sessions.find((x) => sessionId(x) === row.dataset.id), t = s && trunkFor(s), own = chatOwner(row.dataset.id);
  const base = mi("chat", "chat", "Open", "", `data-id="${id}"`) + unreadItem(row.dataset.id) + mi(own ? "pin-id" : "pin-id-off", "pin", own?.pinned ? "Unpin" : "Pin to top", "", `data-id="${id}"`) + mi(own ? "rename-id" : "rename-id-off", "edit", "Rename", "", `data-id="${id}"`);
  const tid = esc(t?.id ?? "");
  const trunk = t ? mi("new-with", "plus", `New conversation with ${esc(t.name)}`, "", `data-id="${tid}"`) + mi("pausetrunk", "pause", "Pause", "", `data-id="${tid}"`) + mi("edit", "sliders", "Edit Trunk…", "", `data-id="${tid}"`) + "<hr>" + mi("remove", "trash", "Remove…", "", `data-id="${tid}"`) : "";
  openPop(row, base + trunk, { force: true });
  return true;
}
/* A new conversation answered by that Trunk (POST /api/trunks/conversations). */
async function newWith(trunkId) {
  closePop();
  try {
    const made = await api("trunks/conversations", { trunkId });
    await refresh();
    await openConversation(made.sessionId);
  } catch (error) { toast(error.message); }
}

/* Right-clicking a part of the window offers to hide it, when the engine's "right-click to hide" switch is on. */
function hideMenu(e) {
  const part = e.target.closest?.("[data-hide]");
  if (!part || !E.state?.preferences?.rightClickHide) return;
  e.preventDefault();
  openPop(part, mi("hide", "eye", "Hide this", "", `data-v="${esc(part.dataset.hide)}"`) + mi("setgo", "sliders", "Choose what’s shown…", "", 'data-v="appearance"'), { force: true });
}
async function hidePart(v) {
  closePop();
  const now = E.state?.preferences?.hidden ?? [];
  if (!now.includes(v)) await savePrefs({ hidden: [...now, v] });
  await refresh().catch((error) => toast(error.message));
  toast("Hidden. Bring it back in Settings › Appearance.");
}

/* ---------- the person menu ---------- */
function people() {
  const owner = E.profiles?.roleLabels?.owner?.label || "";
  const all = [[null, owner], ...(E.profiles?.profiles ?? []).map((p) => [p.id, p.name])];
  return all.map(([id, name]) => `<button type="button" data-act="switchto" data-v="${esc(id ?? "")}" data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px;border-radius:10px;${activeId() === id ? "background:var(--fill-2)" : ""}"><span class="me">${esc(String(name ?? "").slice(0, 1).toUpperCase())}</span>${esc(name)}</button>`).join("");
}
function ownerMenu() {
  const current = document.documentElement.dataset.theme || "system", earned = D.earned;
  return `<div class="ph">Who is using Branch</div><div data-css="display:flex;gap:8px;padding:4px 10px 8px;flex-wrap:wrap">${people()}<button type="button" data-act="invite" data-css="display:grid;justify-items:center;gap:3px;font-size:11.5px;padding:4px"><span class="me" data-css="background:var(--fill);color:var(--ink-2)">+</span>Add</button></div><hr>
    <div class="row-in"><span>Look</span><span class="seg">${[["light", "Light"], ["dark", "Dark"], ["system", "Auto"]].map(([v, l]) => `<button type="button" data-act="themeset" data-v="${v}" aria-pressed="${current === v}">${l}</button>`).join("")}</span></div><hr>
    ${mi("view", "gear", "Settings", binding("appearance") ? `<kbd>${esc(spoken(binding("appearance")))}</kbd>` : "", 'data-v="settings"')}${mi("setgo", "medal", "Achievements", earned == null ? "" : esc(String(earned)), 'data-v="achievements"')}${mi("shortcuts", "keyboard", "Keyboard shortcuts", "<kbd>?</kbd>")}${mi("help", "bulb", "Guide: why each thing is here")}${mi("firstrun", "spark", "Replay the first run")}${mi("about", "info", "About Branch")}<hr>${mi("lockscreen", "lock", "Lock Branch")}`;
}
/* About Branch: the engine's version, and which kind of computer this is, from the browser. */
function about() {
  closePop();
  const os = /Mac/.test(navigator.platform) ? "Mac" : /Win/.test(navigator.platform) ? "Windows" : "";
  openDlg({ title: "About Branch", body: `<div data-css="display:flex;gap:16px;align-items:center"><span class="mark mark-full" data-css="width:84px;height:84px" aria-hidden="true"></span><div><b>Branch Agent ${esc(E.state?.version ?? "")}</b><p class="hint" data-css="margin:2px 0 0">By KeepOak${os ? " · " + os : ""}</p></div></div>` });
}
function initPerson() {
  markLive(["owner", "help", "about", "hide", "pat"]);
  on("pat", () => pat());
  document.addEventListener("keydown", (e) => { if (e.target.id === "pet-cv" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pat(); } });
  on("owner", (el) => openPop(el, ownerMenu()));
  on("help", () => { closePop(); run("tour"); });
  on("about", () => about());
  on("hide", (el) => hidePart(el.dataset.v));
}

/* The look applies at once and is kept by the engine too (its words: daylight is light, forest is dark). */
function setTheme(value) {
  if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme;
  S.theme = value;
  save();
  applyLook();
  savePrefs({ followSystem: !value, ...(value ? { appearance: value === "light" ? "daylight" : "forest" } : {}) }).then(() => renderNow());
  closePop();
  renderNow();
}

export { toast };

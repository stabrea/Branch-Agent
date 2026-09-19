/* Redesign phase 2 (panels): the side panel's Browser and Terminal tabs, and panes you can resize.

   Browser and Terminal show what the assistant really did in the conversation you are reading: the web
   pages it opened and the commands it ran, with what came back, from GET /api/panels/work (the owner's
   alone; src/panels-work.ts). Nothing here runs a command or opens a page.

   The side list and the side panel can be dragged wider or narrower, as in the Claude desktop app:
   drag the edge, double-click it to go back to normal, or focus it and use the arrow keys (Enter folds it).
   Ctrl+B (Cmd+B on a Mac) folds the side list. Widths are kept in this browser only. */
import { api, displayView } from "/app.js";
import { t, formatDate } from "/i18n.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (whole, name) => (values && name in values ? String(values[name]) : whole)) : word;
};
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* a private window forgets */ } },
};

/* ---------- Browser and Terminal ---------- */
const STATES = {
  running: ["panels.state.running", "Working now", "live"], done: ["panels.state.done", "Done", "ok"],
  failed: ["panels.state.failed", "Did not work", "bad"], stopped: ["panels.state.stopped", "Stopped", "idle"],
  practice: ["panels.state.practice", "Practice only", "idle"], refused: ["panels.state.refused", "Refused", "bad"],
  waiting: ["panels.state.waiting", "Waiting for your yes", "warn"],
};
const TABS = {
  browser: { empty: ["panels.browser.empty", "Nothing here yet in this conversation. When the assistant opens a web page, the page and what it did there show here."],
    lock: ["panels.browser.lock", "Lockdown is on: acting on a web page asks you first."],
    link: ["panels.browser.settings", "Browser settings", "settings:computer"] },
  terminal: { empty: ["panels.terminal.empty", "Nothing here yet in this conversation. Commands the assistant runs, and what they printed, show here."],
    lock: ["panels.terminal.lock", "Lockdown is on: commands are refused without asking."],
    link: ["panels.terminal.settings", "When it asks before a command", "settings:permissions"] },
};
const blocks = {};
function buildBlocks() {
  const panel = $("context-panel");
  const before = panel.querySelector(".acorn-art");
  for (const tab of Object.keys(TABS)) {
    const block = make("div", "context-block panels-work");
    block.id = `panels-${tab}`;
    block.dataset.pane = tab;
    block.setAttribute("aria-live", "polite");
    panel.insertBefore(block, before);
    blocks[tab] = block;
  }
}
const sessionNow = () => globalThis.branchSessionId?.() || $("conversation")?.dataset.sessionId || "";
const shownTab = () => {
  const tab = $("context-panel")?.dataset.pane;
  return document.body.classList.contains("lx-aside") && !document.body.classList.contains("lx-help") && TABS[tab] ? tab : null;
};
const ownerHere = () => root.dataset.household !== "on";

function chip(state) {
  const [key, english, tone] = STATES[state] ?? STATES.done;
  const node = make("span", `panels-chip panels-chip-${tone}`, say(key, english));
  return node;
}
function entryRow(tab, entry) {
  const row = make("div", "panels-entry");
  row.dataset.state = entry.state;
  const head = make("div", "panels-entry-head");
  const what = make("code", "panels-what", (tab === "terminal" ? "$ " : "") + (entry.what || entry.tool));
  what.title = entry.what || entry.tool;
  head.append(what, chip(entry.state));
  row.append(head);
  if (entry.output) row.append(make("pre", "panels-out", entry.output));
  row.append(make("span", "panels-when", formatDate(entry.at, { timeStyle: "short" })));
  return row;
}
/* The browser's last picture comes through the artifacts route, which needs the window's key. */
let pictureShown = { path: "", url: "" };
async function picture(path) {
  if (pictureShown.path === path) return pictureShown.url;
  const response = await fetch(`/api/artifacts/file?path=${encodeURIComponent(path)}`, {
    headers: { authorization: "Bearer " + (sessionStorage.getItem("branch-token") || "") },
  });
  if (!response.ok) return "";
  /* A data: address, because the page's own security rules allow pictures from here or data: only. */
  const blob = await response.blob();
  const url = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
  pictureShown = { path, url };
  return url;
}
async function pictureNode(path) {
  const url = path ? await picture(path).catch(() => "") : "";
  if (!url) return null;
  const figure = make("figure", "panels-picture");
  const img = make("img");
  img.src = url;
  img.alt = say("panels.browser.pictureAlt", "The last picture the assistant took of the page");
  figure.append(img, make("figcaption", "", say("panels.browser.picture", "The last picture it took of the page")));
  return figure;
}
function footOf(tab) {
  const spec = TABS[tab];
  const nodes = [];
  if (document.body.classList.contains("lx-locked")) nodes.push(make("p", "panels-lock", say(spec.lock[0], spec.lock[1])));
  const link = make("button", "context-link panels-link", say(spec.link[0], spec.link[1]));
  link.type = "button";
  link.addEventListener("click", () => displayView(spec.link[2]));
  nodes.push(link);
  return nodes;
}
function statusLine(tab, work, entries) {
  const live = entries.some((entry) => entry.state === "running");
  const words = live
    ? (tab === "browser" ? say("panels.browser.using", "The assistant is using the browser now") : say("panels.terminal.using", "A command is running now"))
    : work.running ? say("panels.working", "The assistant is working on this conversation") : "";
  if (!words) return null;
  const line = make("p", "panels-status", words);
  line.prepend(make("span", "panels-dot"));
  return line;
}
/* Drawn again only when something changed, so reading or selecting a printout is never interrupted. */
const drawn = {};
async function draw(tab, work) {
  const block = blocks[tab];
  const signature = JSON.stringify([sessionNow(), work, document.body.classList.contains("lx-locked")]);
  if (drawn[tab] === signature) return;
  drawn[tab] = signature;
  const entries = work ? work[tab].entries : [];
  const nodes = [];
  if (!sessionNow()) nodes.push(make("p", "context-empty", say("panels.noConversation", "Open a conversation to see what the assistant did in it.")));
  else if (!work) nodes.push(make("p", "context-empty", say("panels.unavailable", "This could not be read just now.")));
  else {
    const status = statusLine(tab, work, entries);
    if (status) nodes.push(status);
    if (tab === "browser") { const shot = await pictureNode(work.browser.picture); if (shot) nodes.push(shot); }
    if (entries.length) nodes.push(...[...entries].reverse().map((entry) => entryRow(tab, entry)));
    else nodes.push(make("p", "context-empty", say(TABS[tab].empty[0], TABS[tab].empty[1])));
  }
  block.replaceChildren(...nodes, ...footOf(tab));
  markLive(work);
}
/* A small dot on a tab while the assistant is using the browser, or a command is running. */
function markLive(work) {
  for (const tab of Object.keys(TABS)) {
    const trigger = document.querySelector(`.lx-pane-tab[data-pane="${tab}"]`);
    trigger?.classList.toggle("panels-live", Boolean(work?.[tab].entries.some((entry) => entry.state === "running")));
  }
}
let busy = false;
async function refresh() {
  const tab = shownTab();
  if (!tab || busy || document.hidden || !ownerHere()) return;
  busy = true;
  try {
    const session = sessionNow();
    const work = session ? await api(`panels/work?session=${encodeURIComponent(session)}`).catch(() => null) : null;
    await draw(tab, work);
  } finally {
    busy = false;
  }
}
function watchTabs() {
  const again = () => void refresh();
  new MutationObserver(again).observe($("context-panel"), { attributes: true, attributeFilter: ["data-pane"] });
  new MutationObserver(again).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(again).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
  document.addEventListener("branch-pane-draw", again);
  setInterval(again, 3000);
}

/* ---------- panes you can resize ---------- */
const WIDTHS = "branch-pane-widths";
const RZ = {
  rail: { v: "--rail-w", min: 200, max: 440, snap: 150, label: ["panels.rz.rail", "Side list width"], toggle: "rail-toggle", fold: "no-rail", wide: 861 },
  aside: { v: "--aside-w", min: 260, max: 640, snap: 200, label: ["panels.rz.aside", "Side panel width"], toggle: "aside-toggle", wide: 1181 },
};
let widths = {};
try { widths = JSON.parse(store.get(WIDTHS) || "{}") || {}; } catch { widths = {}; }
const keys = () => (mac ? "Cmd+B" : "Ctrl+B");
const tip = () => say("panels.rz.tip", "Drag to resize · Double-click to reset · {keys} hides the side list", { keys: keys() });
const widthOf = (k) => widths[k] ?? (parseFloat(getComputedStyle(root).getPropertyValue(RZ[k].v)) || 280);
function applyWidths() {
  for (const k of Object.keys(RZ)) {
    if (widths[k] != null) root.style.setProperty(RZ[k].v, `${widths[k]}px`);
    else root.style.removeProperty(RZ[k].v);
  }
  placeHandles();
}
function setWidth(k, px, save = true) {
  const c = RZ[k];
  widths[k] = Math.round(Math.max(c.min, Math.min(c.max, px)));
  applyWidths();
  if (save) store.set(WIDTHS, JSON.stringify(widths));
}
function resetWidth(k) {
  delete widths[k];
  store.set(WIDTHS, Object.keys(widths).length ? JSON.stringify(widths) : null);
  applyWidths();
}
const paneEl = (k) => (k === "rail" ? $("conversation-rail") : $("context-panel"));
/** Open as a column (not folded, not floating over the conversation, not the calm window's hidden pane). */
function columnOpen(k) {
  if (innerWidth < RZ[k].wide) return false;
  const pane = paneEl(k);
  if (!pane || pane.offsetParent === null || !pane.getBoundingClientRect().width) return false;
  return k === "rail" ? !document.body.classList.contains("no-rail") : document.body.classList.contains("lx-aside");
}
const handles = {};
function makeHandle(k) {
  const handle = make("div", "panels-rz");
  handle.dataset.rz = k;
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", String(RZ[k].min));
  handle.setAttribute("aria-valuemax", String(RZ[k].max));
  handle.addEventListener("pointerdown", (event) => startDrag(event, k));
  handle.addEventListener("dblclick", () => { resetWidth(k); globalThis.toast?.(say("panels.rz.reset", "{name} is back to normal.", { name: say(...RZ[k].label) })); });
  handle.addEventListener("keydown", (event) => keyOnHandle(event, k));
  document.body.append(handle);
  handles[k] = handle;
}
function placeHandles() {
  for (const k of Object.keys(handles)) {
    const handle = handles[k], open = columnOpen(k);
    handle.hidden = !open;
    if (!open) continue;
    const box = paneEl(k).getBoundingClientRect();
    handle.style.left = `${Math.round(k === "rail" ? box.right : box.left) - 5}px`;
    handle.style.top = `${Math.round(box.top)}px`;
    handle.style.height = `${Math.round(box.height)}px`;
    const label = say(...RZ[k].label);
    handle.setAttribute("aria-label", `${label}. ${tip()}`);
    handle.title = tip();
    handle.setAttribute("aria-valuenow", String(Math.round(box.width)));
  }
}
let drag = null;
function startDrag(event, k) {
  if (event.button) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag = { k, x: event.clientX, w: paneEl(k).getBoundingClientRect().width, handle: event.currentTarget };
  root.classList.add("panels-resizing");
}
function moveDrag(event) {
  if (!drag) return;
  const { k, x, w } = drag, dx = event.clientX - x, want = k === "aside" ? w - dx : w + dx;
  drag.fold = want < RZ[k].snap;
  drag.handle.classList.toggle("panels-will-fold", drag.fold);
  if (!drag.fold) setWidth(k, want, false);
}
function endDrag() {
  if (!drag) return;
  const { k, fold, handle } = drag;
  drag = null;
  root.classList.remove("panels-resizing");
  handle.classList.remove("panels-will-fold");
  if (fold) return foldPane(k);
  store.set(WIDTHS, JSON.stringify(widths));
}
function foldPane(k) {
  $(RZ[k].toggle)?.click();
  globalThis.toast?.(k === "rail" ? say("panels.rz.railFolded", "Side list hidden. {keys} brings it back.", { keys: keys() })
    : say("panels.rz.asideFolded", "Side panel closed. The panel button opens it again."));
}
function keyOnHandle(event, k) {
  const step = event.shiftKey ? 48 : 16, dir = k === "aside" ? -1 : 1;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    setWidth(k, widthOf(k) + (event.key === "ArrowRight" ? step : -step) * dir);
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    setWidth(k, event.key === "Home" ? RZ[k].min : RZ[k].max);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    foldPane(k);
  }
}
/* Ctrl+B (Cmd+B on a Mac, where Ctrl+B moves the cursor in a text box) folds the side list, as in Claude. */
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
function onKey(event) {
  const chord = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!chord || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
  if (event.target?.closest?.("[contenteditable]:not([contenteditable=false])")) return;
  const toggle = $("rail-toggle");
  if (!toggle || $("workspace")?.hidden) return;
  event.preventDefault();
  toggle.click();
}
function watchPanes() {
  for (const k of Object.keys(RZ)) makeHandle(k);
  document.addEventListener("pointermove", moveDrag);
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", onKey);
  const again = () => requestAnimationFrame(placeHandles);
  const sizes = new ResizeObserver(again);
  for (const k of Object.keys(RZ)) if (paneEl(k)) sizes.observe(paneEl(k));
  new MutationObserver(again).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(again).observe(root, { attributes: true, attributeFilter: ["data-everything", "data-quiet"] });
  addEventListener("resize", again);
  document.addEventListener("transitionend", again);
  const railToggle = $("rail-toggle");
  if (railToggle) railToggle.title = say("panels.railToggle", "Hide or show the side list ({keys})", { keys: keys() });
  applyWidths();
}

function start() {
  if (!$("context-panel") || !$("conversation-rail")) return;
  buildBlocks();
  watchTabs();
  watchPanes();
  globalThis.branchPanels = { refresh, widths: () => ({ ...widths }), resetWidth };
}
if (document.body.classList.contains("lx-ready")) start();
else {
  const wait = new MutationObserver(() => {
    if (!document.body.classList.contains("lx-ready")) return;
    wait.disconnect();
    start();
  });
  wait.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

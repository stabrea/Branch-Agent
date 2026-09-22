/* phase2/shell: the Trunks strip (critiques #7, #8, #9), after the KeepOak portal's rail.

   A narrow strip at the left edge (at the foot on a phone): Branch's mark (the Overview of this
   computer), this computer, your other computers (Settings › Devices), your Trunks, each with its own
   face and a ring that says how it is (green: fine, amber: it needs you, grey: off), then + to add a
   Trunk or pair a computer, and "Who is using Branch" at the foot. Right-click, a long press or the
   small ⋯ opens Branch's own menu for that face, never the browser's.

   Shown while Settings' "Trunks strip" is on (it ships on, a layout the owner asked for; off gives
   the 0.18 window back). A household person sees this computer and the people, nothing of the
   owner's. Words have data-t keys in public/locales; no colour is written here. */
import { api, displayView, openConversation, ownerAtWindow, toast } from "/app.js";
import { t } from "/i18n.js";
import { closePopovers, trackPopover } from "/popover.js";
import { computerSpec, face, repaintPatterns, trunkSpec } from "/faces.js";

const $ = (id) => document.getElementById(id);
export const say = (key, english, values) => {
  const word = t(key, values);
  return word === key ? english.replace(/\{(\w+)\}/g, (w, n) => (values && n in values ? String(values[n]) : w)) : word;
};
export function make(tag, className, key, english, values) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (key && values) { node.dataset.tTemplate = key; node.textContent = say(key, english, values); }
  else if (key) { node.dataset.t = key; node.textContent = say(key, english); }
  return node;
}
const ICONS = {
  users: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20a6 6 0 0112 0M16 11a3 3 0 100-6M21 20a6 6 0 00-4-5.6",
  plus: "M12 5v14M5 12h14", dots: "M5 12h.01M12 12h.01M19 12h.01", close: "M6 6l12 12M18 6 6 18",
  back: "M15 6l-6 6 6 6", check: "M5 12l5 5 9-10", copy: "M8 8h11v11H8zM5 16V5h11",
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("strip-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/* ---------- what the strip knows ---------- */
export const shell = {
  look: { strip: "on", faces3d: "off" }, profiles: null, roster: null, devices: null, join: null,
  /** What the Overview is about: "here", "device:<id>" or "trunk:<id>". */
  target: "here",
};
let profileGeneration = 0;
const PLATFORM = { darwin: ["devices.platform.darwin", "Mac computer"], linux: ["devices.platform.linux", "Linux computer"], win32: ["devices.platform.win32", "Windows computer"],
  ios: ["devices.platform.ios", "iPhone or iPad"], android: ["devices.platform.android", "Android phone"] };
export const platformWord = (platform) => say(...(PLATFORM[platform] ?? ["strip.kind.computer", "Computer"]));

export async function load(expectedGeneration = profileGeneration) {
  const look = await api("shell-look").catch(() => shell.look);
  const profiles = await api("profiles").catch(() => null);
  const owner = ownerAtWindow() && profiles?.isOwner !== false;
  const roster = owner ? await api("trunks").catch(() => null) : null;
  const devices = owner ? await api("devices").catch(() => null) : null;
  const join = owner ? await api("devices/join").catch(() => null) : null;
  if (expectedGeneration !== profileGeneration) return false;
  Object.assign(shell, { look, profiles, roster, devices, join });
  document.body.classList.toggle("faces-3d", look.faces3d === "on");
  return true;
}
export const isOwner = () => ownerAtWindow() && shell.profiles?.isOwner !== false;
export const trunksOn = () => !!shell.roster && shell.roster.modes?.trunks !== "off";
export const visibleTrunks = () => (trunksOn() ? shell.roster.trunks.filter((trunk) => !trunk.hidden) : []);
export const findTrunk = (id) => shell.roster?.trunks.find((trunk) => trunk.id === id) ?? null;
export const findDevice = (id) => shell.devices?.devices.find((device) => device.id === id) ?? null;
const trunkItem = (trunk) => ({ id: `trunk:${trunk.id}`, kind: "trunk", name: trunk.name, trunk,
  spec: trunkSpec(trunk), status: "on", working: !!trunk.working, unread: trunk.unread ?? 0 });
/** Something is waiting for the owner's yes: the Inbox counts it. */
const needsYou = () => Number($("lx-inbox-badge")?.textContent || 0) > 0 && !$("lx-inbox-badge")?.hidden;

/** Everything in the strip, in order, with its face and how it is. */
export function stripItems() {
  const here = { id: "here", kind: "computer", name: say("strip.here", "This computer"), spec: computerSpec({ id: "here", name: "here", here: true }),
    status: needsYou() ? "wait" : "on" };
  if (shell.join?.state === "waiting") here.status = "pairing";
  const devices = (shell.devices?.devices ?? []).map((device) => ({ id: `device:${device.id}`, kind: "device", name: device.name, device,
    spec: computerSpec(device), status: device.connected ? "on" : "off" }));
  // A computer or phone asking to join shows at once, its ring turning until it is let in (critique #46).
  const asking = (shell.devices?.requests ?? []).filter((request) => request.status === "waiting").map((request) => ({ id: `asking:${request.id}`,
    kind: "asking", name: request.name, request, spec: computerSpec({ id: request.id, name: request.name, platform: request.platform }), status: "pairing" }));
  const trunks = visibleTrunks().map(trunkItem);
  return { computers: [here, ...devices, ...asking], trunks };
}
function statusWords(item) {
  if (item.status === "pairing") return item.kind === "asking" ? say("strip.status.asking", "Asking to join") : say("strip.status.joining", "Joining another Branch");
  if (item.kind === "trunk") return item.working ? say("strip.status.working", "Working") : say("strip.status.on", "Ready");
  if (item.status === "wait") return say("strip.status.wait", "Needs you");
  return item.status === "on" ? say("strip.status.online", "Online") : say("strip.status.off", "Off");
}
function kindWords(item) {
  if (item.kind === "trunk") return say("strip.kind.trunk", "Trunk");
  const platform = item.device?.platform ?? item.request?.platform;
  return platform ? platformWord(platform) : say("strip.kind.here", "the computer you are on");
}

/* ---------- which face is picked ---------- */
function currentSession() { return $("conversation")?.dataset.sessionId || ""; }
let assignedTrunk = "";
function selectedId() {
  const overview = !$("overview")?.hidden;
  if (overview) return shell.target;
  const session = currentSession();
  const trunk = session && shell.roster?.trunks.find((entry) => entry.chatSessionId === session || entry.id === assignedTrunk);
  return trunk ? `trunk:${trunk.id}` : "here";
}
function markSelected() {
  const picked = selectedId(), { computers, trunks } = stripItems(), items = [...computers, ...trunks];
  for (const node of document.querySelectorAll("#trunk-strip .strip-item"))
    node.setAttribute("aria-current", String(node.dataset.stripId === picked));
  const selectedTrunk = picked.startsWith("trunk:") ? findTrunk(picked.slice("trunk:".length)) : null;
  const item = items.find((entry) => entry.id === picked) ?? (selectedTrunk ? trunkItem(selectedTrunk) : computers[0]);
  if (item) document.dispatchEvent(new CustomEvent("branch-strip-selection", {
    detail: { id: item.id, name: item.name, kind: kindWords(item), status: statusWords(item) },
  }));
}

/* ---------- drawing ---------- */
function stripFace(item, owner) {
  const wrap = make("div", "strip-item");
  wrap.dataset.stripId = item.id;
  wrap.setAttribute("role", "listitem");
  const pick = make("button", "strip-face");
  pick.type = "button";
  pick.setAttribute("aria-label", `${item.name}, ${kindWords(item)}, ${statusWords(item)}`);
  pick.append(face(item.spec, 40, { status: item.status, working: item.working, ground: "strip" }));
  pick.addEventListener("click", () => void choose(item));
  wrap.append(pick);
  if (item.unread) {
    const badge = make("span", "strip-badge");
    badge.textContent = item.unread > 9 ? "9+" : String(item.unread);
    badge.setAttribute("aria-label", say("trunks.unread", "{n} unread", { n: item.unread }));
    wrap.append(badge);
  }
  if (owner && item.kind !== "asking") {
    const more = make("button", "strip-more");
    more.type = "button";
    more.setAttribute("aria-label", say("strip.change", "Change {name}", { name: item.name }));
    more.setAttribute("aria-haspopup", "menu");
    more.append(icon("dots"));
    more.addEventListener("click", (event) => { event.stopPropagation(); openMenu(more, item); });
    wrap.append(more);
    if (item.kind === "trunk") wrap.draggable = true;
  }
  return wrap;
}
function brand() {
  const node = make("button", "strip-brand");
  node.type = "button";
  node.setAttribute("aria-label", say("strip.overview", "Overview of this computer"));
  // Branch Agent's own face, the mascot, on every theme.
  const img = document.createElement("img");
  img.className = "mascot-mark";
  img.alt = "";
  img.src = "/assets/mascot-128.png";
  node.append(img);
  node.addEventListener("click", () => showOverview("here"));
  return node;
}
function addButton() {
  const node = make("button", "strip-add");
  node.type = "button";
  node.setAttribute("aria-label", say("strip.add", "Add a Trunk or pair a computer"));
  node.append(icon("plus"));
  node.addEventListener("click", () => void import("/studio.js").then((studio) => studio.openAdd("trunk")));
  return node;
}
function peopleButton() {
  const node = make("button", "strip-people");
  node.type = "button";
  node.id = "strip-people";
  node.setAttribute("aria-label", say("strip.who", "Who is using Branch"));
  node.setAttribute("aria-haspopup", "menu");
  node.append(icon("users"));
  node.addEventListener("click", (event) => { event.stopPropagation(); void import("/people-place.js").then((people) => people.whoMenu(node)); });
  return node;
}
const separator = () => make("span", "strip-sep");

/** Which control in the strip has the keyboard, so a redraw can give it back. */
function focusedInStrip() {
  const node = document.activeElement;
  if (!node || !$("trunk-strip")?.contains(node)) return null;
  const id = node.closest("[data-strip-id]")?.dataset.stripId;
  return id ? `[data-strip-id="${id}"] .${node.classList[0]}` : `.${node.classList[0]}`;
}
/** The window takes the strip's room once, as it opens, rather than moving under the person later. */
const REMEMBERED = "branch-strip";
function remembered() { try { return localStorage.getItem(REMEMBERED) !== "off"; } catch { return true; } }
function remember(on) { try { localStorage.setItem(REMEMBERED, on ? "on" : "off"); } catch { /* a private window forgets */ } }
function reserveRoom() {
  // Integration review: until the server answers, the window draws what it last knew, so a strip switched
  // off does not flash on when something (a change of language) redraws it before the first answer.
  if (!remembered()) { shell.look.strip = "off"; return; }
  if ($("trunk-strip")) return;
  document.body.classList.add("lx-strip");
  const nav = make("nav", "strip");
  nav.id = "trunk-strip";
  document.body.append(nav);
}
export function drawStrip() {
  const focused = focusedInStrip();
  const on = shell.look.strip !== "off";
  remember(on);
  document.body.classList.toggle("lx-strip", on);
  let nav = $("trunk-strip");
  if (!on) { nav?.remove(); markSelected(); return; }
  if (!nav) {
    nav = make("nav", "strip");
    nav.id = "trunk-strip";
    document.body.append(nav);
  }
  nav.setAttribute("aria-label", say("strip.label", "Your computers and Trunks"));
  const owner = isOwner(), { computers, trunks } = stripItems();
  const list = make("div", "strip-scroll");
  list.setAttribute("role", "list");
  list.append(...computers.map((item) => stripFace(item, owner)));
  if (trunks.length) list.append(separator(), ...trunks.map((item) => stripFace(item, owner)));
  if (owner) list.append(addButton());
  nav.replaceChildren(brand(), separator(), list, peopleButton());
  markSelected();
  // A person moving through the strip with the keyboard keeps their place across a redraw.
  if (focused) nav.querySelector(focused)?.focus({ preventScroll: true });
}

/* ---------- going somewhere ---------- */
async function choose(item) {
  if (item.kind === "asking") return void import("/studio.js").then((studio) => studio.openLetIn(item.request));
  if (item.kind === "trunk") return openTrunk(item.trunk);
  if (item.kind === "device") return showOverview(item.id);
  const wasTrunk = selectedId().startsWith("trunk:");
  displayView("chat");
  if (wasTrunk) $("new-session")?.click();
  markSelected();
}
export async function openTrunk(trunk) {
  displayView("chat");
  await openConversation(trunk.chatSessionId);
  await api(`trunks/${trunk.id}/seen`, {}).catch(() => undefined);
  markSelected();
}
export function showOverview(target) {
  shell.target = target;
  displayView("overview:here");
  document.dispatchEvent(new CustomEvent("branch-overview", { detail: { target } }));
  markSelected();
}

/* ---------- Branch's own menu for a face ---------- */
let menuEntry = null;
function menuRow(key, english, action, values) {
  const row = make("button", "glass-option strip-option", key, english, values);
  row.type = "button";
  row.setAttribute("role", "menuitem");
  row.addEventListener("click", () => { menuEntry?.close(); void Promise.resolve(action()).catch((error) => toast(error.message ?? String(error))); });
  return row;
}
const menuGap = () => Object.assign(make("div", "strip-menu-gap"), { role: "separator" });
async function studio() { return import("/studio.js"); }
function trunkRows(item) {
  const trunk = item.trunk, rows = [
    menuRow("strip.menu.look", "Change look…", async () => (await studio()).openEdit(trunk.id)),
    menuRow("strip.menu.rename", "Rename…", async () => (await studio()).openEdit(trunk.id, { rename: true })),
    menuRow("strip.menu.settings", "Settings for this Trunk", () => trunkSettings(trunk.id)),
    menuRow("strip.menu.overview", "Overview", () => showOverview(item.id)),
    menuGap(),
    menuRow(trunk.pinned ? "strip.menu.unpin" : "strip.menu.pin", trunk.pinned ? "Unpin from the top" : "Pin to the top", () => changeTrunk(trunk.id, { pinned: !trunk.pinned })),
    menuRow("strip.menu.up", "Move up", () => moveTrunk(trunk.id, -1)),
    menuRow("strip.menu.down", "Move down", () => moveTrunk(trunk.id, 1)),
    menuRow("strip.menu.hide", "Hide from the strip and sidebar", () => hideTrunk(trunk)),
    menuGap(),
    menuRow("strip.menu.remove", "Remove…", async () => (await studio()).confirmRemoveTrunk(trunk)),
  ];
  return rows;
}
function computerRows(item) {
  if (!item.device) return [menuRow("strip.menu.overview", "Overview", () => showOverview("here")), menuRow("strip.menu.devices", "Your devices", () => displayView("customize:channels"))];
  const device = item.device;
  return [
    menuRow("strip.menu.overview", "Overview", () => showOverview(item.id)),
    menuRow("strip.menu.rename", "Rename…", async () => (await studio()).renameDevice(device)),
    menuGap(),
    menuRow("strip.menu.removeDevice", "Remove this computer…", async () => (await studio()).confirmRemoveDevice(device)),
  ];
}
export function openMenu(anchor, item) {
  closePopovers();
  $("strip-menu")?.remove();
  const menu = make("div", "glass-list strip-menu");
  menu.id = "strip-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", item.name);
  const head = make("p", "glass-group-label");
  head.textContent = item.name;
  menu.append(head, ...(item.kind === "trunk" ? trunkRows(item) : computerRows(item)));
  document.body.append(menu);
  place(menu, anchor.getBoundingClientRect());
  menuEntry = trackPopover(anchor, menu, () => menu.remove());
  menu.addEventListener("keydown", (event) => moveInMenu(event, menu));
  menu.querySelector(".glass-option")?.focus();
}
/** Beside the face on a wide window, above it when the strip is at the foot. */
function place(menu, box) {
  const width = menu.offsetWidth, height = menu.offsetHeight;
  const beside = box.right + 8 + width < innerWidth;
  const left = beside ? box.right + 8 : Math.max(6, Math.min(innerWidth - width - 6, box.left));
  const top = beside ? Math.min(innerHeight - height - 6, box.top) : Math.max(6, box.top - height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(6, top)}px`;
}
function moveInMenu(event, menu) {
  const rows = [...menu.querySelectorAll(".glass-option")];
  const at = rows.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  rows[(to + rows.length) % rows.length]?.focus();
}

/* ---------- changing a Trunk from the menu ---------- */
async function changeTrunk(id, change, words) {
  await api(`trunks/${id}`, change);
  if (words) toast(words);
  await refresh();
}
/** Integration review: hiding is one click, so the notice carries an Undo that shows it again. */
async function hideTrunk(trunk) {
  await changeTrunk(trunk.id, { hidden: true }, say("strip.hidden", "{name} is hidden. Find it in Customize › Specialists.", { name: trunk.name }));
  const undo = make("button", "strip-undo", "strip.undo", "Undo");
  undo.type = "button";
  undo.addEventListener("click", () => void changeTrunk(trunk.id, { hidden: false }, say("strip.shown", "{name} is back.", { name: trunk.name })).catch((error) => toast(error.message)));
  $("toast")?.append(" ", undo);
}
/** Moves a Trunk `step` places (dropped onto another face, or one up or down) and numbers the list again, so the order is kept exactly. */
export async function moveTrunk(id, step) {
  const list = visibleTrunks(), at = list.findIndex((trunk) => trunk.id === id), to = at + step;
  if (at < 0 || to < 0 || to >= list.length) return toast(step < 0 ? say("strip.first", "Already first.") : say("strip.last", "Already last."));
  if (list[at].pinned !== list[to].pinned) return toast(say("strip.pinnedApart", "Pinned Trunks stay above the others."));
  // Integration review: a drop three places down moves it there; the ones in between each step up one.
  list.splice(to, 0, ...list.splice(at, 1));
  await Promise.all(list.map((trunk, index) => (trunk.order === index * 10 ? null : api(`trunks/${trunk.id}`, { order: index * 10 }))));
  await refresh();
}
function trunkSettings(id) {
  displayView("customize:specialists");
  const open = () => document.querySelector(`li.trunk-row[data-trunk="${id}"] button[data-t="trunks.edit"]`);
  let tries = 0;
  const wait = setInterval(() => { const button = open(); if (button || ++tries > 40) { clearInterval(wait); button?.click(); } }, 100);
}

/* ---------- right-click, long press, the menu key and dragging ---------- */
function itemFor(node) {
  const id = node?.closest?.("[data-strip-id]")?.dataset.stripId;
  if (!id) return null;
  const { computers, trunks } = stripItems();
  return [...computers, ...trunks].find((item) => item.id === id) ?? null;
}
function wireGestures() {
  document.addEventListener("contextmenu", (event) => {
    const item = itemFor(event.target);
    if (!item || !isOwner() || !event.target.closest("#trunk-strip")) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(event.target.closest(".strip-item").querySelector(".strip-face"), item);
  }, true);
  let press = null;
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || !event.target.closest?.("#trunk-strip .strip-face")) return;
    const target = event.target;
    press = setTimeout(() => { press = null; const item = itemFor(target); if (item && isOwner()) openMenu(target.closest(".strip-face"), item); }, 550);
  });
  for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, () => { clearTimeout(press); press = null; });
  wireDragging();
}
function wireDragging() {
  let dragged = null;
  document.addEventListener("dragstart", (event) => {
    const node = event.target.closest?.("#trunk-strip .strip-item[draggable=true]");
    if (!node) return;
    dragged = node.dataset.stripId;
    event.dataTransfer.effectAllowed = "move";
    node.classList.add("dragging");
  });
  document.addEventListener("dragend", (event) => { event.target.closest?.(".strip-item")?.classList.remove("dragging"); dragged = null; });
  document.addEventListener("dragover", (event) => { if (dragged && event.target.closest?.("#trunk-strip .strip-item[draggable=true]")) event.preventDefault(); });
  document.addEventListener("drop", (event) => {
    const onto = event.target.closest?.("#trunk-strip .strip-item[draggable=true]")?.dataset.stripId;
    if (!dragged || !onto || onto === dragged) return;
    event.preventDefault();
    const list = visibleTrunks(), from = list.findIndex((trunk) => `trunk:${trunk.id}` === dragged), to = list.findIndex((trunk) => `trunk:${trunk.id}` === onto);
    if (from >= 0 && to >= 0) void moveTrunk(list[from].id, to - from).catch((error) => toast(error.message));
  });
}

/* ---------- keeping it current ---------- */
export async function refresh() {
  const expectedGeneration = profileGeneration;
  if (!await load(expectedGeneration)) return;
  // An open menu keeps the faces it was opened from; the next refresh draws them again.
  if (!$("strip-menu") && !$("who-menu")) drawStrip();
  document.dispatchEvent(new CustomEvent("branch-strip", { detail: { ...shell, profileGeneration } }));
}
function whenReady(work) {
  const ready = () => document.body.classList.contains("lx-ready") && $("workspace") && !$("workspace").hidden;
  if (ready()) { work(); return; }
  const watch = new MutationObserver(() => { if (!ready()) return; watch.disconnect(); work(); });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  if ($("workspace")) watch.observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
}
reserveRoom();
whenReady(() => {
  profileGeneration = Number(document.documentElement.dataset.profileGeneration || profileGeneration);
  wireGestures();
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
  document.addEventListener("branch-profile", (event) => {
    const generation = Number(event.detail?.profileGeneration);
    profileGeneration = Number.isSafeInteger(generation) ? generation : profileGeneration + 1;
    void refresh();
  });
  document.addEventListener("branch-rooms-changed", (event) => {
    assignedTrunk = String(event.detail?.trunkId ?? "");
    markSelected();
  });
  document.addEventListener("branch-language", () => {
    drawStrip();
    document.dispatchEvent(new CustomEvent("branch-strip", { detail: { ...shell, profileGeneration } }));
  });
  document.addEventListener("branch-place", markSelected);
  document.addEventListener("branch-strip-reselect", markSelected);
  if ($("conversation")) new MutationObserver(markSelected).observe($("conversation"), { attributes: true, attributeFilter: ["data-session-id"] });
  new MutationObserver(() => repaintPatterns()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
});

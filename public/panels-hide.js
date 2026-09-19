/* Redesign phase 2 (panels): What's on screen.

   Settings › Appearance › "What's on screen" lets a person hide any part of the window they do not use,
   choose how wide the conversation grows, and how see-through the message box is. Right-click › Hide this
   (with Undo) is there too once its switch is on; it starts off. Approval cards, the Lockdown banner and
   Stop while a task runs are never in the list, so they can never be hidden. With the side list hidden a
   small gear stays in the corner, so Settings is always one click away.

   Everything is kept in the preferences record (src/preferences.ts): seeThrough, conversationWidth, hidden,
   rightClickHide. */
import { changeAppearance, currentAppearance } from "/appearance.js";
import { displayView } from "/app.js";
import { t } from "/i18n.js";

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

/* [id, label key, English, selector, group]. Nothing that keeps a person safe is on this list. */
export const HIDE = [
  ["side-list", "onscreen.sideList", "The whole side list", "#conversation-rail", "frame"],
  ["title-bar", "onscreen.titleBar", "The whole title bar", "main > header", "frame"],
  ["oak", "onscreen.oak", "The oak behind the window", ".lx-wall", "frame"],
  ["new", "onscreen.new", "New conversation", "#rail-new", "side"],
  ["find", "onscreen.find", "Find anything", "#rail-find", "side"],
  ["places", "onscreen.places", "Inbox, Automations, Library and Customize", '.rail-group[data-group="sections"]', "side"],
  ["projects", "onscreen.projects", "Projects", '.rail-group[data-group="projects"]', "side"],
  ["recents", "onscreen.recents", "Recent conversations", '.rail-group[data-group="recents"]', "side"],
  ["owner", "onscreen.owner", "Your workspace row", "#owner-menu-button", "side"],
  ["maker", "onscreen.maker", "The Branch Agent by KeepOak line", ".rail-maker", "side"],
  ["page-title", "onscreen.pageTitle", "The page title", "main > header .head-title", "title"],
  ["side-toggle", "onscreen.sideToggle", "The side list button", "#rail-toggle", "title"],
  ["panel-button", "onscreen.panelButton", "The side panel button", "#aside-toggle", "title"],
  ["more", "onscreen.more", "More", "#lx-more", "title"],
  ["labels", "onscreen.labels", "Labels", "#thread-labels", "title"],
  ["clear", "onscreen.clear", "Clear the view", "#lx-clear", "title"],
  ["shield", "onscreen.shield", "The Lockdown button (the banner always stays)", "#lx-shield", "title"],
  ["connection", "onscreen.connection", "Connected", "#connection", "title"],
  ["welcome", "onscreen.welcome", "The question on a new conversation", "#chat > .welcome", "middle"],
  ["starters", "onscreen.starters", "Suggestions under the box", "#lx-starters", "middle"],
  ["suggest", "onscreen.suggest", "Suggestion bars at the top", "#suggest-bar", "middle"],
  ["messages", "onscreen.messages", "The messages (questions it asks you stay)", "#conversation", "middle"],
  ["composer", "onscreen.composer", "The message box", "#composer-dock", "box"],
  ["mode", "onscreen.mode", "How much it may do (the mode chip)", "#chat-form .mode-wrap", "box"],
  ["model", "onscreen.model", "The model chip", ".lx-model-chip", "box"],
  ["usage", "onscreen.usage", "The usage ring", "#status-bar", "box"],
  ["foot", "onscreen.foot", "The line under the box", ".composer-foot", "box"],
  ["acorn", "onscreen.acorn", "The acorn", ".acorn-art", "box"],
];
const GROUPS = [["frame", "onscreen.group.frame", "The frame"], ["side", "onscreen.group.side", "The side list"],
  ["title", "onscreen.group.title", "The title bar"], ["middle", "onscreen.group.middle", "The conversation"],
  ["box", "onscreen.group.box", "The message box and below"]];
/* Shown on the page as always there, and asserted by tests/panels.test.mjs never to be hideable. */
export const NEVER = [
  ["onscreen.never.approvals", "Questions it asks before it acts", "onscreen.never.approvalsWhy", "Branch must always be able to ask you first."],
  ["onscreen.never.lockdown", "The Lockdown banner", "onscreen.never.lockdownWhy", "You should always see that Lockdown is on."],
  ["onscreen.never.stop", "Stop, while a task runs", "onscreen.never.stopWhy", "You can always stop what it is doing."],
  ["onscreen.never.gear", "Settings", "onscreen.never.gearWhy", "With the side list hidden, a small gear stays in the corner."],
];
export const NEVER_SELECTORS = ["#lx-lockbanner", "#live-row", "#live-stop", "#live-ask-slot", "#policy-waiting", "#toast", "#lx-settings-row", "#rail-settings"];

const known = new Set(HIDE.map(([id]) => id));
const hiddenNow = () => new Set((currentAppearance().hidden ?? []).filter((id) => known.has(id)));

/* ---------- applying it ---------- */
/* The rules are in public/panels.css, keyed on <html data-hide="…">: the page's own security rules refuse
   a stylesheet written here, and tests/panels.test.mjs checks every part on the list has its rule. */
function applyHidden() {
  const hidden = hiddenNow();
  if (hidden.size) root.dataset.hide = [...hidden].sort().join(" ");
  else delete root.dataset.hide;
  floatGear(hidden.has("side-list"));
}
const GEAR = "M12 15a3 3 0 100-6 3 3 0 000 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1";
function floatGear(show) {
  const gear = $("panels-float-gear");
  if (!show || $("workspace")?.hidden) return gear?.remove();
  if (gear) return;
  const node = make("button", "panels-float-gear");
  node.id = "panels-float-gear";
  node.type = "button";
  node.setAttribute("aria-label", say("menu.settingsShort", "Settings"));
  node.title = say("onscreen.gearTip", "Settings › Appearance › What's on screen brings everything back");
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GEAR}"/></svg>`;
  node.addEventListener("click", () => openOnscreen());
  document.body.append(node);
}
function openOnscreen() {
  displayView("settings:appearance");
  requestAnimationFrame(() => $("panels-onscreen")?.scrollIntoView({ block: "start" }));
}

/* ---------- See-through, never past what keeps text readable ---------- */
const probe = make("span");
probe.hidden = true;
function rgbOf(value) {
  probe.style.color = "";
  probe.style.color = value;
  const text = getComputedStyle(probe).color;
  const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(text);
  if (srgb) return srgb.slice(1, 4).map((v) => Number(v) * 255);
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(text);
  return rgb ? rgb.slice(1, 4).map(Number) : [0, 0, 0];
}
const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const blend = (top, under, alpha) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));
/** The least fill that keeps the message box's words readable over the darkest and lightest oak. */
export function fillNeeded(surface, words, grounds, start) {
  for (let alpha = start; alpha <= 1.0001; alpha += 0.02) {
    const ok = grounds.every((ground) => {
      const behind = blend(surface, ground, alpha);
      return words.every(([colour, least]) => contrast(colour, behind) >= least);
    });
    if (ok) return Math.min(1, alpha);
  }
  return 1;
}
const solidOnly = () => matchMedia("(prefers-reduced-transparency: reduce)").matches || root.dataset.motion === "reduced";
function applySeeThrough() {
  const see = Number(currentAppearance().seeThrough ?? 30);
  const want = solidOnly() ? 1 : 1 - 0.55 * (Math.max(0, Math.min(100, see)) / 100);
  const ground = rgbOf("var(--ground)");
  const grounds = [ground, blend([255, 255, 255], ground, 0.3), blend([0, 0, 0], ground, 0.3)];
  const alpha = fillNeeded(rgbOf("var(--surface)"), [[rgbOf("var(--text)"), 4.5], [rgbOf("var(--text-3)"), 3]], grounds, want);
  const value = alpha.toFixed(2);
  if (root.style.getPropertyValue("--comp-a") !== value) root.style.setProperty("--comp-a", value);
  const note = $("panels-see-note");
  if (note) note.textContent = seeNote(want, alpha);
}
function seeNote(want, alpha) {
  if (solidOnly()) return say("onscreen.see.solid", "Your computer asks for less movement or transparency, so the box stays solid.");
  if (alpha > want + 0.01) return say("onscreen.see.floor", "This theme needs a little more fill to keep words readable, so the box stops there.");
  return say("onscreen.see.ok", "Words stay readable at this setting.");
}

/* ---------- right-click › Hide this ---------- */
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}
function onContextMenu(event) {
  if (!currentAppearance().rightClickHide || event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof Element) || target.closest("input, textarea, select, [contenteditable], #settings-window, [role=dialog], .panels-menu")) return;
  if (NEVER_SELECTORS.some((selector) => target.closest(selector))) return;
  const hit = [...HIDE].reverse().find(([id, , , selector]) => id !== "side-list" && id !== "title-bar" && target.closest(selector))
    ?? HIDE.find(([, , , selector]) => target.closest(selector));
  if (!hit) return;
  event.preventDefault();
  openMenu(hit, event.clientX, event.clientY);
}
function menuButton(key, english, act) {
  const node = make("button", "", say(key, english));
  node.type = "button";
  node.setAttribute("role", "menuitem");
  node.addEventListener("click", () => { closeMenu(); act(); });
  return node;
}
function openMenu([id, key, english], x, y) {
  closeMenu();
  menu = make("div", "panels-menu");
  menu.setAttribute("role", "menu");
  menu.append(make("p", "", say(key, english)),
    menuButton("onscreen.hideThis", "Hide this", () => setHidden(id, true)),
    menuButton("onscreen.openPage", "What's on screen…", openOnscreen));
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 6))}px`;
  menu.querySelector("button")?.focus();
}
function setHidden(id, hide, offerUndo = true) {
  const hidden = hiddenNow();
  if (hide) hidden.add(id); else hidden.delete(id);
  changeAppearance({ hidden: [...hidden] });
  if (!offerUndo) return;
  const [, key, english] = HIDE.find(([known]) => known === id) ?? [id, "", id];
  globalThis.toast?.(hide ? say("onscreen.hidden", "{name} is hidden. Settings › Appearance › What's on screen brings it back.", { name: say(key, english) })
    : say("onscreen.back", "{name} is back.", { name: say(key, english) }));
  if (!hide) return;
  const undo = make("button", "panels-undo", say("onscreen.undo", "Undo"));
  undo.type = "button";
  undo.addEventListener("click", () => { setHidden(id, false, false); $("toast").hidden = true; });
  $("toast")?.append(undo);
}

/* ---------- the card: Settings › Appearance › What's on screen ---------- */
function heading(tag, key, english, className) {
  const node = make(tag, className, say(key, english));
  node.dataset.t = key;
  return node;
}
function switchRow(id, key, english) {
  const row = make("div", "panels-row");
  const box = make("input");
  Object.assign(box, { type: "checkbox", id: `panels-show-${id}`, checked: !hiddenNow().has(id) });
  box.addEventListener("change", () => setHidden(id, !box.checked));
  const label = make("label", "", say(key, english));
  label.htmlFor = box.id;
  row.append(label, box);
  return row;
}
function neverRow([key, english, whyKey, whyEnglish]) {
  const row = make("div", "panels-row panels-locked");
  row.append(make("span", "panels-row-name", say(key, english)), make("span", "panels-why", say(whyKey, whyEnglish)));
  return row;
}
function widthRow() {
  const row = make("div", "panels-width-row");
  row.setAttribute("role", "group");
  row.setAttribute("aria-labelledby", "panels-width-label");
  for (const [value, key, english] of [["comfortable", "onscreen.width.comfortable", "Comfortable"], ["wide", "onscreen.width.wide", "Wide"], ["full", "onscreen.width.full", "Full width"]]) {
    const choice = make("button", "choice", say(key, english));
    choice.type = "button";
    choice.value = value;
    choice.addEventListener("click", () => changeAppearance({ conversationWidth: value }));
    row.append(choice);
  }
  return row;
}
function seeRow() {
  const row = make("div", "panels-see");
  row.id = "panels-see";
  const range = make("input");
  Object.assign(range, { type: "range", id: "panels-see-range", min: "0", max: "100", step: "5" });
  range.setAttribute("aria-describedby", "panels-see-note");
  range.addEventListener("input", () => changeAppearance({ seeThrough: Number(range.value) }));
  const label = heading("label", "onscreen.see", "See-through message box");
  label.htmlFor = range.id;
  const note = make("span", "field-note");
  note.id = "panels-see-note";
  row.append(label, make("span", "", say("onscreen.see.solidWord", "Solid")), range, make("span", "", say("onscreen.see.glassWord", "Glass")), note);
  return row;
}
function rightClickRow() {
  const row = make("label", "check-row");
  const box = make("input");
  Object.assign(box, { type: "checkbox", id: "panels-right-click" });
  box.addEventListener("change", () => changeAppearance({ rightClickHide: box.checked }));
  row.append(box, make("span", "", say("onscreen.rightClick", "Right-click a part of the window to hide it")));
  return row;
}
function buildCard() {
  const card = make("section", "card panels-onscreen");
  card.id = "panels-onscreen";
  card.dataset.home = "settings:appearance";
  const everything = make("button", "", say("onscreen.showAll", "Show everything again"));
  everything.type = "button";
  everything.id = "panels-show-all";
  everything.addEventListener("click", () => { changeAppearance({ hidden: [] }); globalThis.toast?.(say("onscreen.allBack", "Everything is back.")); });
  const widthLabel = heading("span", "onscreen.width", "How wide the conversation grows on a wide screen");
  widthLabel.id = "panels-width-label";
  const rows = GROUPS.flatMap(([group, key, english]) => [heading("h3", key, english, "panels-group"),
    ...HIDE.filter((row) => row[4] === group).map(([id, rowKey, rowEnglish]) => switchRow(id, rowKey, rowEnglish))]);
  card.append(heading("h2", "onscreen.title", "What's on screen"),
    heading("p", "onscreen.intro", "Hide any part of the window you don't use, and choose how the conversation looks. The things that keep you safe always stay.", "subtle"),
    widthLabel, widthRow(), seeRow(), rightClickRow(), everything, ...rows,
    heading("h3", "onscreen.group.never", "Always shown", "panels-group"), ...NEVER.map(neverRow));
  return card;
}
function syncCard() {
  const look = currentAppearance(), hidden = hiddenNow();
  for (const [id] of HIDE) { const box = $(`panels-show-${id}`); if (box) box.checked = !hidden.has(id); }
  for (const choice of document.querySelectorAll(".panels-width-row .choice"))
    choice.setAttribute("aria-pressed", String(choice.value === (look.conversationWidth ?? "wide")));
  const range = $("panels-see-range");
  if (range && document.activeElement !== range) range.value = String(look.seeThrough ?? 30);
  const right = $("panels-right-click");
  if (right) right.checked = Boolean(look.rightClickHide);
  const all = $("panels-show-all");
  if (all) all.disabled = hidden.size === 0;
}

function everythingNow() {
  applyHidden();
  applySeeThrough();
  syncCard();
}
function start() {
  document.body.append(probe);
  const card = buildCard();
  (document.querySelector("#lx-page-appearance") ?? document.body).append(card);
  document.addEventListener("branch-appearance", everythingNow);
  document.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("pointerdown", (event) => { if (menu && !menu.contains(event.target)) closeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeMenu(); });
  new MutationObserver(applySeeThrough).observe(root, { attributes: true, attributeFilter: ["style", "data-theme", "data-palette", "data-motion"] });
  new MutationObserver(() => floatGear(hiddenNow().has("side-list"))).observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
  matchMedia("(prefers-reduced-transparency: reduce)").addEventListener?.("change", applySeeThrough);
  everythingNow();
  globalThis.branchOnscreen = { hide: setHidden, hidden: () => [...hiddenNow()], ids: () => HIDE.map(([id]) => id) };
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

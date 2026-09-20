/* phase2/settings: Settings, grown up (owner critiques #19, #24, #37, #40, #48, #54, #62).

   - Each page is grouped by what a person wants to do (public/settings-buckets.js). The cards stay the
     direct children of their page, each with its own id and module; this file only puts them in order
     and draws a heading in front of each group, so layout.js, search and every module keep working.
   - How much to show: Regular, Advanced or Technical (the settingsLevel preference). A card above the
     level is out of sight, one click away ("N more with Advanced") and always found by search.
     Anything in Settings marked data-level="advanced" or "technical" follows the same rule.
   - Search also reads the index of every setting Branch has (public/settings-index.js), so a setting
     behind a switch, in a dialog or in another place is still found, with a way to go there.
   - Settings is a cog right after the account row; opening and moving about never loses your place.
   Nothing here changes what a setting does. */
import { fromEnglish, language, t } from "/i18n.js";
import { changeAppearance, currentAppearance } from "/appearance.js";
import { BUCKETS, ICON_PATHS, NAV_GROUPS } from "/settings-buckets.js";
import { SETTINGS_INDEX } from "/settings-index.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const LEVELS = ["regular", "advanced", "technical"];
const RANK = { regular: 0, advanced: 1, technical: 2 };
const say = (key, english, values) => { const word = t(key, values); return word === key ? english.replace(/\{(\w+)\}/g, (_, k) => values?.[k] ?? "") : word; };
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function worded(tag, className, key, english) {
  const node = make(tag, className, say(key, english));
  node.dataset.t = key;
  return node;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sg-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name] ?? ICON_PATHS.more);
  svg.append(path);
  return svg;
}

/** An icon before a button's words; the words keep their key, so a new language rewrites only them. */
function withIcon(node, name) {
  const words = make("span", "sg-words", node.textContent);
  if (node.dataset.t) { words.dataset.t = node.dataset.t; delete node.dataset.t; }
  node.replaceChildren(icon(name), words);
}

/* ---------- how much to show ---------- */
/** The level in force: the saved choice, or Advanced for someone who already had Show everything on. */
/** Whether the window is on somebody else's profile (public/app.js marks <html data-household>). */
const household = () => root.dataset.household === "on";
export function levelNow() {
  /* Somebody else's profile always sees Regular: the fine controls and where things are saved are the owner's. */
  if (household()) return "regular";
  const look = currentAppearance();
  if (LEVELS.includes(look.settingsLevel)) return look.settingsLevel;
  return look.showEverything ? "advanced" : "regular";
}
/** Regular is the calm window; Advanced and Technical bring back everything, as Show everything did. */
function chooseLevel(level) {
  if (!LEVELS.includes(level) || household()) return;
  keepAnchor(() => changeAppearance({ settingsLevel: level, showEverything: level !== "regular" }));
}
let applied = null;
function applyLevel() {
  const level = levelNow(), state = `${level}:${household()}`;
  if (applied === state) return;
  applied = state;
  root.dataset.settingsLevel = level;
  for (const option of document.querySelectorAll(".sg-level [data-level-pick]"))
    option.setAttribute("aria-checked", String(option.dataset.levelPick === level));
  const note = document.querySelector(".sg-level-note"), key = household() ? "settingsGrown.level.household" : `settingsGrown.level.${level}.note`;
  if (note) { note.dataset.t = key; note.textContent = say(key, household() ? HOUSEHOLD_NOTE : LEVEL_NOTES[level]); }
  for (const option of document.querySelectorAll(".sg-level [data-level-pick]")) option.disabled = household();
  countHidden();
  document.dispatchEvent(new CustomEvent("branch-settings-level", { detail: { level } }));
}
const HOUSEHOLD_NOTE = "The owner keeps this profile on Regular.";
const LEVEL_WORDS = { regular: "Regular", advanced: "Advanced", technical: "Technical" };
const LEVEL_NOTES = {
  regular: "The essentials, in plain words.",
  advanced: "Every feature and the fine controls.",
  technical: "Also where each setting is saved, and the plumbing.",
};
function levelBox() {
  const box = make("div", "sg-level");
  box.append(worded("p", "sg-level-label", "settingsGrown.level.label", "How much to show"));
  const group = make("div", "sg-level-seg");
  group.id = "sg-level-seg";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", say("settingsGrown.level.label", "How much to show"));
  for (const level of LEVELS) {
    const option = worded("button", "sg-level-option", `settingsGrown.level.${level}`, LEVEL_WORDS[level]);
    option.type = "button";
    option.setAttribute("role", "radio");
    option.dataset.levelPick = level;
    option.setAttribute("aria-checked", String(levelNow() === level));
    option.addEventListener("click", () => chooseLevel(level));
    group.append(option);
  }
  group.addEventListener("keydown", (event) => moveLevel(event, group));
  box.append(group, worded("p", "sg-level-note", `settingsGrown.level.${levelNow()}.note`, LEVEL_NOTES[levelNow()]));
  return box;
}
/** Arrow keys move along the three, as in any radio group. */
function moveLevel(event, group) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const next = LEVELS[(RANK[levelNow()] + step + LEVELS.length) % LEVELS.length];
  chooseLevel(next);
  group.querySelector(`[data-level-pick="${next}"]`)?.focus();
}
/* For other modules: the level now, choosing one, and showing one card whatever the level until you leave its page. */
globalThis.branchSettingsLevel = { get: levelNow, set: chooseLevel, levels: [...LEVELS], peek: (node) => peek(node), peekPage: () => peekPage() };

/* ---------- the groups on each page ---------- */
const hostFor = (page) => (page.startsWith("models:") ? $(`lx-models-${page.slice(7)}`) : $(`lx-page-${page}`));
const FIXED = ".lx-page-title, .lx-page-intro, .lx-subtabs, .lx-subpanel";
/** A card of the page: by id, or (for a block with no id) by its class. */
function cardIn(host, ref) {
  const node = document.getElementById(ref);
  if (node?.parentElement === host) return node;
  return host.querySelector(`:scope > .${CSS.escape(ref)}`);
}
function bucketHead(page, [id, iconName, title, line]) {
  const head = make("div", "sg-head");
  head.dataset.bucket = `${page}:${id}`;
  // DG-011: Remove icon tile and description line - sample doesn't show these
  // const tile = make("span", "sg-tile");
  // tile.append(icon(iconName));
  const words = make("div", "sg-head-words");
  const key = id === "other" ? "settingsGrown.bucket.other" : `settingsGrown.bucket.${page.replace(":", ".")}.${id}`;
  const heading = worded("h3", "sg-head-title", key, title);
  heading.id = `sg-bucket-${page.replace(":", "-")}-${id}`;
  words.append(heading);
  // DG-011: Remove description line - sample doesn't show section descriptions in headers
  // words.append(worded("p", "sg-head-line", `${key}.line`, line));
  const more = make("button", "sg-more");
  more.type = "button";
  more.hidden = true;
  more.addEventListener("click", () => chooseLevel(more.dataset.to));
  head.append(words, more);
  // DG-011: Don't append the icon tile since it's not in the sample
  return head;
}
function otherHead(page) {
  const head = bucketHead(page, ["other", "more", "More on this page", "Settings added here by something else."]);
  head.classList.add("sg-other");
  return head;
}
const heads = new Map();
function headFor(page, bucket) {
  const key = `${page}:${bucket[0]}`;
  if (!heads.has(key)) heads.set(key, bucket[0] === "other" ? otherHead(page) : bucketHead(page, bucket));
  return heads.get(key);
}
/** Writes a data- value only when it differs: this runs whenever the page changes, and a write is a change too. */
function mark(node, name, value) {
  if (node.dataset[name] !== value) node.dataset[name] = value;
}
/** The nodes of a page in the order they should stand: each head, then its cards. */
function wanted(page, host) {
  const order = [], placed = new Set();
  for (const bucket of BUCKETS[page]) {
    const head = headFor(page, bucket), ids = [];
    order.push(head);
    for (const [ref, level] of bucket[4]) {
      const card = cardIn(host, ref);
      if (!card) continue;
      mark(card, "level", level);
      if (peeked.has(card.id) || peekedPages.has(page.split(":")[0])) mark(card, "sgPeek", "1");
      mark(card, "sgBucket", head.dataset.bucket);
      ids.push(card.id || ref);
      placed.add(card);
      order.push(card);
      putKeys(card);
    }
    mark(head, "cards", ids.join(" "));
  }
  const rest = [...host.children].filter((node) => !node.matches(FIXED) && !placed.has(node) && !node.matches(".sg-head"));
  if (rest.length) {
    const head = headFor(page, ["other"]);
    mark(head, "cards", rest.map((node) => node.id).join(" "));
    for (const node of rest) mark(node, "sgBucket", head.dataset.bucket);
    order.push(head, ...rest);
  }
  return order.filter(Boolean);
}
/** Puts the page in order, touching only what is out of place, so running it again moves nothing. */
function arrange(page) {
  const host = hostFor(page);
  if (!host) return;
  const order = wanted(page, host);
  let before = [...host.children].filter((node) => node.matches(FIXED)).at(-1) ?? null;
  if (page.startsWith("models:")) before = null;
  for (const node of order) {
    const spot = before ? before.nextSibling : host.firstChild;
    if (spot !== node) host.insertBefore(node, spot);
    before = node;
  }
  for (const stale of host.querySelectorAll(":scope > .sg-head")) if (!order.includes(stale)) stale.remove();
}

/* ---------- Technical: where each card's settings are saved ---------- */
const KEYS_BY_CARD = new Map();
for (const [, , card, , key] of SETTINGS_INDEX) if (card && key) KEYS_BY_CARD.set(card, [...new Set([...(KEYS_BY_CARD.get(card) ?? []), key])]);
const keyLines = new Map();
/** At Technical, the last line of a card names where its settings are saved. Put back if the card redraws itself. */
function putKeys(card) {
  const keys = KEYS_BY_CARD.get(card.id);
  if (!keys) return;
  if (!keyLines.has(card.id)) {
    const line = make("div", "sg-keys");
    line.append(worded("span", "sg-keys-label", "settingsGrown.savedAs", "Saved as"), make("code", "sg-keys-names", keys.join(" · ")));
    keyLines.set(card.id, line);
  }
  const line = keyLines.get(card.id);
  if (card.lastElementChild !== line) card.append(line);
}

/* ---------- "N more with Advanced" ---------- */
function countHidden() {
  const now = RANK[levelNow()];
  for (const head of heads.values()) {
    const cards = head.dataset.cards.split(" ").filter(Boolean).map((id) => $(id) ?? head.parentElement?.querySelector(`:scope > .${CSS.escape(id)}`)).filter((card) => card && !card.hidden);
    const above = cards.filter((card) => RANK[card.dataset.level ?? "regular"] > now);
    const shown = cards.filter((card) => !above.includes(card));
    for (const card of cards) card.classList.toggle("sg-solo", shown.length === 1 && card === shown[0]);
    const more = head.querySelector(".sg-more");
    head.classList.toggle("sg-empty", cards.length === 0);
    head.classList.toggle("sg-thin", cards.length > 0 && above.length === cards.length);
    if (more.hidden !== (above.length === 0)) more.hidden = above.length === 0;
    if (!above.length) continue;
    const to = above.some((card) => card.dataset.level === "advanced") ? "advanced" : "technical";
    mark(more, "to", to);
    const words = say(`settingsGrown.more.${to}`, `${above.length} more with ${LEVEL_WORDS[to]}`, { count: above.length });
    /* Written only when it changes: this runs whenever the page changes, and a write is itself a change. */
    if (more.textContent !== words) more.textContent = words;
  }
}
function arrangeAll() {
  for (const page of Object.keys(BUCKETS)) arrange(page);
  countHidden();
}
let arranging = 0;
function watchPages() {
  const again = () => { if (arranging) return; arranging = requestAnimationFrame(() => { arranging = 0; arrangeAll(); }); };
  for (const page of Object.keys(BUCKETS)) {
    const host = hostFor(page);
    if (!host) continue;
    new MutationObserver(again).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
  }
}

/* ---------- the Settings list: groups, icons, places, the level, and a page picker for small screens ---------- */
function dressNav() {
  const nav = document.querySelector(".lx-settings-nav");
  if (!nav || nav.dataset.sgDressed) return;
  nav.dataset.sgDressed = "1";
  for (const link of nav.querySelectorAll(".lx-settings-link")) withIcon(link, link.dataset.page);
  for (const [before, key, english] of NAV_GROUPS)
    nav.querySelector(`.lx-settings-link[data-page="${before}"]`)?.before(worded("p", "sg-nav-group", `settingsGrown.nav.${key}`, english));
  nav.append(pagePicker(nav), levelBox());
  const version = $("lx-settings-version");
  if (version) nav.append(version);
}
/** On a phone the list of pages is one choice, not a row that scrolls sideways. */
function pagePicker(nav) {
  const label = make("label", "sg-picker");
  const words = worded("span", "sr-only", "settings.pages", "Settings pages");
  const select = make("select");
  select.id = "sg-page-pick";
  for (const link of nav.querySelectorAll(".lx-settings-link")) {
    const option = make("option", "", link.textContent.trim());
    option.value = link.dataset.page;
    select.append(option);
  }
  select.addEventListener("change", () => nav.querySelector(`.lx-settings-link[data-page="${select.value}"]`)?.click());
  label.append(words, select);
  return label;
}
function namePickerPages() {
  for (const option of $("sg-page-pick")?.options ?? [])
    option.textContent = document.querySelector(`.lx-settings-link[data-page="${option.value}"]`)?.textContent.trim() ?? option.textContent;
}
function syncPicker() {
  const current = document.querySelector(".lx-settings-link[aria-current='true']")?.dataset.page;
  const select = $("sg-page-pick");
  if (!select || !current || select.value === current) return;
  select.value = current;
  select.dispatchEvent(new Event("branch-sync"));
}

/* ---------- Settings is a cog right after the account row (#37) ---------- */
/** The account row, then the cog: the calm window's Settings row and the full window's gear both become that cog. */
function placeGear() {
  const owner = $("owner-menu-button");
  if (!owner) return;
  const line = make("div", "sg-foot-line");
  owner.before(line);
  line.append(owner);
  for (const gear of [$("lx-settings-row"), $("rail-settings")]) {
    if (!gear) continue;
    gear.querySelector("svg")?.replaceWith(icon("gear"));
    gear.querySelector(".lx-words")?.classList.add("sr-only");
    gear.classList.add("sg-gear");
    gear.title = say("settings.title", "Settings");
    gear.setAttribute("aria-haspopup", "dialog");
    line.append(gear);
  }
  const expanded = () => { for (const gear of line.querySelectorAll(".sg-gear")) gear.setAttribute("aria-expanded", String(!$("settings-window")?.hidden)); };
  expanded();
  new MutationObserver(expanded).observe($("settings-window"), { attributes: true, attributeFilter: ["hidden"] });
}

/* ---------- search finds every setting, wherever it is ---------- */
function homeWords(home) {
  const [where, page, sub] = home.split(":");
  if (where === "settings") {
    const parts = [t("settings.title"), t(`settings.page.${page}`)];
    if (sub) parts.push(t(`settings.models.${sub}`));
    return parts.join(" › ");
  }
  return `${t(`place.${where}`)} › ${t(`place.${where}.${page}`)}`;
}
/** The control, its stand-in, or its card, whichever is on the page now. */
function nodeFor([id, , card, , , selector]) {
  return $(id) ?? (selector ? document.querySelector(selector) : null) ?? (card ? $(card) : null);
}
/** A setting counts as already shown when its card is a match on a Settings page. */
function shownBySearch(row) {
  const node = nodeFor(row);
  const card = node?.closest(".lx-page > *, .lx-subpanel > *");
  return Boolean(card && !card.classList.contains("lx-miss") && node.closest(".lx-page") && node.checkVisibility?.());
}
/** Words drawn on the page, in the language it is in (the index holds English). */
const drawn = (node) => node?.textContent.replace(/\s+/g, " ").trim() || null;
/**
 * A setting's name: the index's English, or in another language the words beside its control when it is drawn,
 * else (mac7/residuals) the locale files' words for that English, so a control not drawn yet is named too.
 */
function labelOf(row) {
  return language() === "en" ? row[3] : drawn($(row[0])?.labels?.[0]) ?? fromEnglish(row[3]) ?? row[3];
}
function cardTitleOf(row) {
  if (language() === "en" || !row[6]) return row[6];
  return (row[2] ? drawn($(row[2])?.querySelector(":scope > h2, :scope > h3")) : null) ?? fromEnglish(row[6]) ?? row[6];
}
/** Settings in the index that match and are not already on show, closest first: the label itself, then its start. */
function matches(needle) {
  const found = [];
  for (const row of SETTINGS_INDEX) {
    const label = labelOf(row).toLowerCase();
    const words = `${label} ${row[3]} ${cardTitleOf(row) ?? ""} ${row[6] ?? ""} ${homeWords(row[1])}`.toLowerCase();
    /* Somebody else's profile is never shown the owner's settings, even by name. */
    if (!words.includes(needle) || shownBySearch(row) || (row[7] && household())) continue;
    found.push([label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : 3, row]);
  }
  return found.sort((a, b) => a[0] - b[0]).map(([, row]) => row);
}
function foundRow(row) {
  const item = make("li", "sg-found-item");
  item.dataset.setting = row[0];
  const words = make("span", "sg-found-words");
  words.append(make("b", "", labelOf(row)), make("small", "", [cardTitleOf(row), homeWords(row[1])].filter(Boolean).join(" · ")));
  const why = whyUnseen(row);
  if (why) words.append(worded("small", "sg-found-gate", ...why));
  const go = worded("button", "sg-found-go", "settingsGrown.found.go", "Go there");
  go.type = "button";
  go.addEventListener("click", () => goToSetting(row));
  item.append(words, go);
  return item;
}
/** Why a Settings control is not on show: its card is hidden on this computer now, or it waits for its card's switch. */
function whyUnseen(row) {
  if (!row[1].startsWith("settings")) return null;
  const node = nodeFor(row);
  if (node?.checkVisibility?.()) return null;
  const card = node?.closest(".lx-page > *, .lx-subpanel > *") ?? (row[2] ? $(row[2]) : null);
  if (!card || card.hidden) return ["settingsGrown.found.hidden", "Not shown on this computer right now."];
  return ["settingsGrown.found.gate", "Shows once the switch on its card is on."];
}
const FOUND_FIRST = 12;
function drawFound(query) {
  $("sg-found")?.remove();
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return;
  const found = matches(needle);
  if (!found.length) return;
  $("lx-settings-empty")?.remove();
  const box = make("section", "sg-found");
  box.id = "sg-found";
  box.setAttribute("aria-labelledby", "sg-found-title");
  const title = worded("h3", "sg-found-title", "settingsGrown.found.title", "Also found, elsewhere or behind a switch");
  title.id = "sg-found-title";
  const list = make("ul", "sg-found-list");
  list.append(...found.slice(0, FOUND_FIRST).map(foundRow));
  box.append(title, list);
  if (found.length > FOUND_FIRST) box.append(showAll(list, found));
  $("lx-settings-body").prepend(box);
}
function showAll(list, found) {
  const all = make("button", "sg-found-all", say("settingsGrown.found.all", `Show all ${found.length}`, { count: found.length }));
  all.type = "button";
  all.addEventListener("click", () => { list.append(...found.slice(FOUND_FIRST).map(foundRow)); all.remove(); });
  return all;
}
/** Heads follow their cards while searching: a group shows when one of its cards is a match. */
function searchHeads(query) {
  const needle = query.trim();
  for (const head of heads.values()) {
    if (!needle) { head.classList.remove("lx-miss"); continue; }
    const ids = head.dataset.cards.split(" ").filter(Boolean);
    const hit = ids.some((id) => { const card = $(id) ?? head.parentElement?.querySelector(`:scope > .${CSS.escape(id)}`); return card && !card.classList.contains("lx-miss"); });
    head.classList.toggle("lx-miss", !hit);
  }
}
function onSearch(event) {
  searchHeads(event.target.value);
  drawFound(event.target.value);
}
/** Opens where a setting lives, shows its card even above the level for now, and points at it. */
function goToSetting(row) {
  const node = nodeFor(row);
  const layout = globalThis.branchLayout;
  hold = null;
  if (!node || !layout?.reveal(node)) {
    layout?.go(row[1].startsWith("settings:") ? `settings:${row[1].split(":")[1]}` : row[1]);
    return;
  }
  requestAnimationFrame(() => {
    node.scrollIntoView({ block: "center" });
    node.classList.add("sg-flash");
    setTimeout(() => node.classList.remove("sg-flash"), 1800);
  });
}
/** Anything that opens Settings at one setting (a link from elsewhere, Go there) shows its card whatever the level. */
function peekOnReveal() {
  const layout = globalThis.branchLayout;
  if (!layout?.reveal) return;
  const reveal = layout.reveal;
  layout.reveal = (target) => {
    peek(typeof target === "string" ? $(target) : target);
    revealing = true;
    setTimeout(() => { revealing = false; }, 400);
    return reveal(target);
  };
}
/** Cards shown whatever the level until you leave the page; kept by id, since a card may draw itself anew. */
const peeked = new Set(), peekedPages = new Set();
/** Every card of the page open now, whatever the level, until you leave it (cards drawn later included). */
function peekPage() {
  const page = currentPage();
  if (!page) return;
  peekedPages.add(page);
  for (const card of document.querySelectorAll(`#lx-page-${page} [data-level]`)) card.dataset.sgPeek = "1";
}
function peek(node) {
  const card = node?.closest?.(".lx-page > *, .lx-subpanel > *");
  if (!card) return;
  card.dataset.sgPeek = "1";
  if (card.id) peeked.add(card.id);
}
function clearPeeks() {
  peeked.clear();
  peekedPages.clear();
  for (const node of document.querySelectorAll("[data-sg-peek]")) delete node.dataset.sgPeek;
}

/* ---------- never lose your place (#54) ---------- */
const body = () => $("lx-settings-body");
/** Keeps the thing under the pointer where it was while something above it changes (a level, a redraw). */
function keepAnchor(change) {
  const scroller = body();
  const edge = scroller?.getBoundingClientRect().top ?? 0;
  const shown = scroller ? [...scroller.querySelectorAll(".lx-page > *, .lx-subpanel > *")].filter((node) => node.checkVisibility?.()) : [];
  /* The first thing that starts on screen (a heading, usually), else the one running across the top edge. */
  const anchor = shown.find((node) => node.getBoundingClientRect().top >= edge - 1) ?? shown.findLast((node) => node.getBoundingClientRect().top < edge);
  const top = anchor?.getBoundingClientRect().top;
  hold = null;
  change();
  if (!anchor) return;
  requestAnimationFrame(() => {
    const target = anchor.checkVisibility?.() ? anchor : anchor.closest(".lx-page, .lx-subpanel")?.querySelector(".sg-head:not(.sg-empty)");
    if (target && top !== undefined) scroller.scrollTop += target.getBoundingClientRect().top - top;
  });
}
const currentPage = () => document.querySelector(".lx-settings-link[aria-current='true']")?.dataset.page ?? null;
/** Where each page was scrolled to, so closing and opening Settings, or pressing a page again, lands where you left. */
const spots = new Map();
let pageNow = null;
function watchPlace() {
  const scroller = body();
  const win = $("settings-window");
  scroller.addEventListener("scroll", () => { if (!win.hidden && currentPage()) spots.set(currentPage(), scroller.scrollTop); }, { passive: true });
  new MutationObserver(() => {
    if (win.hidden) { clearPeeks(); hold = null; return; }
    returnToSpot();
  }).observe(win, { attributes: true, attributeFilter: ["hidden"] });
  document.querySelector(".lx-settings-nav").addEventListener("click", (event) => {
    const link = event.target.closest(".lx-settings-link");
    if (!link) return;
    const again = link.dataset.page === pageNow;
    if (!again) { clearPeeks(); hold = null; }
    const spot = spots.get(link.dataset.page);
    if (again && spot) holdScroll(spot);
    afterPageChange();
  });
}
let revealing = false;
function returnToSpot() {
  if (revealing) { afterPageChange(); return; }
  const current = currentPage();
  const spot = current === pageNow ? spots.get(current) : 0;
  if (spot) holdScroll(spot);
  afterPageChange();
}
/**
 * Puts the page back at a spot and keeps it there for a moment: cards that redraw themselves as the page
 * opens can shrink it for a frame, which would drop you at the top. Scrolling yourself ends the hold.
 */
let hold = null;
function holdScroll(top, ms = 1200) {
  const scroller = body();
  scroller.scrollTop = top;
  hold = { top, until: performance.now() + ms };
}
function watchHold() {
  const scroller = body();
  const release = () => { hold = null; };
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) scroller.addEventListener(type, release, { passive: true });
  scroller.addEventListener("scroll", () => {
    if (!hold) return;
    if (performance.now() > hold.until) { hold = null; return; }
    if (Math.abs(scroller.scrollTop - hold.top) > 2) requestAnimationFrame(() => { if (hold) scroller.scrollTop = hold.top; });
  }, { passive: true });
  const again = new ResizeObserver(() => { if (hold && performance.now() <= hold.until) scroller.scrollTop = hold.top; });
  for (const page of document.querySelectorAll(".lx-page")) again.observe(page);
}
function afterPageChange() {
  pageNow = currentPage();
  syncPicker();
}

/* ---------- pages that only drew themselves when the old Settings button was pressed ---------- */
function drawLatePages(event) {
  if (!String(event.detail?.view ?? "").startsWith("settings")) return;
  if (!$("video-programs-card") || !$("speech-engines-card")) void globalThis.branchMediaPrograms?.render();
}

/* ---------- start ---------- */
function start() {
  dressNav();
  applyLevel();
  placeGear();
  peekOnReveal();
  arrangeAll();
  watchPages();
  watchPlace();
  watchHold();
  $("lx-settings-search")?.addEventListener("input", onSearch);
  new MutationObserver(applyLevel).observe(root, { attributes: true, attributeFilter: ["data-everything"] });
  $("appearance-everything")?.addEventListener("change", (event) => {
    const level = event.target.checked ? (levelNow() === "technical" ? "technical" : "advanced") : "regular";
    changeAppearance({ settingsLevel: level });
  });
  document.addEventListener("branch-place", drawLatePages);
  document.addEventListener("branch-profile", () => { $("sg-found")?.remove(); applyLevel(); });
  document.addEventListener("branch-language", () => { $("sg-found")?.remove(); countHidden(); namePickerPages(); });
  document.body.classList.add("sg-ready");
}
if (document.body.classList.contains("lx-ready")) start();
else new MutationObserver((_, observer) => {
  if (!document.body.classList.contains("lx-ready")) return;
  observer.disconnect();
  start();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

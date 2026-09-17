/* Branch Agent's window, rebuilt (wave 9 redesign, approved by the owner on 2026-09-16).

   Five places instead of ten pages: the conversation, Inbox, Automations, Library and Customize, and
   Settings as a floating window of twelve short pages. Nothing is rewritten here. Every panel keeps its
   id and the module that fills it, and is moved by id into the place it now belongs (see MOVES), so
   the forty-odd modules that bind to those ids keep working untouched.

   The window wears the 44 KeepOak themes as glass over a pixel oak: theme-catalogue.js holds each
   theme's finished colours, BRIDGE hands them to Branch's own token names, grove.js paints the oak.
   public/app.js calls go() from displayView, so every existing way of opening a page still lands. */
import { api, displayView, openConversation, titles } from "/app.js";
import { openPalette } from "/shell.js";
import { t } from "/i18n.js";
import { THEMES, THEME_GROUPS, TOKEN_NAMES } from "/theme-catalogue.js";
import { paint as paintGrove, seasonToday } from "/grove.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* a private window forgets */ }
  },
};

/* ---------- words and small builders ---------- */
/** A word from the language file, or the English given here while that file is still loading. */
const say = (key, english) => { const word = t(key); return word === key ? english : word; };
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
function button(className, key, english) {
  const node = worded("button", className, key, english);
  node.type = "button";
  return node;
}
const ICONS = {
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  automations: "M13 3 5 13h6l-1 8 8-10h-6z",
  library: "M5 4h9a4 4 0 014 4v12H9a4 4 0 01-4-4zM5 16a4 4 0 014-4h9",
  customize: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5a2 2 0 110 4 2 2 0 010-4zM10 15a2 2 0 110 4 2 2 0 010-4z",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  shield: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 110 6 3 3 0 010-6z",
  back: "M15 6l-6 6 6 6",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 5a6 6 0 110 12 6 6 0 010-12zM20 20l-4.2-4.2",
  activity: "M4 17l5-6 4 4 7-8",
  plan: "M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1",
  files: "M7 3h7l5 5v13H7zM14 3v5h5",
  memory: "M12 5a3 3 0 00-5.8-1A3 3 0 004 9a3 3 0 001 5.5A3 3 0 009 19a3 3 0 003-1M12 5a3 3 0 015.8-1A3 3 0 0120 9a3 3 0 01-1 5.5A3 3 0 0115 19a3 3 0 01-3-1M12 5v13",
  send: "M12 19V5M6 11l6-6 6 6",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("lx-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
/** Keeps an existing button's words translatable once an icon sits beside them. */
function iconAndWords(node, name) {
  const words = make("span", "lx-words", node.textContent.trim());
  if (node.dataset.t) {
    words.dataset.t = node.dataset.t;
    delete node.dataset.t;
  }
  node.replaceChildren(...(name ? [icon(name)] : []), words);
  return node;
}

/* ---------- the look: 44 themes, light or dark, the oak in its season ---------- */
const look = {
  family: store.get("branch-palette") || "forest",
  season: store.get("branch-season") || "",
  contrast: store.get("branch-contrast") === "more" ? "more" : "standard",
};
const SEASONS = [["", "look.season.today", "Today"], ["spring", "look.season.spring", "Spring"],
  ["summer", "look.season.summer", "Summer"], ["autumn", "look.season.autumn", "Autumn"], ["winter", "look.season.winter", "Winter"]];
const QUICK = ["forest", "nocturne", "cherry", "ocean", "lavender", "sepia", "mono"];
/* Branch's own token names (public/tokens.css), each taken from the KeepOak token that means the same. */
const BRIDGE = {
  "--panel": "--glass-2", "--panel-2": "--glass", "--muted": "--text-2", "--faint": "--text-3",
  "--line-strong": "--line-2", "--selected": "--press", "--good": "--ok", "--good-tint": "--ok-tint",
  "--danger": "--bad", "--copper-low": "--copper-lo", "--rail-hover": "--press", "--bubble": "--copper-tint",
  "--composer-bg": "--glass-2", "--step-bg": "--well", "--border": "--line", "--text-dim": "--text-3",
};
const modeNow = () => (root.dataset.theme === "daylight" ? "light" : "dark");
const themeById = (id) => THEMES.find((theme) => theme[0] === id) ?? THEMES[0];
/** One theme's colours for light or dark, as { "--token": value }. */
function tokensFor(theme, mode, contrast = "standard") {
  const values = theme[3][`${mode}${contrast === "more" ? "-more" : ""}`];
  return Object.fromEntries(TOKEN_NAMES.map((name, index) => [name, values[index]]).filter(([name, value]) => value && name !== "--blur"));
}
const rgbOf = (hex) => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) : null;
/** An opaque surface for menus and the settings window, a step off the ground toward the text. */
function solid(ground, toward, amount) {
  const from = rgbOf(ground), to = rgbOf(toward);
  if (!from || !to) return ground;
  return `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * amount)).join(", ")})`;
}
function applyLook() {
  const family = themeById(look.family), mode = modeNow();
  const tokens = tokensFor(family, mode, look.contrast);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) root.style.setProperty(name, tokens[from]);
  const surface = solid(tokens["--ground"], mode === "dark" ? tokens["--text"] : "#ffffff", mode === "dark" ? 0.07 : 0.55);
  root.style.setProperty("--surface", surface);
  root.dataset.palette = family[0];
  paintGrove({ mode, season: look.season || seasonToday() });
  drawLookControls();
}
function setLook(patch) {
  Object.assign(look, patch);
  store.set("branch-palette", look.family === "forest" ? null : look.family);
  store.set("branch-season", look.season || null);
  store.set("branch-contrast", look.contrast === "more" ? "more" : null);
  applyLook();
}
/** A small picture of a theme: its ground, a pane, a line of text and its accent. */
function themeTile(family, onPick) {
  const tokens = tokensFor(family, modeNow());
  const tile = make("button", "lx-tile");
  tile.type = "button";
  tile.dataset.family = family[0];
  tile.setAttribute("aria-pressed", String(look.family === family[0]));
  const mini = make("span", "lx-mini");
  mini.style.background = tokens["--ground"];
  const pane = make("b");
  pane.style.background = tokens["--glass-2"];
  pane.style.borderColor = tokens["--glass-edge"];
  const line = make("s");
  line.style.background = tokens["--text-3"];
  const dot = make("u");
  dot.style.background = tokens["--copper"];
  mini.append(pane, line, dot);
  tile.append(mini, make("span", "lx-tile-name", family[1]));
  tile.addEventListener("click", () => onPick(family[0]));
  return tile;
}
/** Sets the Forest/Daylight choice through the existing controls, so it is saved with the workspace. */
function chooseMode(mode) {
  const follow = $("appearance-follow"), select = $("appearance");
  if (!follow || !select) return;
  const wantFollow = mode === "";
  if (follow.checked !== wantFollow) {
    follow.checked = wantFollow;
    follow.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (!wantFollow && select.value !== (mode === "light" ? "daylight" : "forest")) {
    select.value = mode === "light" ? "daylight" : "forest";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
function segmented(label, options, isOn, onPick) {
  const group = make("div", "lx-seg");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  for (const [value, key, english] of options) {
    const choice = button("lx-seg-button", key, english);
    choice.setAttribute("aria-pressed", String(isOn(value)));
    choice.addEventListener("click", () => onPick(value));
    group.append(choice);
  }
  return group;
}
function drawLookControls() {
  const gallery = $("lx-theme-gallery");
  if (gallery) {
    gallery.replaceChildren();
    for (const [id, name] of THEME_GROUPS) {
      gallery.append(make("p", "lx-eyebrow", name));
      const grid = make("div", "lx-tiles");
      for (const family of THEMES.filter((item) => item[2] === id))
        grid.append(themeTile(family, (value) => setLook({ family: value })));
      gallery.append(grid);
    }
    $("lx-theme-count").textContent = `${THEMES.length} · ${themeById(look.family)[1]}`;
  }
  const follow = $("appearance-follow")?.checked;
  const modeHost = $("lx-mode");
  if (modeHost) modeHost.replaceChildren(segmented("Light or dark",
    [["", "look.mode.follow", "Follow this computer"], ["dark", "look.mode.dark", "Dark"], ["light", "look.mode.light", "Light"]],
    (value) => (follow ? value === "" : !follow && value === modeNow()), chooseMode));
  const seasonHost = $("lx-season");
  if (seasonHost) seasonHost.replaceChildren(segmented("Season", SEASONS, (value) => value === look.season, (value) => setLook({ season: value })));
  const contrast = $("lx-contrast");
  if (contrast) contrast.checked = look.contrast === "more";
  drawQuickThemes();
}
function drawQuickThemes() {
  const host = $("lx-quick-themes");
  if (!host) return;
  host.replaceChildren();
  for (const id of QUICK) {
    const family = themeById(id);
    const tokens = tokensFor(family, modeNow());
    const dot = make("button", "lx-quick");
    dot.type = "button";
    dot.setAttribute("role", "menuitem");
    dot.setAttribute("aria-label", `${family[1]} theme`);
    dot.title = family[1];
    dot.setAttribute("aria-pressed", String(look.family === id));
    dot.style.background = `linear-gradient(135deg, ${tokens["--ground"]} 0 50%, ${tokens["--copper"]} 50% 100%)`;
    dot.addEventListener("click", () => setLook({ family: id }));
    host.append(dot);
  }
}

/* ---------- the five places ---------- */
const PLACES = {
  inbox: { key: "place.inbox", english: "Inbox", intro: ["place.inbox.intro", "What needs your yes, what finished while you were away, and everything that happened."],
    tabs: [["needs", "place.inbox.needs", "Needs you"], ["finished", "place.inbox.finished", "Finished"], ["history", "place.inbox.history", "History", "runs"]] },
  automations: { key: "place.automations", english: "Automations", intro: ["place.automations.intro", "Work that runs without you asking each time: on a schedule, as a procedure, or when something happens."],
    tabs: [["scheduled", "place.automations.scheduled", "Scheduled", "schedules"], ["procedures", "place.automations.procedures", "Procedures", "procedures"], ["triggers", "place.automations.triggers", "Triggers"]] },
  library: { key: "place.library", english: "Library", intro: ["place.library.intro", "What your assistant knows and what it has made for you."],
    tabs: [["memory", "place.library.memory", "Memory", "memory"], ["documents", "place.library.documents", "Documents", "documents"], ["made", "place.library.made", "Made for you"]] },
  customize: { key: "place.customize", english: "Customize", intro: ["place.customize.intro", "What your assistant can do, and who can reach it."],
    tabs: [["skills", "place.customize.skills", "Skills", "skills"], ["specialists", "place.customize.specialists", "Specialists", "specialists"],
      ["plugins", "place.customize.plugins", "Plugins"], ["connections", "place.customize.connections", "Connections"], ["channels", "place.customize.channels", "Channels"]] },
};
const SETTINGS_PAGES = [
  ["general", "settings.page.general", "General", "How Branch starts and runs on this computer, your projects, and the people who use it."],
  ["assistant", "settings.page.assistant", "Assistant", "Who your assistant is, and how much it keeps and learns."],
  ["appearance", "settings.page.appearance", "Appearance", "Every KeepOak theme, light or dark, with the oak in any season. Changes show behind this window as you pick."],
  ["notifications", "settings.page.notifications", "Notifications", "When Branch may interrupt you, and the days it should leave you alone."],
  ["models", "settings.page.models", "Models", "Which models your assistant uses, and how it signs in to them."],
  ["voice", "settings.page.voice", "Voice", "Talking to your assistant and hearing it answer."],
  ["permissions", "settings.page.permissions", "Permissions", "What your assistant may do without asking, and how much it may do at once."],
  ["computer", "settings.page.computer", "Computer & browser", "What it may touch on this computer, in your browser and on your other machines."],
  ["secrets", "settings.page.secrets", "Secrets", "Keys and passwords your assistant may use, one item at a time."],
  ["data", "settings.page.data", "Data & usage", "What it costs, what is kept, and your safety copies."],
  ["advanced", "settings.page.advanced", "Advanced", "Tools for checking and fixing Branch."],
  ["about", "settings.page.about", "Updates & about", "Your version, and updates."],
];
const MODEL_TABS = [["connection", "settings.models.connection", "Connection"], ["defaults", "settings.models.defaults", "Defaults"],
  ["local", "settings.models.local", "On this computer"], ["second", "settings.models.second", "Second opinion"], ["media", "settings.models.media", "Pictures & sound"]];
/* Where every existing panel now lives: [its id, the slot it moves into]. Order inside a slot follows this list. */
const MOVES = [
  ["policy-waiting-card", "lx-slot-inbox-needs"],
  ["automations-container", "lx-slot-automations-triggers"], ["hooks-card", "lx-slot-automations-triggers"],
  ["obsidian-card", "documents"],
  ["plugins-card", "lx-slot-customize-plugins"],
  ["mcp-card", "lx-slot-customize-connections"],
  ["channels-card", "lx-slot-customize-channels"], ["embeds-card", "lx-slot-customize-channels"],
  ["deployment-card", "lx-page-general"], ["projects-form", "lx-page-general"],
  ["identity-form", "lx-page-assistant"],
  ["settings-form", "lx-page-appearance"],
  ["voice-settings-form", "lx-page-voice"],
  ["model-settings-form", "lx-models-connection"], ["chatgpt-card", "lx-models-connection"], ["gemini-signin-card", "lx-models-connection"],
  ["models-form", "lx-models-connection"], ["model-probe-card", "lx-models-connection"],
  ["model-profiles-card", "lx-models-defaults"], ["local-models-card", "lx-models-local"],
  ["second-opinion-form", "lx-models-second"], ["media-form", "lx-models-media"],
  ["policy-card", "lx-page-permissions"], ["limits-card", "lx-page-permissions"],
  ["desktop-card", "lx-page-computer"], ["sandbox-card", "lx-page-computer"], ["firewall-card", "lx-page-computer"],
  ["browser-card", "lx-page-computer"], ["remote-card", "lx-page-computer"],
  ["secrets-form", "lx-page-secrets"],
  ["usage", "lx-page-data"], ["retention-card", "lx-page-data"], ["backup-card", "lx-page-data"], ["snapshots-card", "lx-page-data"],
  ["health-card", "lx-page-advanced"], ["diagnostics-card", "lx-page-advanced"], ["developer-card", "lx-page-advanced"],
  ["updates-card", "lx-page-about"],
];
/* Every name displayView has ever been called with, and where it lands now. */
const ROUTES = {
  chat: { place: "chat" },
  runs: { place: "inbox", tab: "history" },
  memory: { place: "library", tab: "memory" },
  documents: { place: "library", tab: "documents" },
  skills: { place: "customize", tab: "skills" },
  specialists: { place: "customize", tab: "specialists" },
  procedures: { place: "automations", tab: "procedures" },
  schedules: { place: "automations", tab: "scheduled" },
  usage: { settings: "data" },
  settings: { settings: "" },
};
for (const [place, spec] of Object.entries(PLACES)) {
  ROUTES[place] = { place };
  for (const [tab] of spec.tabs) ROUTES[`${place}:${tab}`] = { place, tab };
}
for (const [page] of SETTINGS_PAGES) ROUTES[`settings:${page}`] = { settings: page };

let place = "chat";
const lastTab = { inbox: "needs", automations: "scheduled", library: "memory", customize: "skills" };
let settingsPage = "general";

/* ---------- building the places ---------- */
function buildPlace(id, spec) {
  const view = make("section", "view lx-place");
  view.id = id;
  view.hidden = true;
  view.setAttribute("aria-labelledby", `lx-${id}-title`);
  const head = make("div", "lx-place-head");
  const title = worded("h2", "lx-place-title", spec.key, spec.english);
  title.id = `lx-${id}-title`;
  head.append(title, worded("p", "lx-place-intro", spec.intro[0], spec.intro[1]));
  view.append(head);
  if (id === "inbox") view.append(awayCard());
  const tabs = make("div", "lx-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", spec.english);
  view.append(tabs);
  for (const [tab, key, english, oldView] of spec.tabs) {
    const trigger = tabButton(id, tab, key, english, oldView);
    tabs.append(trigger);
    const panel = oldView ? $(oldView) : make("div", "lx-slot");
    if (!oldView) panel.id = `lx-slot-${id}-${tab}`;
    panel.classList.remove("view");
    panel.classList.add("lx-panel");
    panel.dataset.place = id;
    panel.dataset.tab = tab;
    panel.setAttribute("role", "tabpanel");
    panel.hidden = true;
    view.append(panel);
  }
  view.append(askDock(id, spec.english));
  $("workspace").append(view);
}
/** The tab reuses the old section button when there was one, so every listener on it still fires. */
function tabButton(placeId, tab, key, english, oldView) {
  let trigger = oldView && document.querySelector(`.nav[data-view="${oldView}"]`);
  if (trigger) {
    iconAndWords(trigger);
    const words = trigger.querySelector(".lx-words");
    words.dataset.t = key;
    words.textContent = say(key, english);
    trigger.classList.remove("active");
  } else {
    trigger = button("", key, english);
    iconAndWords(trigger);
    trigger.dataset.view = `${placeId}:${tab}`;
    trigger.addEventListener("click", () => displayView(trigger.dataset.view));
  }
  trigger.className = "lx-tab";
  trigger.setAttribute("role", "tab");
  trigger.dataset.place = placeId;
  trigger.dataset.tab = tab;
  trigger.removeAttribute("title");
  return trigger;
}
/** A one-line ask box on every place, so a question never means going back to the conversation first. */
function askDock(id, english) {
  const form = make("form", "lx-ask");
  const label = make("label", "sr-only", `Ask your assistant about ${english.toLowerCase()}`);
  label.htmlFor = `lx-ask-${id}`;
  const input = make("input");
  input.id = `lx-ask-${id}`;
  input.type = "text";
  input.maxLength = 16000;
  input.autocomplete = "off";
  input.placeholder = say("place.ask", "Ask your assistant anything…");
  input.dataset.tPlaceholder = "place.ask";
  const send = make("button", "lx-ask-send");
  send.type = "submit";
  send.setAttribute("aria-label", say("place.askSend", "Ask"));
  send.append(icon("send"));
  form.append(label, input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = "";
    displayView("chat");
    $("prompt").value = text;
    $("chat-form").requestSubmit();
  });
  return form;
}
function awayCard() {
  const card = make("div", "lx-away");
  card.id = "lx-away";
  card.hidden = true;
  const line = make("p", "lx-away-line");
  line.id = "lx-away-line";
  const actions = make("div", "lx-away-actions");
  const review = button("lx-button lx-primary", "place.inbox.review", "Review what needs you");
  review.addEventListener("click", () => displayView("inbox:needs"));
  const finished = button("lx-button", "place.inbox.seeFinished", "See what finished");
  finished.addEventListener("click", () => displayView("inbox:finished"));
  actions.append(review, finished);
  card.append(make("p", "lx-eyebrow", say("place.inbox.away", "While you were away")), line, actions);
  return card;
}

/* ---------- the settings window ---------- */
function buildSettings() {
  const shell = make("div", "lx-settings");
  shell.id = "settings-window";
  shell.hidden = true;
  const scrim = make("div", "lx-scrim");
  scrim.addEventListener("click", closeSettings);
  const win = make("div", "lx-settings-win");
  win.setAttribute("role", "dialog");
  win.setAttribute("aria-modal", "true");
  win.setAttribute("aria-label", say("settings.title", "Settings"));
  const nav = make("nav", "lx-settings-nav");
  nav.setAttribute("aria-label", say("settings.pages", "Settings pages"));
  nav.append(worded("p", "lx-eyebrow lx-settings-eyebrow", "settings.title", "Settings"), settingsSearch());
  const body = make("div", "lx-settings-body");
  body.id = "lx-settings-body";
  const close = make("button", "lx-icon-button lx-settings-close");
  close.type = "button";
  close.setAttribute("aria-label", say("settings.close", "Close settings"));
  close.append(icon("close"));
  close.addEventListener("click", closeSettings);
  for (const [id, key, english, intro] of SETTINGS_PAGES) {
    const link = button("lx-settings-link", key, english);
    link.dataset.page = id;
    link.addEventListener("click", () => showSettingsPage(id));
    nav.append(link);
    const page = make("section", "lx-page");
    page.id = `lx-page-${id}`;
    page.dataset.page = id;
    page.hidden = true;
    page.append(worded("h2", "lx-page-title", key, english), make("p", "lx-page-intro", intro));
    body.append(page);
  }
  win.append(nav, body, close);
  shell.append(scrim, win);
  document.body.append(shell);
  buildModelTabs();
  buildAppearanceBlock();
}
function settingsSearch() {
  const wrap = make("label", "lx-search");
  wrap.append(icon("search"));
  const input = make("input");
  input.id = "lx-settings-search";
  input.type = "search";
  input.autocomplete = "off";
  input.placeholder = say("settings.search", "Search settings");
  input.dataset.tPlaceholder = "settings.search";
  input.setAttribute("aria-label", input.placeholder);
  input.addEventListener("input", () => searchSettings(input.value));
  wrap.append(input);
  return wrap;
}
function buildModelTabs() {
  const page = $("lx-page-models");
  const tabs = make("div", "lx-subtabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Models");
  page.append(tabs);
  for (const [id, key, english] of MODEL_TABS) {
    const trigger = button("lx-subtab", key, english);
    trigger.setAttribute("role", "tab");
    trigger.dataset.sub = id;
    trigger.addEventListener("click", () => showModelTab(id));
    tabs.append(trigger);
    const panel = make("div", "lx-subpanel");
    panel.id = `lx-models-${id}`;
    panel.dataset.sub = id;
    panel.setAttribute("role", "tabpanel");
    page.append(panel);
  }
  showModelTab("connection");
}
function showModelTab(id) {
  for (const node of document.querySelectorAll("#lx-page-models [data-sub]")) {
    if (node.classList.contains("lx-subtab")) node.setAttribute("aria-selected", String(node.dataset.sub === id));
    else node.hidden = node.dataset.sub !== id;
  }
}
/** The 44 themes, light or dark, the season and contrast, above the existing reading controls. */
function buildAppearanceBlock() {
  const block = make("div", "lx-look");
  const head = make("div", "lx-group-head");
  const count = make("span", "lx-count");
  count.id = "lx-theme-count";
  head.append(worded("h3", "", "look.theme", "Theme"), count);
  const gallery = make("div", "lx-gallery");
  gallery.id = "lx-theme-gallery";
  const modeRow = lookRow("look.mode", "Light and dark", "lx-mode");
  const seasonRow = lookRow("look.season", "The oak's season", "lx-season");
  const contrastRow = make("label", "check-row lx-contrast-row");
  const contrast = make("input");
  contrast.type = "checkbox";
  contrast.id = "lx-contrast";
  contrast.addEventListener("change", () => setLook({ contrast: contrast.checked ? "more" : "standard" }));
  contrastRow.append(contrast, worded("span", "", "look.contrast", "More contrast between text and background"));
  block.append(head, gallery, modeRow, seasonRow, contrastRow);
  $("lx-page-appearance").append(block);
}
function lookRow(key, english, hostId) {
  const row = make("div", "lx-look-row");
  const host = make("div");
  host.id = hostId;
  row.append(worded("span", "lx-look-label", key, english), host);
  return row;
}
function openSettings(page) {
  if ($("workspace").hidden) return;
  $("settings-window").hidden = false;
  document.body.classList.add("lx-settings-open");
  showSettingsPage(page || settingsPage);
  $("lx-settings-search").value = "";
  searchSettings("");
}
function closeSettings() {
  const win = $("settings-window");
  if (win.hidden) return;
  win.hidden = true;
  document.body.classList.remove("lx-settings-open");
}
function showSettingsPage(id) {
  settingsPage = id;
  for (const page of document.querySelectorAll(".lx-page")) page.hidden = page.dataset.page !== id;
  for (const link of document.querySelectorAll(".lx-settings-link"))
    link.setAttribute("aria-current", String(link.dataset.page === id));
  $("lx-settings-body").scrollTop = 0;
  if (id === "data") void globalThis.branchUsage?.render().then(() => globalThis.branchAllowed?.render());
  if (id === "appearance") drawLookControls();
}
/** Search reads every card's own words, so it finds a setting by what it says, not by where it sits. */
function searchSettings(query) {
  const needle = query.trim().toLowerCase();
  document.body.classList.toggle("lx-settings-searching", Boolean(needle));
  let found = 0;
  for (const page of document.querySelectorAll(".lx-page")) {
    let hits = 0;
    for (const card of page.querySelectorAll(".lx-subpanel > *, .lx-page > *:not(.lx-page-title):not(.lx-page-intro):not(.lx-subtabs):not(.lx-subpanel)")) {
      const match = !needle || card.textContent.toLowerCase().includes(needle);
      card.classList.toggle("lx-miss", !match);
      if (match && needle) hits += 1;
    }
    if (needle) page.hidden = hits === 0;
    found += hits;
    const link = document.querySelector(`.lx-settings-link[data-page="${page.dataset.page}"]`);
    link.dataset.hits = needle ? String(hits) : "";
    link.classList.toggle("lx-miss", Boolean(needle) && hits === 0);
  }
  if (needle) {
    for (const panel of document.querySelectorAll(".lx-subpanel")) panel.hidden = false;
    $("lx-settings-empty")?.remove();
    if (!found) $("lx-settings-body").append(Object.assign(make("p", "lx-empty", say("settings.nothing", "No setting says that. Try another word.")), { id: "lx-settings-empty" }));
  } else {
    $("lx-settings-empty")?.remove();
    showSettingsPage(settingsPage);
    showModelTab(document.querySelector("#lx-page-models .lx-subtab[aria-selected='true']")?.dataset.sub || "connection");
  }
}

/* ---------- moving the existing panels ---------- */
function moveAll() {
  for (const [id, slot] of MOVES) moveInto(id, slot);
  /* Usage was a page of its own; inside Settings it is simply shown whenever its page is. */
  $("usage").classList.remove("view");
  $("usage").hidden = false;
  collabSlots();
  const made = $("gallery-list")?.closest(".card");
  if (made) $("lx-slot-library-made").append(made);
  moveCollab();
  new MutationObserver(moveCollab).observe($("collab-container"), { childList: true });
  /* Anything a module adds to the old Settings page later still finds a home. */
  const leftovers = $("settings");
  leftovers.classList.remove("view");
  leftovers.hidden = false;
  leftovers.classList.add("lx-leftovers");
  leftovers.querySelector(":scope > p")?.classList.add("lx-superseded");
  $("lx-page-advanced").append(leftovers);
  new MutationObserver(() => { for (const [id, slot] of MOVES) moveInto(id, slot); })
    .observe(leftovers, { childList: true });
}
function moveInto(id, slot) {
  const node = $(id), host = $(slot);
  if (!node || !host || node.parentElement === host) return;
  host.append(node);
}
/* The collaboration panel is drawn again on every refresh, so its parts are sent home each time. */
function moveCollab() {
  const homes = { labels: "lx-collab-labels", "days-off": "lx-collab-days-off", shares: "lx-collab-people", people: "lx-collab-people" };
  const panel = $("collab-container")?.querySelector(".collab-panel");
  if (!panel) return;
  for (const [part, slot] of Object.entries(homes)) {
    const node = panel.querySelector(`:scope > [data-part="${part}"]`);
    const host = $(slot);
    if (!node || !host) continue;
    host.querySelector(`:scope > [data-part="${part}"]`)?.remove();
    host.append(node);
  }
}
function collabSlots() {
  const labels = make("div", "lx-collab");
  labels.id = "lx-collab-labels";
  const people = make("div", "lx-collab");
  people.id = "lx-collab-people";
  $("lx-page-general").append(labels, people);
  const days = make("div", "lx-collab");
  days.id = "lx-collab-days-off";
  $("lx-page-notifications").append(days);
}

/* ---------- going somewhere ---------- */
/** Called by displayView in public/app.js. Returns false for a name it does not know. */
function go(view) {
  const route = ROUTES[view];
  if (!route) return false;
  setQuiet(false);
  if (route.settings !== undefined) {
    document.body.classList.remove("rail-open");
    openSettings(route.settings);
    announce(view);
    return true;
  }
  closeSettings();
  showPlace(route.place, route.tab);
  announce(view);
  return true;
}
function showPlace(next, tab) {
  /* Leaving the Inbox counts as having read it. */
  if (place === "inbox" && next !== "inbox") store.set(SEEN, String(Date.now()));
  place = next;
  if (tab) lastTab[next] = tab;
  for (const node of document.querySelectorAll("#workspace > .view")) node.hidden = node.id !== next;
  for (const panel of document.querySelectorAll(".lx-panel")) {
    const on = panel.dataset.place === next && panel.dataset.tab === lastTab[next];
    if (panel.hidden === on) panel.hidden = !on;
  }
  for (const trigger of document.querySelectorAll(".lx-tab"))
    trigger.setAttribute("aria-selected", String(trigger.dataset.place === next && trigger.dataset.tab === lastTab[next]));
  for (const row of document.querySelectorAll(".lx-place-link"))
    row.setAttribute("aria-current", row.dataset.place === next ? "page" : "false");
  const spec = PLACES[next];
  $("page-title").textContent = spec ? say(spec.key, spec.english) : say("nav.chat", titles.chat);
  const crumb = spec?.tabs.find(([id]) => id === lastTab[next]);
  $("lx-crumb").textContent = crumb ? say(crumb[1], crumb[2]) : "";
  $("thread-name").hidden = next !== "chat";
  document.body.classList.toggle("lx-chat", next === "chat");
  document.body.classList.remove("rail-open", "lx-pane-float");
  if (next === "inbox") void drawInbox();
  syncPane();
}
/** Modules that load their screen when it opens listen for this instead of a click on an old button. */
function announce(view) {
  document.dispatchEvent(new CustomEvent("branch-place", { detail: { view, place, tab: lastTab[place], page: settingsPage } }));
}

/* ---------- the sidebar ---------- */
function buildRail() {
  const group = document.querySelector('.rail-group[data-group="sections"]');
  group.classList.add("lx-places");
  const nav = $("sections-nav");
  for (const id of Object.keys(PLACES)) {
    const spec = PLACES[id];
    const row = button("lx-place-link", spec.key, spec.english);
    iconAndWords(row, id);
    row.dataset.place = id;
    if (id === "inbox") row.append(Object.assign(make("span", "lx-badge"), { id: "lx-inbox-badge", hidden: true }));
    row.addEventListener("click", () => displayView(`${id}:${lastTab[id]}`));
    nav.append(row);
  }
  /* The old Settings button becomes the gear beside search; the old Conversation button the way back. */
  const gear = document.querySelector('.nav[data-view="settings"]');
  iconAndWords(gear, "settings");
  gear.className = "rail-icon lx-gear";
  gear.id = "rail-settings";
  gear.querySelector(".lx-words").classList.add("sr-only");
  $("appearance-shortcut").after(gear);
  const back = document.querySelector('.nav[data-view="chat"]');
  iconAndWords(back, "back");
  back.className = "lx-back";
  $("rail-toggle").after(back);
  const crumb = make("span", "lx-crumb");
  crumb.id = "lx-crumb";
  $("page-title").after(crumb);
  document.querySelector('.nav[data-view="usage"]')?.remove();
}
/* ---------- the title bar: the side pane, clear the view, lockdown ---------- */
const PANE_TABS = [["activity", "pane.activity", "Activity"], ["plan", "pane.plan", "Plan"], ["files", "pane.files", "Files"], ["memory", "pane.memory", "Memory"]];
let paneTab = store.get("branch-pane-tab") || "activity";
function buildTitleBar() {
  const seg = make("div", "lx-pane-tabs");
  seg.id = "lx-pane-tabs";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", say("pane.label", "Side pane"));
  for (const [id, key, english] of PANE_TABS) {
    const trigger = button("lx-pane-tab", key, english);
    iconAndWords(trigger, id);
    trigger.dataset.pane = id;
    trigger.addEventListener("click", () => choosePaneTab(id));
    seg.append(trigger);
  }
  const clear = make("button", "head-icon lx-clear");
  clear.type = "button";
  clear.id = "lx-clear";
  clear.setAttribute("aria-label", say("look.clear", "Clear the view"));
  clear.title = clear.getAttribute("aria-label");
  clear.append(icon("eye"));
  clear.addEventListener("click", () => setQuiet(true));
  const shield = make("button", "head-icon lx-shield");
  shield.type = "button";
  shield.id = "lx-shield";
  shield.setAttribute("aria-haspopup", "dialog");
  shield.setAttribute("aria-expanded", "false");
  shield.setAttribute("aria-label", say("lockdown.label", "Lockdown"));
  shield.title = shield.getAttribute("aria-label");
  shield.append(icon("shield"));
  $("connection").before(seg, clear, shield);
  buildLockdown(shield);
}
/* On a narrow window the pane floats over the conversation, so it starts closed and opens only when asked. */
const narrow = matchMedia("(max-width: 1180px)");
const paneOpen = () => narrow.matches
  ? document.body.classList.contains("lx-pane-float")
  : !document.body.classList.contains("no-aside");
function choosePaneTab(id) {
  const open = paneOpen();
  if (narrow.matches) document.body.classList.toggle("lx-pane-float", !(open && paneTab === id));
  else if (!open || paneTab === id) $("aside-toggle").click();
  paneTab = id;
  store.set("branch-pane-tab", id === "activity" ? null : id);
  syncPane();
}
function tagPaneBlocks() {
  const homes = { "context-provider": "activity", "context-working": "activity", "context-tasks": "activity", "context-allowed": "activity",
    "context-todos": "plan", "context-receipts": "files", "context-apps": "files", "context-facts": "memory" };
  for (const [id, tab] of Object.entries(homes)) {
    const block = $(id)?.closest(".context-block");
    if (block) block.dataset.pane = tab;
  }
  document.querySelector(".context-stats").dataset.pane = "memory";
  const head = make("div", "lx-pane-head");
  head.append(make("strong", "lx-pane-name"));
  $("context-panel").prepend(head);
}
/** The pane belongs to the conversation: shown there when open, or anywhere while help is being read. */
function syncPane() {
  const panel = $("context-panel");
  panel.dataset.pane = paneTab;
  const helping = !$("context-help").hidden;
  const open = paneOpen();
  document.body.classList.toggle("lx-aside", helping || (place === "chat" && open));
  document.body.classList.toggle("lx-help", helping);
  for (const trigger of document.querySelectorAll(".lx-pane-tab"))
    trigger.setAttribute("aria-pressed", String(open && trigger.dataset.pane === paneTab));
  const tab = PANE_TABS.find(([id]) => id === paneTab);
  panel.querySelector(".lx-pane-name").textContent = helping ? say("help.title", "Help") : say(tab[1], tab[2]);
}
function setQuiet(on) {
  if (on) root.dataset.quiet = "1";
  else delete root.dataset.quiet;
}
function buildQuiet() {
  const exit = make("button", "lx-quiet-exit");
  exit.type = "button";
  exit.id = "lx-quiet-exit";
  exit.tabIndex = -1;
  exit.setAttribute("aria-label", say("look.bringBack", "Bring the window back"));
  exit.addEventListener("click", () => setQuiet(false));
  const hint = worded("p", "lx-quiet-hint", "look.quietHint", "Click anywhere or press Escape");
  document.body.append(exit, hint);
}
/** The Lockdown switch moves from the sidebar into a popover under the shield, with a banner while it is on. */
function buildLockdown(shield) {
  const pop = make("div", "lx-pop lx-lock-pop");
  pop.id = "lx-lock-pop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", say("lockdown.label", "Lockdown"));
  pop.append(worded("p", "lx-eyebrow", "lockdown.label", "Lockdown"), $("lockdown-panel"));
  shield.after(pop);
  shield.addEventListener("click", (event) => {
    event.stopPropagation();
    pop.hidden = !pop.hidden;
    shield.setAttribute("aria-expanded", String(!pop.hidden));
  });
  pop.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => {
    pop.hidden = true;
    shield.setAttribute("aria-expanded", "false");
  });
  const banner = make("div", "lx-lockbanner");
  banner.id = "lx-lockbanner";
  banner.hidden = true;
  banner.setAttribute("role", "status");
  const off = button("lx-button", "lockdown.turnOff", "Turn it off");
  off.addEventListener("click", () => $("lockdown-panel").querySelector("button")?.click());
  banner.append(icon("shield"), worded("span", "", "lockdown.on", "Lockdown is on. Everything waits for your yes."), off);
  document.querySelector("main > header").after(banner);
  const sync = () => {
    const on = $("lockdown-panel").querySelector("button")?.getAttribute("aria-pressed") === "true";
    shield.setAttribute("aria-pressed", String(on));
    banner.hidden = !on;
    document.body.classList.toggle("lx-locked", on);
  };
  new MutationObserver(sync).observe($("lockdown-panel"), { childList: true, subtree: true, attributes: true });
  sync();
}

/* ---------- the owner menu and the message box ---------- */
function buildOwnerMenu() {
  const menu = $("owner-menu");
  const row = make("div", "lx-quick-row");
  row.id = "lx-quick-themes";
  row.addEventListener("click", (event) => event.stopPropagation());
  const all = button("lx-menu-link", "look.allThemes", "All 44 themes…");
  all.setAttribute("role", "menuitem");
  all.addEventListener("click", () => displayView("settings:appearance"));
  menu.prepend(worded("p", "menu-note", "look.theme", "Theme"), row, all, make("hr", "lx-menu-rule"));
  $("menu-settings").dataset.t = "menu.settingsShort";
  $("menu-settings").textContent = say("menu.settingsShort", "Settings");
  $("menu-settings").append(make("kbd", "lx-kbd", "Ctrl ,"));
}
function buildModelChip() {
  const bar = $("composer-media")?.parentElement;
  if (!bar) return;
  const chip = make("button", "lx-model-chip");
  chip.type = "button";
  chip.id = "lx-model-chip";
  chip.title = say("composer.changeModel", "Change the model");
  const dot = make("span", "lx-model-dot");
  const name = make("span", "lx-model-name");
  chip.append(dot, name);
  chip.addEventListener("click", () => displayView("settings:models"));
  bar.prepend(chip);
  const sync = () => {
    name.textContent = $("context-provider").textContent.trim() || say("composer.noModel", "Connect a model");
    chip.dataset.connected = $("context-panel").dataset.connected;
  };
  new MutationObserver(sync).observe($("context-provider"), { childList: true, characterData: true, subtree: true });
  new MutationObserver(sync).observe($("context-panel"), { attributes: true, attributeFilter: ["data-connected"] });
  sync();
}

/* ---------- Inbox: what needs you, what finished ---------- */
const SEEN = "branch-inbox-seen";
const waitingRun = (run) => /waiting|approval/.test(run.status);
function runRow(run) {
  const row = make("div", "lx-row");
  const words = make("div", "lx-row-words");
  words.append(make("strong", "", (run.prompt || "Task").slice(0, 140)), make("span", "lx-row-meta", new Date(run.updatedAt || run.createdAt).toLocaleString()));
  const chip = make("span", `lx-chip lx-chip-${run.status === "completed" ? "ok" : waitingRun(run) ? "warn" : run.status === "failed" ? "bad" : "idle"}`, run.status.replace(/_/g, " "));
  const actions = make("div", "lx-row-actions");
  if (globalThis.branchInspector) {
    const inspect = button("lx-button", "place.inbox.lookInside", "Look inside");
    inspect.addEventListener("click", () => globalThis.branchInspector.open(run.id));
    actions.append(inspect);
  }
  if (run.sessionId) {
    const open = button("lx-button", "place.inbox.openConversation", "Open the conversation");
    open.addEventListener("click", async () => {
      displayView("chat");
      try { await openConversation(run.sessionId); } catch (error) { globalThis.toast?.(error.message); }
    });
    actions.append(open);
  }
  row.append(words, chip, actions);
  return row;
}
function fillList(host, runs, emptyKey, emptyEnglish) {
  host.replaceChildren(...runs.map(runRow));
  if (!runs.length && emptyKey) host.append(worded("p", "lx-empty", emptyKey, emptyEnglish));
}
let inboxBusy = false;
async function drawInbox() {
  if (inboxBusy || $("workspace").hidden) return;
  inboxBusy = true;
  try {
    const state = await api("state");
    const runs = [...(state.runs ?? [])].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    const waiting = runs.filter(waitingRun);
    const week = Date.now() - 7 * 86400000;
    const finished = runs.filter((run) => /completed|failed|interrupted/.test(run.status) && Date.parse(run.updatedAt || run.createdAt) > week);
    const approvals = $("policy-waiting")?.children.length ?? 0;
    fillList($("lx-needs-list"), waiting, approvals ? null : "place.inbox.nothingWaits", "Nothing needs you right now.");
    fillList($("lx-finished-list"), finished.slice(0, 30), "place.inbox.nothingFinished", "Nothing finished in the last seven days.");
    const count = waiting.length + approvals;
    $("lx-inbox-badge").hidden = !count;
    $("lx-inbox-badge").textContent = String(count);
    drawAway(runs, count);
  } catch {
    /* not connected yet; the next look fills it in */
  } finally {
    inboxBusy = false;
  }
}
function drawAway(runs, count) {
  const seen = Number(store.get(SEEN) || 0);
  const since = runs.filter((run) => /completed|failed/.test(run.status) && Date.parse(run.updatedAt || run.createdAt) > seen).length;
  $("lx-away").hidden = !seen || (!since && !count);
  const parts = [];
  if (since) parts.push(since === 1 ? "1 task finished" : `${since} tasks finished`);
  if (count) parts.push(count === 1 ? "1 thing needs your yes" : `${count} things need your yes`);
  $("lx-away-line").textContent = parts.join(", and ") + ".";
  if (!seen) store.set(SEEN, String(Date.now()));
}
function buildInboxLists() {
  const needs = make("div", "lx-list");
  needs.id = "lx-needs-list";
  $("lx-slot-inbox-needs").prepend(needs);
  const finished = make("div", "lx-list");
  finished.id = "lx-finished-list";
  $("lx-slot-inbox-finished").append(finished);
}
/** The small count and the moving ring say something is working or waiting, whatever page is open. */
function watchWork() {
  const badge = $("activity-count");
  const sync = () => {
    const running = badge && !badge.hidden && Number(badge.textContent) > 0;
    document.body.classList.toggle("lx-working", Boolean(running));
    document.body.classList.toggle("lx-waiting", !$("lx-inbox-badge").hidden);
  };
  if (badge) new MutationObserver(sync).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
  new MutationObserver(sync).observe($("lx-inbox-badge"), { attributes: true, attributeFilter: ["hidden"] });
  setInterval(() => { if (!document.hidden) void drawInbox(); }, 8000);
}

/* ---------- keyboard and the buttons that used to open the long Settings page ---------- */
function wireKeys() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && root.dataset.quiet) { setQuiet(false); return; }
    if (event.key === "Escape" && !$("settings-window").hidden && ($("cmd")?.hidden ?? true)) {
      if (document.activeElement?.id === "lx-settings-search" && document.activeElement.value) return;
      closeSettings();
      return;
    }
    if (event.key === "Escape" && !$("lx-lock-pop").hidden) $("lx-lock-pop").hidden = true;
    if (event.key === "Escape" && document.body.classList.contains("lx-pane-float")) document.body.classList.remove("lx-pane-float");
  });
  const after = (id, view) => $(id)?.addEventListener("click", () => displayView(view));
  after("appearance-shortcut", "settings:appearance");
  after("menu-appearance", "settings:appearance");
  after("context-change-model", "settings:models");
  after("context-connect", "settings:models");
  after("menu-updates", "settings:about");
  after("menu-about", "settings:about");
  after("door-key", "settings:models");
  new MutationObserver(syncPane).observe($("context-help"), { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(syncPane).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(applyLook).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  narrow.addEventListener("change", () => { document.body.classList.remove("lx-pane-float"); syncPane(); });
  $("appearance-follow")?.addEventListener("change", drawLookControls);
  new MutationObserver(() => { if ($("workspace").hidden) closeSettings(); })
    .observe($("workspace"), { attributes: true, attributeFilter: ["hidden"] });
  /* The old Forest/Daylight list and the five highlight colours are now the theme gallery and its mode. */
  for (const id of ["appearance", "accent-choices"]) $(id)?.closest(".appearance-field")?.classList.add("lx-superseded");
}
/** The palette offers the new places and every settings page by name. */
function extendPalette() {
  for (const [id, spec] of Object.entries(PLACES)) {
    titles[id] = spec.english;
    for (const [tab, , english] of spec.tabs) if (!spec.tabs.find((row) => row[3] && row[0] === tab)) titles[`${id}:${tab}`] = `${spec.english} › ${english}`;
  }
  for (const [page, , english] of SETTINGS_PAGES) titles[`settings:${page}`] = `Settings › ${english}`;
}

/* ---------- start ---------- */
function start() {
  buildRail();
  for (const [id, spec] of Object.entries(PLACES)) buildPlace(id, spec);
  buildInboxLists();
  buildSettings();
  moveAll();
  buildTitleBar();
  tagPaneBlocks();
  buildQuiet();
  buildOwnerMenu();
  buildModelChip();
  wireKeys();
  extendPalette();
  globalThis.branchLayout = { go, reveal };
  applyLook();
  const open = [...document.querySelectorAll("#workspace > .view")].find((node) => !node.hidden)?.id || "chat";
  go(open === "settings" ? "chat" : open);
  watchWork();
  void drawInbox();
  document.body.classList.add("lx", "lx-ready");
}
/** Opens whichever place, tab and settings page holds an element, so a link can point at any setting. */
function reveal(target) {
  const node = typeof target === "string" ? $(target) : target;
  if (!node) return false;
  const page = node.closest(".lx-page");
  if (page) {
    openSettings(page.dataset.page);
    const sub = node.closest(".lx-subpanel");
    if (sub) showModelTab(sub.dataset.sub);
  } else {
    const panel = node.closest(".lx-panel");
    if (panel) go(`${panel.dataset.place}:${panel.dataset.tab}`);
    else if (node.closest("#chat")) go("chat");
  }
  node.scrollIntoView({ block: "nearest" });
  return true;
}
start();

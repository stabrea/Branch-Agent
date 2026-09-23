/* Branch Agent's window, rebuilt (wave 9 redesign, approved by the owner on 2026-09-16).

   Five places instead of ten pages: the conversation, Inbox, Automations, Library and Customize, and
   Settings as a floating window of short pages. Nothing is rewritten here. Every panel keeps its
   id and the module that fills it, and is moved by id into the place it now belongs (see MOVES), so
   the forty-odd modules that bind to those ids keep working untouched.

   The window wears the 44 KeepOak themes as glass over a pixel oak: theme-catalogue.js holds each
   theme's finished colours, theme-bridge.js hands them to Branch's own token names, grove.js paints the oak.
   public/app.js calls go() from displayView, so every existing way of opening a page still lands. */
import { api, displayView, openConversation, ownerAtWindow, titles } from "/app.js";
import { openPalette } from "/shell.js";
import { t } from "/i18n.js";
import { THEMES, THEME_GROUPS } from "/theme-catalogue.js";
import { DEFAULT_THEME, solid, surfaceOf, themeById, tokensFor, wearTokens } from "/theme-bridge.js";
import { paint as paintGrove, seasonToday } from "/grove.js";
import { popover } from "/popover.js";
import { installGrownComposer } from "/composer-grown.js";

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
  up: "M12 19V5M6 11l6-6 6 6",
  plus: "M12 5v14M5 12h14",
  stop: "M7 7h10v10H7z",
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
  // phase2/panels: the side panel's Browser and Terminal tabs
  browser: "M12 3a9 9 0 110 18 9 9 0 010-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  terminal: "M4 5h16v14H4zM7 10l3 2-3 2M12 15h5",
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
  family: store.get("branch-palette") || DEFAULT_THEME,
  season: store.get("branch-season") || "",
  contrast: store.get("branch-contrast") === "more" ? "more" : "standard",
};
const SEASONS = [["", "look.season.today", "Today"], ["spring", "look.season.spring", "Spring"],
  ["summer", "look.season.summer", "Summer"], ["autumn", "look.season.autumn", "Autumn"], ["winter", "look.season.winter", "Winter"]];
const QUICK = ["slate", "forest", "nocturne", "cherry", "ocean", "lavender", "sepia", "mono"];
const modeNow = () => (root.dataset.theme === "daylight" ? "light" : "dark");
function applyLook() {
  const family = themeById(look.family), mode = modeNow();
  const tokens = tokensFor(family, mode, look.contrast);
  wearTokens(root, family, tokens);
  root.style.setProperty("--surface", surfaceOf(tokens, mode));
  paintGrove({ mode, season: look.season || seasonToday() });
  drawLookControls();
}
function setLook(patch) {
  Object.assign(look, patch);
  /* A picked theme is written down even when it is the default, so a later change of default never
     takes it away (redesign phase 1: Slate became the default; a chosen Forest stays Forest). */
  if (patch.family) store.set("branch-palette", patch.family);
  store.set("branch-season", look.season || null);
  store.set("branch-contrast", look.contrast === "more" ? "more" : null);
  applyLook();
}
/**
 * DG-037: the sample's theme tile (its live `tilesHTML`): a window in miniature, with the theme's rail, a surface
 * holding a strong and a quiet line of text, and its accent, drawn with the sample's own blends. Under it, the name
 * and the sample's words: Default on Slate, High contrast at 14:1 in the light shown, Easy in daylight at 14:1 there.
 */
function themeTile(family, onPick) {
  const mode = modeNow(), dark = mode === "dark", tokens = tokensFor(family, mode);
  const ground = tokens["--ground"], text = tokens["--text"];
  const tile = make("button", "lx-tile");
  tile.type = "button";
  tile.dataset.family = family[0];
  tile.setAttribute("aria-pressed", String(look.family === family[0]));
  const ratio = textContrast(family, mode), daylight = textContrast(family, "light");
  tile.title = say("look.tile.title", "{name} · text contrast {ratio} to 1 ({light}), {daylight} to 1 in Daylight")
    .replace("{name}", family[1]).replace("{ratio}", ratio.toFixed(1))
    .replace("{light}", dark ? say("look.moonlight", "Moonlight") : say("look.daylight", "Daylight"))
    .replace("{daylight}", daylight.toFixed(1));
  const mini = make("span", "lx-mini");
  mini.style.background = ground;
  const rail = make("u");
  rail.style.background = dark ? solid(ground, "#000000", 0.4) : solid(text, ground, 0.08);
  const pane = make("i");
  pane.style.background = dark ? solid(ground, text, 0.045) : solid(ground, "#ffffff", 0.62);
  const strong = make("em"), quiet = make("em"), accent = make("s");
  strong.style.width = "58%";
  strong.style.background = text;
  quiet.style.width = "38%";
  quiet.style.background = tokens["--text-3"];
  accent.style.background = tokens["--copper"];
  pane.append(strong, quiet, accent);
  mini.append(rail, pane);
  const foot = make("span", "lx-tile-foot");
  /* The button is named by the theme alone; its words describe it (so "Cherry" still finds Cherry). */
  const name = make("b", "lx-tile-name", family[1]);
  name.id = `lx-tile-name-${family[0]}`;
  tile.setAttribute("aria-labelledby", name.id);
  foot.append(name);
  const badge = ratio >= 14 ? ["look.badge.high", "High contrast"]
    : daylight >= 14 && !dark ? ["look.badge.daylight", "Easy in daylight"] : null;
  const described = [];
  for (const word of [family[0] === DEFAULT_THEME ? ["look.badge.default", "Default"] : null, badge].filter(Boolean)) {
    const small = worded("small", "lx-tile-badge", ...word);
    small.id = `lx-tile-${word[0].split(".").pop()}-${family[0]}`;
    described.push(small.id);
    foot.append(small);
  }
  if (described.length) tile.setAttribute("aria-describedby", described.join(" "));
  tile.append(mini, foot);
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
/** A choice with a sign before its word. The word alone names it, and alone is re-worded when the language changes. */
function signedChoice(sign, key, english) {
  const choice = make("button", "segmented-option");
  choice.type = "button";
  const mark = make("span", "seg-sign", sign);
  mark.setAttribute("aria-hidden", "true");
  choice.append(mark, " ", worded("span", "", key, english));
  return choice;
}
/** The choices are named by the row's own label (by id), so a language change re-words their name with it. */
function segmented(labelId, options, isOn, onPick) {
  const group = make("div", "seg");
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", labelId);
  for (const [value, key, english, sign] of options) {
    const choice = sign ? signedChoice(sign, key, english) : button("segmented-option", key, english);
    choice.setAttribute("aria-pressed", String(isOn(value)));
    choice.addEventListener("click", () => onPick(value));
    group.append(choice);
  }
  return group;
}
/* DG-035/DG-036: the sample's search and filter chips above the tiles. The words typed and the chip
   chosen live here, so redrawing the tiles (a new light, a new theme) keeps them. */
let themeQuery = "", themeFilter = "all";
/** How strongly a theme's text stands out from its ground, as the sample measures it for its chips. */
function textContrast(family, mode) {
  const tokens = tokensFor(family, mode);
  const light = (hex) => {
    if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) return null;
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = light(tokens["--text"]), b = light(tokens["--ground"]);
  return a === null || b === null ? 0 : (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** The sample's filters (its effective, later `tilesHTML`): a group, 14:1 in daylight, or 14:1 in the light shown now. */
function themeShown(family) {
  if (themeQuery && !family[1].toLowerCase().includes(themeQuery)) return false;
  if (themeFilter === "lightok") return textContrast(family, "light") >= 14;
  if (themeFilter === "high") return textContrast(family, modeNow()) >= 14;
  return themeFilter === "all" || family[2] === themeFilter;
}
function drawThemeTiles() {
  const gallery = $("lx-theme-gallery");
  if (!gallery) return;
  gallery.replaceChildren();
  let shown = 0;
  for (const [id, name] of THEME_GROUPS) {
    const families = THEMES.filter((item) => item[2] === id && themeShown(item));
    if (!families.length) continue;
    shown += families.length;
    gallery.append(make("p", "lx-eyebrow", name));
    const grid = make("div", "lx-tiles");
    for (const family of families) grid.append(themeTile(family, (value) => setLook({ family: value })));
    gallery.append(grid);
  }
  if (!shown) gallery.append(worded("p", "lx-theme-none", "look.search.none", "No theme matches. Try All, or a shorter name."));
  const results = $("lx-theme-results");
  /* The language's own plural rule: French says "0 thème", English "0 themes". */
  const single = new Intl.PluralRules(root.lang || "en").select(shown) === "one";
  if (results) results.textContent = single ? say("look.search.one", "1 theme").replace("1", String(shown))
    : say("look.search.results", "{count} themes").replace("{count}", String(shown));
  for (const chip of document.querySelectorAll("#lx-theme-chips .lx-fchip"))
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === themeFilter));
}
function drawLookControls() {
  if ($("lx-theme-gallery")) {
    drawThemeTiles();
    $("lx-theme-count").textContent = `${THEMES.length} · ${themeById(look.family)[1]}`;
  }
  const follow = $("appearance-follow")?.checked;
  const modeHost = $("lx-mode");
  /* DG-160: the sample's words, ☾ Moonlight and ☀ Daylight; the saved value is still dark or light. */
  if (modeHost) modeHost.replaceChildren(segmented("lx-mode-label",
    [["", "look.mode.follow", "Follow this computer"], ["dark", "look.moonlight", "Moonlight", "☾"], ["light", "look.daylight", "Daylight", "☀"]],
    (value) => (follow ? value === "" : !follow && value === modeNow()), chooseMode));
  const seasonHost = $("lx-season");
  if (seasonHost) seasonHost.replaceChildren(segmented("lx-season-label", SEASONS, (value) => value === look.season, (value) => setLook({ season: value })));
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
  // phase2/shell: two places reached from the Trunks strip (public/strip.js), not listed in the sidebar.
  overview: { key: "place.overview", english: "Overview", strip: true, intro: ["place.overview.intro", "What a computer or a Trunk is doing, in one screen."],
    tabs: [["here", "place.overview.here", "Overview"]] },
  household: { key: "place.household", english: "People", strip: true, intro: ["place.household.intro", "Everyone who uses Branch here, and what each may do."],
    tabs: [["people", "place.household.people", "People"]] },
};
const SETTINGS_PAGES = [
  ["general", "settings.page.general", "General", "How Branch starts and runs on this computer, your projects, and the people who use it."],
  ["assistant", "settings.page.assistant", "Assistant", "Who your assistant is, and how much it keeps and learns."],
  ["instructions", "settings.page.instructions", "Instructions & personality", "Plain files Branch reads before it works: who it is, who you are, and how you want things done."],
  ["appearance", "settings.page.appearance", "Appearance", "Every KeepOak theme, light or dark, with the oak in any season. Changes show behind this window as you pick."],
  ["notifications", "settings.page.notifications", "Notifications", "When Branch may interrupt you, and the days it should leave you alone."],
  ["models", "settings.page.models", "Models", "Which models your assistant uses, and how it signs in to them."],
  ["accounts", "settings.page.accounts", "Accounts", "Every sign-in and key Branch can use, which one answers, and what happens when one runs low."], // phase2/accounts
  ["voice", "settings.page.voice", "Voice", "Talking to your assistant and hearing it answer."],
  ["permissions", "settings.page.permissions", "Permissions", "What your assistant may do without asking, and how much it may do at once."],
  ["computer", "settings.page.computer", "Computer & browser", "What it may touch on this computer, in your browser and on your other machines."],
  ["secrets", "settings.page.secrets", "Secrets", "Keys and passwords your assistant may use, one item at a time."],
  ["data", "settings.page.data", "Data & usage", "What it costs, what is kept, and your safety copies."],
  ["advanced", "settings.page.advanced", "Advanced", "Tools for checking and fixing Branch."],
  ["about", "settings.page.about", "Updates & about", "Your version, and updates."],
  ["trunks", "settings.page.trunks", "Trunks & people", "Your own assistants, the computers they use, and the people who use Branch here."],
  ["channels", "settings.page.channels", "Chat apps & devices", "The chat apps, pages and devices that reach Branch."],
  ["connections", "settings.page.connections", "Connections", "Tool servers Branch uses, other AI tools using Branch, and your own accounts."],
  ["skills", "settings.page.skills", "Skills & plugins", "What your assistant can do: skills, specialists and plugins."],
  ["memory", "settings.page.memory", "Memory & library", "What it remembers, your documents and what it has made."],
  ["automations", "settings.page.automations", "Automations & inbox", "Work that runs by itself, and how Inbox keeps the record."],
];
const MODEL_TABS = [["connection", "settings.models.connection", "Connection"], ["defaults", "settings.models.defaults", "Defaults"],
  ["local", "settings.models.local", "On this computer"], ["second", "settings.models.second", "Second opinion"], ["media", "settings.models.media", "Pictures & sound"]];
const SETTINGS_DIRECTORY = {
  trunks: [
    ["trunks", "settingsDirectory.trunks", "Trunks", "settingsDirectory.trunks.line", "Create and change your own assistants.", "customize:specialists"],
    ["overview", "place.overview", "Overview", "settingsDirectory.overview.line", "See what this computer or a Trunk is doing.", "overview"],
    ["people", "place.household", "People", "settingsDirectory.people.line", "Manage the people who use Branch on this computer.", "household"],
  ],
  channels: [["channels", "settings.page.channels", "Chat apps & devices", "settingsDirectory.channels.line", "Set up chat apps, pages and devices that reach Branch.", "customize:channels"]],
  connections: [["connections", "settings.page.connections", "Connections", "settingsDirectory.connections.line", "Manage tool servers, app connections and your own connected accounts.", "customize:connections"]],
  skills: [
    ["skills", "place.customize.skills", "Skills", "settingsDirectory.skills.line", "Choose and inspect instructions for particular kinds of work.", "customize:skills"],
    ["specialists", "place.customize.specialists", "Specialists", "settingsDirectory.specialists.line", "Create and manage Trunks with their own jobs and character.", "customize:specialists"],
    ["plugins", "place.customize.plugins", "Plugins", "settingsDirectory.plugins.line", "Install and review add-ons from other tools and people.", "customize:plugins"],
  ],
  memory: [
    ["memory", "place.library.memory", "Memory", "settingsDirectory.memory.line", "Review what Branch remembers and how it learns.", "library:memory"],
    ["documents", "place.library.documents", "Documents", "settingsDirectory.documents.line", "Manage the documents Branch may use when it answers.", "library:documents"],
    ["made", "place.library.made", "Made for you", "settingsDirectory.made.line", "Open the pages, articles and widgets Branch made.", "library:made"],
  ],
  automations: [
    ["scheduled", "place.automations.scheduled", "Scheduled", "settingsDirectory.scheduled.line", "Manage work that runs at a particular time.", "automations:scheduled"],
    ["procedures", "place.automations.procedures", "Procedures", "settingsDirectory.procedures.line", "Manage saved ways of doing repeatable work.", "automations:procedures"],
    ["triggers", "place.automations.triggers", "Triggers", "settingsDirectory.triggers.line", "Manage work started by an outside event.", "automations:triggers"],
    ["needs", "place.inbox.needs", "Needs you", "settingsDirectory.needs.line", "Answer work waiting for your decision.", "inbox:needs"],
    ["history", "place.inbox.history", "History", "settingsDirectory.history.line", "Review what ran and how it ended.", "inbox:history"],
  ],
};
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
  ["health-card", "lx-page-advanced"], ["diagnostics-card", "lx-page-advanced"], ["activity-log-card", "lx-page-advanced"], ["developer-card", "lx-page-advanced"],
  ["updates-card", "lx-page-about"], ["problem-report-card", "lx-page-about"],
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
for (const [id, spec] of Object.entries(PLACES)) lastTab[id] ??= spec.tabs[0][0]; // phase2/shell
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
  // mac7/residuals: a page under the floating ask box keeps that much room at its end (--lx-ask-h).
  new ResizeObserver(() => {
    if (form.offsetHeight) document.documentElement.style.setProperty("--lx-ask-h", `${Math.ceil(form.offsetHeight)}px`);
  }).observe(form);
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

  // DG-001/DG-064: Add "Back to Branch" button with Esc chip
  const backBtn = make("button", "lx-settings-back");
  backBtn.type = "button";
  backBtn.append(icon("back"));
  backBtn.append(document.createTextNode("Back to Branch"));
  const escKbd = make("kbd");
  escKbd.textContent = "Esc";
  backBtn.append(escKbd);
  backBtn.addEventListener("click", closeSettings);
  nav.append(backBtn);

  // DG-002: Settings title with larger font
  const title = worded("h1", "lx-settings-title", "settings.title", "Settings");
  title.style.fontSize = "22px";
  nav.append(title);

  nav.append(settingsSearch());
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
    page.append(worded("h2", "lx-page-title", key, english),
      worded("p", "lx-page-intro", `settings.window.${id}.intro`, intro));
    body.append(page);
  }

  // DG-003: Add version line at the bottom of nav
  // Note: Version is set dynamically in openSettings() to avoid hardcoding
  const verDiv = make("div", "lx-settings-version");
  verDiv.id = "lx-settings-version";
  nav.append(verDiv);

  win.append(nav, body, close);
  shell.append(scrim, win);
  document.body.append(shell);
  buildModelTabs();
  buildAppearanceBlock();
}
/** Honest Settings directories for controls that live in Branch's full places. */
function buildSettingsDirectories() {
  for (const [page, entries] of Object.entries(SETTINGS_DIRECTORY)) {
    const host = $(`lx-page-${page}`);
    if (!host) continue;
    for (const [id, titleKey, title, lineKey, line, route] of entries)
      host.append(settingsDirectoryCard(page, id, titleKey, title, lineKey, line, route));
  }
  syncDirectoryButtons();
  document.addEventListener("branch-language", syncDirectoryButtons);
}
function settingsDirectoryCard(page, id, titleKey, title, lineKey, line, route) {
  const card = make("section", "card settings-directory-card");
  card.id = `settings-directory-${page}-${id}`;
  card.dataset.home = `settings:${page}`;
  const heading = worded("h3", "settings-directory-title", titleKey, title);
  heading.id = `${card.id}-title`;
  const description = worded("p", "settings-directory-line", lineKey, line);
  description.id = `${card.id}-description`;
  const words = make("div", "settings-directory-words");
  words.append(heading, description);
  const open = button("settings-directory-open", "settingsDirectory.open", "Open");
  open.dataset.route = route;
  open.setAttribute("aria-describedby", description.id);
  open.addEventListener("click", () => displayView(route));
  card.append(words, open);
  return card;
}
function syncDirectoryButtons() {
  for (const open of document.querySelectorAll(".settings-directory-open")) {
    const title = open.closest(".settings-directory-card")?.querySelector(".settings-directory-title")?.textContent ?? "";
    open.setAttribute("aria-label", `${say("settingsDirectory.open", "Open")} ${title}`.trim());
  }
}
function showOwnerSettings(owner) {
  const link = document.querySelector('.lx-settings-link[data-page="instructions"]');
  const page = $("lx-page-instructions");
  if (link) link.hidden = !owner;
  if (page && !owner) page.hidden = true;
  if (!owner && settingsPage === "instructions") showSettingsPage("general");
}
document.addEventListener("branch-profile", (event) => showOwnerSettings(event.detail?.owner !== false));
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
  const tools = themeTools();
  const gallery = make("div", "lx-gallery");
  gallery.id = "lx-theme-gallery";
  const modeRow = lookRow("look.dayOrNight", "Day or night", "lx-mode");
  modeRow.append(worded("p", "lx-look-note", "look.dayOrNight.note", "Every theme has both. Switching keeps the theme you chose."));
  const seasonRow = lookRow("look.season", "The oak's season", "lx-season");
  const contrastRow = make("label", "check-row lx-contrast-row");
  const contrast = make("input");
  contrast.type = "checkbox";
  contrast.id = "lx-contrast";
  contrast.addEventListener("change", () => setLook({ contrast: contrast.checked ? "more" : "standard" }));
  contrastRow.append(contrast, worded("span", "", "look.contrast", "More contrast between text and background"));
  block.append(head, tools, gallery, modeRow, seasonRow, contrastRow);
  $("lx-page-appearance").append(block);
}
/** The sample's `.theme-tools`: a search over the themes' names and one row of filter chips. */
const THEME_CHIPS = [["all", "look.filter.all", "All"], ["branch", "look.filter.branch", "Branch"],
  ["keepoak", "look.filter.keepoak", "KeepOak"], ["editors", "look.filter.editors", "Editors & terminals"],
  ["lightok", "look.filter.lightok", "Easy in daylight"], ["high", "look.filter.high", "High contrast"]];
function themeTools() {
  const tools = make("div", "lx-theme-tools");
  const field = make("label", "lx-search lx-theme-search");
  field.append(icon("search"));
  const input = make("input");
  input.id = "lx-theme-search";
  input.type = "search";
  input.autocomplete = "off";
  input.placeholder = say("look.search", "Search {count} themes").replace("{count}", String(THEMES.length));
  input.setAttribute("aria-label", say("look.search.label", "Search themes"));
  input.setAttribute("aria-describedby", "lx-theme-results");
  input.addEventListener("input", () => { themeQuery = input.value.trim().toLowerCase(); drawThemeTiles(); });
  field.append(input);
  const chips = make("div", "lx-theme-chips");
  chips.id = "lx-theme-chips";
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", say("look.filter", "Show"));
  /* A group chip appears only for a group Branch really has (the sample's Branch group is DG-038's). */
  const groups = new Set(THEME_GROUPS.map(([id]) => id));
  for (const [value, key, english] of THEME_CHIPS) {
    if (!["all", "lightok", "high"].includes(value) && !groups.has(value)) continue;
    const chip = button("lx-fchip", key, english);
    chip.dataset.filter = value;
    chip.setAttribute("aria-pressed", String(value === themeFilter));
    chip.addEventListener("click", () => { themeFilter = value; drawThemeTiles(); });
    chips.append(chip);
  }
  const results = make("p", "sr-only");
  results.id = "lx-theme-results";
  results.setAttribute("role", "status");
  tools.append(field, chips, results);
  return tools;
}
/* The placeholder carries the count, which the language file's plain placeholder swap cannot fill. */
document.addEventListener("branch-language", () => {
  const input = $("lx-theme-search");
  if (!input) return;
  input.placeholder = say("look.search", "Search {count} themes").replace("{count}", String(THEMES.length));
  input.setAttribute("aria-label", say("look.search.label", "Search themes"));
  drawThemeTiles();
});
function lookRow(key, english, hostId) {
  const row = make("div", "lx-look-row");
  const host = make("div");
  host.id = hostId;
  const label = worded("span", "lx-look-label", key, english);
  label.id = `${hostId}-label`;
  row.append(label, host);
  return row;
}
function openSettings(page) {
  if ($("workspace").hidden) return;
  $("settings-window").hidden = false;
  document.body.classList.add("lx-settings-open");
  // DG-003: Update version line with real version (not hardcoded scaffolding)
  if (typeof globalThis.state !== "undefined" && globalThis.state?.version) {
    const verDiv = $("lx-settings-version");
    if (verDiv) verDiv.textContent = `Branch Agent ${globalThis.state.version}`;
  }
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
/** Build "On this page" navigation for visible sections. DG-006 */
function buildOnThisPage(page) {
  // Remove any existing "On this page" navigation
  page.querySelector(".lx-on-this-page")?.remove();

  // Find all section headings (h3 elements with ids)
  const headings = [...page.querySelectorAll("h3[id]:not(.lx-page-title)")].filter((h) => {
    // Only include headings that are not hidden by the current level
    const card = h.closest(".lx-page > *, .lx-subpanel > *");
    return card && !card.hidden && (card.dataset.sgBucket !== undefined || card.dataset.bucket !== undefined);
  });

  if (headings.length === 0) return; // No sections to link to

  // Create the navigation
  const nav = make("nav", "lx-on-this-page");
  nav.setAttribute("aria-label", say("settings.onThisPage", "On this page"));
  const label = worded("p", "lx-on-this-page-label", "settings.onThisPage", "On this page");
  nav.append(label);

  const links = make("div", "lx-on-this-page-links");
  for (const heading of headings) {
    const link = make("button", "lx-on-this-page-link");
    link.type = "button";
    link.textContent = heading.textContent;
    link.addEventListener("click", () => {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      heading.focus();
    });
    links.append(link);
  }
  nav.append(links);

  // Insert after page intro
  const intro = page.querySelector(".lx-page-intro");
  if (intro) intro.after(nav);
  else page.append(nav);
}

function showSettingsPage(id) {
  if (id === "instructions" && !ownerAtWindow()) id = "general";
  settingsPage = id;
  for (const page of document.querySelectorAll(".lx-page")) page.hidden = page.dataset.page !== id;
  for (const link of document.querySelectorAll(".lx-settings-link"))
    link.setAttribute("aria-current", String(link.dataset.page === id));
  $("lx-settings-body").scrollTop = 0;

  // DG-006: Build "On this page" navigation
  const page = $(`lx-page-${id}`);
  if (page) buildOnThisPage(page);

  if (id === "data") void globalThis.branchUsage?.render().then(() => globalThis.branchAllowed?.render());
  if (id === "appearance") drawLookControls();
}
/** A card's own words: not what Settings adds to it, such as the "N more with Advanced" line (DG-073). */
function wordsOf(card) {
  if (!card.querySelector("[data-no-search]")) return card.textContent;
  const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT,
    { acceptNode: (text) => text.parentElement?.closest("[data-no-search]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  let words = "";
  while (walk.nextNode()) words += walk.currentNode.nodeValue;
  return words;
}
/** Search reads every card's own words, so it finds a setting by what it says, not by where it sits. */
function searchSettings(query) {
  const needle = query.trim().toLowerCase();
  document.body.classList.toggle("lx-settings-searching", Boolean(needle));
  let found = 0;
  for (const page of document.querySelectorAll(".lx-page")) {
    let hits = 0;
    for (const card of page.querySelectorAll(".lx-subpanel > *, .lx-page > *:not(.lx-page-title):not(.lx-page-intro):not(.lx-subtabs):not(.lx-subpanel)")) {
      const match = !needle || wordsOf(card).toLowerCase().includes(needle);
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
  sendHome(document);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) sendHome(node);
  }).observe(document.body, { childList: true, subtree: true });
}
/* A new screen says where it lives instead of editing this file: data-home="settings:permissions",
   "customize:channels", "settings:models:local" and so on (docs/design/places.md lists every home). */
function slotFor(home) {
  const [where, page, sub] = home.split(":");
  if (where === "settings") return $(sub ? `lx-models-${sub}` : `lx-page-${page}`);
  const tab = PLACES[where]?.tabs.find(([id]) => id === page);
  if (!tab) return null;
  return tab[3] ? $(tab[3]) : $(`lx-slot-${where}-${page}`);
}
function sendHome(root) {
  const found = root.matches?.("[data-home]") ? [root] : [...(root.querySelectorAll?.("[data-home]") ?? [])];
  for (const node of found) {
    const host = slotFor(node.dataset.home);
    if (!host) console.warn(`No place called "${node.dataset.home}" (docs/design/places.md)`);
    else if (node.parentElement !== host) host.append(node);
  }
}
function moveInto(id, slot) {
  const node = $(id), host = $(slot);
  if (!node || !host || node.parentElement === host) return;
  host.append(node);
}
/* The collaboration panel is drawn again on every refresh, so its parts are sent home each time. */
function moveCollab() {
  const homes = { labels: "lx-collab-labels", overnight: "lx-collab-overnight", "days-off": "lx-collab-days-off", shares: "lx-collab-people", people: "lx-collab-people" };
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
  const overnight = make("div", "lx-collab");
  overnight.id = "lx-collab-overnight";
  const days = make("div", "lx-collab");
  days.id = "lx-collab-days-off";
  $("lx-page-notifications").append(overnight, days);
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
    if (spec.strip) continue; // phase2/shell: reached from the strip
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
const PANE_TABS = [["activity", "pane.activity", "Activity"], ["plan", "pane.plan", "Plan"], ["files", "pane.files", "Files"], ["memory", "pane.memory", "Memory"],
  ["browser", "pane.browser", "Browser"], ["terminal", "pane.terminal", "Terminal"]]; // phase2/panels: Browser and Terminal (public/panels.js)
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
    trigger.title = say(key, english);
    trigger.addEventListener("click", () => pickPaneTab(id)); // phase2/panels: a tab inside the panel never closes it
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
  /* phase2/panels: one switch in the title bar (the panel button); the tabs live inside the panel (tagPaneBlocks). */
  paneSeg = seg;
  new ResizeObserver(fitPaneTabs).observe(seg);
  document.addEventListener("branch-language", () => requestAnimationFrame(fitPaneTabs));
  $("connection").before(clear, shield);
  /* DG-114: the side panel is a card over the conversation at every width, so this one switch opens and closes it
     everywhere; public/shell.js's column fold (no-aside) no longer applies to it. */
  $("aside-toggle").addEventListener("click", (event) => {
    event.stopImmediatePropagation();
    togglePane();
  }, true);
  buildLockdown(shield);
}
let paneSeg = null;
/* DG-114: every tab shows its name when all six fit, as in the sample. When they do not (a card dragged narrow, a wider
   font, a longer language), the others show only their pictures and the chosen one its name, so no name is ever cut
   short. Measured, not guessed from a width, because the width that fits depends on the font. */
function fitPaneTabs() {
  if (!paneSeg || !paneSeg.getClientRects().length) return;
  paneSeg.classList.remove("lx-tabs-tight");
  /* A name can overflow its tab without being cut inside its own words, so the tabs themselves are measured too. */
  const over = (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1;
  const cut = [...paneSeg.querySelectorAll(".lx-pane-tab, .lx-words")].some(over);
  paneSeg.classList.toggle("lx-tabs-tight", cut);
}
/* phase2/panels: the calm window's pane can be shut while work runs; it opens by itself again for the next task. */
let paneShut = false;
function togglePane() {
  if (!calm()) {
    const opened = document.body.classList.toggle("lx-pane-float");
    syncPane();
    if (opened) document.dispatchEvent(new CustomEvent("branch-pane-draw")); // the fold's own redraw (context-pane.js) is stopped above
    return;
  }
  if (calmPaneWanted()) {
    paneAsked = false;
    paneShut = calmWorking;
    document.body.classList.remove("lx-pane-float");
    return syncPane();
  }
  paneShut = false;
  askForPane(paneTab);
}
function pickPaneTab(id) {
  const open = calm() ? calmPaneWanted() : paneOpen();
  if (open && paneTab === id) return;
  choosePaneTab(id);
}
/* DG-114: the full window's pane floats over the conversation at every width, so it starts closed and opens only
   when asked. The calm window still opens it by itself while work runs, except on a narrow window. */
const narrow = matchMedia("(max-width: 1180px)");
const paneOpen = () => document.body.classList.contains("lx-pane-float");
function choosePaneTab(id) {
  if (calm()) return askForPane(id);
  const open = paneOpen();
  document.body.classList.toggle("lx-pane-float", !(open && paneTab === id));
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
  /* DG-114: the card's head is its own name and a close button, then the tabs (the approved sample's .pane-top). */
  const top = make("div", "lx-pane-top");
  const close = make("button", "head-icon lx-pane-close");
  close.type = "button";
  close.id = "lx-pane-close";
  close.setAttribute("aria-label", say("pane.close", "Close the side panel"));
  close.title = close.getAttribute("aria-label");
  close.append(icon("close"));
  /* Closing takes the keyboard back to the button that opens it again, rather than dropping it on the page. */
  close.addEventListener("click", () => { $("aside-toggle").click(); $("aside-toggle").focus(); });
  top.append(make("strong", "lx-pane-name"), close);
  const head = make("div", "lx-pane-head");
  head.append(top, paneSeg); // phase2/panels: the tabs sit in the panel's own head
  $("context-panel").prepend(head);
}
/** The pane belongs to the conversation: shown there when open, or anywhere while help is being read. */
function syncPane() {
  const panel = $("context-panel");
  panel.dataset.pane = paneTab;
  const helping = !$("context-help").hidden;
  /* The calm window opens the pane only while work runs, or when it was asked for from More. */
  const open = calm() ? calmPaneWanted() : paneOpen();
  document.body.classList.toggle("lx-aside", helping || (place === "chat" && open));
  document.body.classList.toggle("lx-help", helping);
  $("aside-toggle").setAttribute("aria-pressed", String(open)); // phase2/panels: the one switch says whether the panel is open
  for (const trigger of document.querySelectorAll(".lx-pane-tab"))
    trigger.setAttribute("aria-pressed", String(open && trigger.dataset.pane === paneTab));
  /* DG-114: the card is named for what it is, not for the tab in it; the tabs already say which one is chosen. */
  panel.querySelector(".lx-pane-name").textContent = helping ? say("help.title", "Help") : say("pane.title", "Side panel");
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
  popover(shield, pop);
  const banner = make("div", "lx-lockbanner");
  banner.id = "lx-lockbanner";
  banner.hidden = true;
  banner.setAttribute("role", "status");
  const off = button("lx-button", "lockdown.turnOff", "Turn it off");
  off.addEventListener("click", () => $("lockdown-panel").querySelector("button")?.click());
  banner.append(icon("shield"), worded("span", "", "lockdown.on", "Lockdown is on. Commands are refused; all else asks you."), off);
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
  const plan = $("context-todos")?.closest(".context-block");
  if (plan) new MutationObserver(sync).observe(plan, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true });
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
    /* The floating pane closes, and the keyboard goes back to what opened it. */
    if (event.key === "Escape" && document.body.classList.contains("lx-pane-float")) {
      const back = $("aside-toggle"); // phase2/panels: the tabs are inside the pane now; its one switch takes the keyboard back
      if (calm()) paneAsked = false;
      document.body.classList.remove("lx-pane-float");
      back?.focus();
    }
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

/* ---------- the calm window (0.18.1) ----------
   One question and one box. Everything else is still on the page with its id and its module; it is
   hidden by layout.css while <html data-everything="off">, and reached from the one More menu or
   shown only when it matters (the pane while work runs, Inbox while something waits). Settings →
   Appearance → "Show everything" (the showEverything preference, kept per person) brings back the
   full window. Nothing here removes or rewires an existing control. */
const calm = () => root.dataset.everything !== "on";
let paneAsked = false;
let calmWorking = false;
const liveRunning = () => $("live-row") && !$("live-row").hidden;
const badgeRunning = () => { const badge = $("activity-count"); return Boolean(badge && !badge.hidden && Number(badge.textContent) > 0); };
/** A goal on this conversation (public/goal.js) keeps its Resume and Stop in view, between rounds too. */
const goalShowing = () => Boolean($("goal-strip") && !$("goal-strip").hidden);
/** In the calm window the pane shows while work runs, or when the owner asked for it; a narrow window floats it only when asked. */
function calmPaneWanted() {
  if (narrow.matches) return paneAsked && document.body.classList.contains("lx-pane-float");
  return paneAsked || (calmWorking && !paneShut); // phase2/panels: shut with the switch while work runs
}
function askForPane(id) {
  /* DG-114: decided by whether the pane is showing, not by the old request: opened on a wide window and then narrowed
     past 1180 px, the pane had closed while still counted as asked for, so the next press only cleared it. */
  paneAsked = !(calmPaneWanted() && paneTab === id);
  paneTab = id;
  if (narrow.matches) document.body.classList.toggle("lx-pane-float", paneAsked);
  syncPane();
  if (paneAsked) document.dispatchEvent(new CustomEvent("branch-pane-draw"));
}
/** The pane slides in once work has run for a moment, and away a moment after it stops, so a quick answer never flashes it. */
let workTimer = null;
function watchCalmWork() {
  const sync = () => {
    const now = liveRunning() || badgeRunning() || goalShowing();
    clearTimeout(workTimer);
    workTimer = setTimeout(() => {
      if (calmWorking === now) return;
      calmWorking = now;
      if (!now) paneShut = false; // phase2/panels
      document.body.classList.toggle("lx-calm-working", now);
      if (now) document.dispatchEvent(new CustomEvent("branch-pane-draw"));
      syncPane();
    }, now ? 1200 : 1500);
  };
  const live = $("live-row");
  if (live) new MutationObserver(sync).observe(live, { attributes: true, attributeFilter: ["hidden"] });
  const badge = $("activity-count");
  if (badge) new MutationObserver(sync).observe(badge, { attributes: true, childList: true, characterData: true, subtree: true });
  const plan = $("context-todos")?.closest(".context-block");
  if (plan) new MutationObserver(sync).observe(plan, { attributes: true, attributeFilter: ["hidden"], childList: true, subtree: true });
  /* Switching between the calm and the full window starts the pane afresh; the same value written again does nothing. */
  let was = root.dataset.everything;
  new MutationObserver(() => {
    if (root.dataset.everything === was) return;
    was = root.dataset.everything;
    paneAsked = false;
    document.body.classList.remove("lx-pane-float");
    syncPane();
  }).observe(root, { attributes: true, attributeFilter: ["data-everything"] });
}

/* The More menu: every control the calm window hides, in plain words. Each row presses the real control. */
const MORE = [
  ["more.message", "This message", [
    ["check", "ask-first-toggle", "more.askFirst", "Ask me questions first"],
    ["planfirst", "session-plan-mode", "more.planFirst", "Show me the plan first"],
    ["check", "temporary-toggle", "more.temporary", "Forget this conversation afterwards"],
    ["press", "composer-attach", "more.attach", "Attach a document…"],
    ["press", "composer-media", "more.picture", "Add a picture or a sound…"],
    ["assistant", "composer-specialist", "more.assistant", "Who should answer"],
  ]],
  ["more.pane", "Side panel", [
    ["pane", "activity", "pane.activity", "Activity"], ["pane", "plan", "pane.plan", "Plan"],
    ["pane", "files", "pane.files", "Files"], ["pane", "memory", "pane.memory", "Memory"],
    ["pane", "browser", "pane.browser", "Browser"], ["pane", "terminal", "pane.terminal", "Terminal"], // phase2/panels
    ["allowed", "context-allowed", "allowed.title", "What is allowed right now"],
  ]],
  ["more.goTo", "Go to", [
    ["view", "inbox", "place.inbox", "Inbox"], ["view", "automations", "place.automations", "Automations"],
    ["view", "library", "place.library", "Library"], ["view", "customize", "place.customize", "Customize"],
    ["find", "", "rail.find", "Find anything"],
  ]],
  ["more.window", "This window", [
    ["press", "thread-labels", "more.labels", "Labels for this conversation"],
    ["lockdown", "", "more.lockdown", "Lockdown: refuse commands"],
    ["quiet", "", "look.clear", "Clear the view"],
    ["press", "menu-help", "menu.help", "Help"],
    ["press", "lock", "action.lock-session", "Lock session"],
    ["everything", "appearance-everything", "more.everything", "Show everything"],
  ]],
];
function moreRow([kind, target, key, english], close) {
  if (kind === "assistant") return assistantRow(target, key, english);
  const row = button("lx-more-item", key, english);
  row.setAttribute("role", ["check", "lockdown", "planfirst"].includes(kind) ? "menuitemcheckbox" : "menuitem");
  row.dataset.kind = kind;
  row.dataset.target = target;
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    runMoreRow(kind, target);
    if (kind !== "check" && kind !== "planfirst") close();
    else syncMoreChecks();
  });
  return row;
}
function runMoreRow(kind, target) {
  if (kind === "check" || kind === "press" || kind === "everything") $(target)?.click();
  else if (kind === "pane") { displayView("chat"); askForPane(target); }
  else if (kind === "allowed") showAllowed();
  else if (kind === "view") displayView(`${target}:${lastTab[target]}`);
  else if (kind === "find") openPalette();
  else if (kind === "lockdown") $("lockdown-panel").querySelector("button")?.click();
  else if (kind === "quiet") setQuiet(true);
  else if (kind === "planfirst") {
    const select = $(target);
    select.value = select.value === "show-plan" ? "just-do-it" : "show-plan";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
/** Opens the Activity pane (never closes it) and brings "What is allowed right now" into view. */
function showAllowed() {
  displayView("chat");
  const open = calm() ? calmPaneWanted() : paneOpen();
  if (!(open && paneTab === "activity")) choosePaneTab("activity");
  $("context-allowed")?.closest(".context-block")?.scrollIntoView({ block: "nearest" });
}
/** The assistant picker is a copy of the real one: choosing here chooses there. */
function assistantRow(target, key, english) {
  const row = make("label", "lx-more-assistant");
  const select = make("select");
  select.id = "lx-more-assistant";
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    const real = $(target);
    real.value = select.value;
    real.dispatchEvent(new Event("change", { bubbles: true }));
  });
  row.append(worded("span", "", key, english), select);
  return row;
}
function syncMoreChecks() {
  for (const row of document.querySelectorAll('#lx-more-menu [data-kind="check"]'))
    row.setAttribute("aria-checked", String(Boolean($(row.dataset.target)?.checked)));
  const plan = document.querySelector('#lx-more-menu [data-kind="planfirst"]');
  plan?.setAttribute("aria-checked", String($("session-plan-mode")?.value === "show-plan"));
  const lock = document.querySelector('#lx-more-menu [data-kind="lockdown"]');
  lock?.setAttribute("aria-checked", String($("lx-shield")?.getAttribute("aria-pressed") === "true"));
  const real = $("composer-specialist"), copy = $("lx-more-assistant");
  if (real && copy) {
    copy.replaceChildren(...[...real.options].map((option) => new Option(option.textContent, option.value, false, option.selected)));
    copy.closest("label").hidden = real.options.length < 2;
  }
  for (const row of document.querySelectorAll('#lx-more-menu [data-kind="press"]'))
    row.hidden = !$(row.dataset.target) || $(row.dataset.target).hidden;
}
function buildMore() {
  const trigger = button("lx-more", "more.label", "More");
  trigger.id = "lx-more";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = make("div", "lx-pop lx-more-menu");
  menu.id = "lx-more-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", say("more.label", "More"));
  let pop = null;
  const close = () => pop?.close();
  for (const [key, english, rows] of MORE) {
    const group = make("div", "lx-more-group");
    const head = worded("p", "lx-more-head", key, english);
    head.id = `lx-more-${key.replace(/\W/g, "-")}`;
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", head.id);
    group.append(head, ...rows.map((row) => moreRow(row, close)));
    menu.append(group);
  }
  let focusLast = false;
  pop = popover(trigger, menu, {
    onOpen: syncMoreChecks,
    afterOpen: () => { const items = moreItems(menu); items[focusLast ? items.length - 1 : 0]?.focus(); focusLast = false; },
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    focusLast = event.key === "ArrowUp";
    if (!pop.isOpen()) pop.open();
  });
  menu.addEventListener("keydown", (event) => moveInMore(event, menu, close));
  $("aside-toggle").after(trigger, menu);
}
/** The rows a keyboard can land on: the visible items, and the assistant picker when it shows. */
const moreItems = (menu) => [...menu.querySelectorAll(".lx-more-item, #lx-more-assistant")].filter((node) => node.checkVisibility());
/** Arrow keys, Home and End move through More; Tab leaves it closed, as a menu does. */
function moveInMore(event, menu, close) {
  if (event.key === "Tab") return close();
  const items = moreItems(menu);
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (to === undefined || !items.length) return;
  /* The assistant picker keeps its own arrow keys. */
  if (document.activeElement?.id === "lx-more-assistant" && event.key.startsWith("Arrow")) return;
  event.preventDefault();
  items[(to + items.length) % items.length].focus();
}

/* One plain Settings row at the foot of the rail, in place of the small gear and the owner row. */
function buildSettingsRow() {
  const row = button("rail-row lx-settings-row", "menu.settingsShort", "Settings");
  row.id = "lx-settings-row";
  iconAndWords(row, "settings");
  row.addEventListener("click", () => displayView("settings"));
  document.querySelector(".rail-foot").prepend(row);
}

/* "Connected" only ever meant the window reached Branch on this computer. It is said only when that stops being true. */
let misses = 0;
let serverProbe = null;
async function probeServer() {
  const aborter = new AbortController();
  const timeout = setTimeout(() => aborter.abort(), 8000);
  let reached = true;
  try {
    await api("alive", undefined, undefined, aborter.signal);
  } catch {
    reached = false;
  } finally {
    clearTimeout(timeout);
  }
  misses = reached ? 0 : misses + 1;
  const lost = misses >= 2;
  const chip = $("connection");
  if (lost) chip.textContent = say("server.lost", "Branch stopped responding");
  else if (chip.dataset.state === "lost") chip.textContent = "Connected";
  chip.dataset.state = lost ? "lost" : "ok";
  $("lx-restart").hidden = !lost;
}
async function checkServer() {
  if (document.hidden || $("workspace").hidden) return;
  if (serverProbe) return serverProbe;
  serverProbe = probeServer();
  try { await serverProbe; } finally { serverProbe = null; }
}
/** The desktop app starts Branch again for real (src/desktop/restart-ipc.ts); a browser can only load the page again. */
async function restartBranch() {
  $("lx-restart").disabled = true;
  try {
    if (globalThis.branchDesktop?.restartBranch) return void await globalThis.branchDesktop.restartBranch();
  } catch { /* the page is loaded again below */ }
  location.reload();
}
function buildServerWatch() {
  const restart = button("lx-button lx-restart", "server.restart", "Restart");
  restart.id = "lx-restart";
  restart.hidden = true;
  restart.addEventListener("click", () => void restartBranch());
  $("connection").after(restart);
  setInterval(() => void checkServer(), 10000);
}

/* Inbox stays out of the calm rail until something is waiting in it. */
function watchInboxBadge() {
  const sync = () => document.body.classList.toggle("lx-inbox-waiting", !$("lx-inbox-badge").hidden);
  new MutationObserver(sync).observe($("lx-inbox-badge"), { attributes: true, attributeFilter: ["hidden"] });
  sync();
}
/* After the first task ever to finish, one quiet line offers what first run no longer asks with tick
   boxes: starting at sign-in, and using Branch from a phone. Each offer opens the real Settings switch
   rather than flipping it. It is shown once: the trigger is the workspace's first completed task, and
   the line is marked seen the moment it shows. The full window never shows it. */
const TIP_SEEN = "branch-calm-tip";
async function offerNextSteps(event) {
  const { status, completedRuns } = event.detail ?? {};
  if (!calm() || status !== "completed" || completedRuns !== 1 || store.get(TIP_SEEN) || $("lx-tip")) return;
  const running = await api("deployment").catch(() => null);
  if (!running) return;
  const offers = [
    ...(running.installed && !running.autostart?.enabled ? [["start-with-windows", "tip.start", "Start Branch when I sign in"]] : []),
    ...(!running.remote?.enabled ? [["phone-switch", "tip.phone", "Use it from my phone"]] : []),
  ];
  if (!offers.length || $("lx-tip")) return;
  store.set(TIP_SEEN, "1");
  const line = make("div", "lx-tip");
  line.id = "lx-tip";
  line.setAttribute("role", "status");
  line.append(worded("span", "lx-tip-lead", "tip.lead", "That worked. If you like:"));
  for (const [id, key, english] of offers) {
    const offer = button("lx-tip-offer", key, english);
    offer.addEventListener("click", () => { line.remove(); if (reveal(id)) $(id).focus(); });
    line.append(offer);
  }
  const dismiss = button("lx-tip-close", "tip.dismiss", "Not now");
  dismiss.addEventListener("click", () => { line.remove(); $("prompt")?.focus(); });
  line.append(dismiss);
  $("chat-form").before(line);
}
/* ---------- the calm message box ----------
   One line that grows as it fills, a "+" for attachments on the left, and one round button on the
   right: quiet while the box is empty, the accent once there is something to send, and Stop while a
   task runs. The full window keeps its own row of controls; every id stays where it was. */
const STARTERS = [
  ["starter.tidy", "Tidy a folder", "starter.tidyWords", "Look through my Downloads folder and suggest how to tidy it. Do not delete anything."],
  ["starter.research", "Research something", "starter.researchWords", "Research this and give me a short summary with sources: "],
  ["starter.week", "Plan my week", "starter.weekWords", "Help me plan my week. Here is what I have on: "],
];
function buildCalmComposer() {
  const form = $("chat-form"), prompt = $("prompt"), send = $("send");
  /* Send keeps its id, its words for the full window and its name; the calm window shows an arrow. */
  const words = make("span", "lx-send-words", send.textContent.trim());
  send.replaceChildren(words, icon("up"));
  send.setAttribute("aria-label", say("composer.send", "Send"));
  send.title = say("composer.sendHint", "Send (Enter). Shift+Enter starts a new line.");
  const stop = make("button", "lx-stop");
  stop.type = "button";
  stop.id = "lx-stop";
  stop.hidden = true;
  stop.setAttribute("aria-label", say("live.stop", "Stop"));
  stop.title = stop.getAttribute("aria-label");
  stop.append(icon("stop"));
  stop.addEventListener("click", () => void stopRunning(stop));
  send.after(stop);
  const empty = () => send.classList.toggle("lx-empty", !prompt.value.trim());
  prompt.addEventListener("input", empty);
  empty();
  /* An empty box is not sent: the button says it is off, and pressing it only puts you in the box. */
  send.addEventListener("click", (event) => {
    if (!calm() || prompt.value.trim()) return;
    event.preventDefault();
    prompt.focus();
  });
  /* app.js disables Send while a task works (setConversationBusy): that is when Stop takes its place. */
  const busy = () => {
    const working = send.disabled;
    empty();
    document.body.classList.toggle("lx-sending", working);
    stop.hidden = !working;
    stop.disabled = false;
  };
  new MutationObserver(busy).observe(send, { attributes: true, attributeFilter: ["disabled"] });
  busy();
  form.prepend(buildPlus());
  $("composer-dock").append(buildStarters());
}
/** Stop presses the working card's own Stop, once the task it belongs to is known. */
async function stopRunning(stop) {
  stop.disabled = true;
  for (let tries = 0; tries < 20 && !$("live-stop"); tries += 1) await new Promise((done) => setTimeout(done, 150));
  $("live-stop")?.click();
}
/** "+" on the left of the box: the same two ways to add something as in More, pressing the real controls. */
function buildPlus() {
  const wrap = make("div", "lx-plus-wrap");
  const plus = make("button", "lx-plus");
  plus.type = "button";
  plus.id = "lx-plus";
  plus.setAttribute("aria-label", say("composer.add", "Add a document, a picture or a sound"));
  plus.title = plus.getAttribute("aria-label");
  plus.setAttribute("aria-haspopup", "menu");
  plus.setAttribute("aria-expanded", "false");
  plus.append(icon("plus"));
  const menu = make("div", "lx-pop lx-plus-menu");
  menu.id = "lx-plus-menu";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", plus.getAttribute("aria-label"));
  let pop = null;
  const close = () => pop?.close();
  for (const [target, key, english] of [["composer-attach", "more.attach", "Attach a document…"], ["composer-media", "more.picture", "Add a picture or a sound…"]]) {
    const row = button("lx-more-item", key, english);
    row.setAttribute("role", "menuitem");
    row.dataset.target = target;
    row.addEventListener("click", () => { close(); $(target)?.click(); });
    menu.append(row);
  }
  pop = popover(plus, menu, {
    onOpen: () => { for (const row of menu.querySelectorAll(".lx-more-item")) row.disabled = Boolean($(row.dataset.target)?.disabled); },
    afterOpen: () => moreItems(menu)[0]?.focus(),
  });
  menu.addEventListener("keydown", (event) => moveInMore(event, menu, close));
  wrap.append(plus, menu);
  return wrap;
}
/** Three plain starting points under the empty box. Each only fills the box; nothing is sent. */
function buildStarters() {
  const row = make("div", "lx-starters");
  row.id = "lx-starters";
  for (const [key, english, wordsKey, wordsEnglish] of STARTERS) {
    const chip = button("lx-starter", key, english);
    chip.addEventListener("click", () => {
      const prompt = $("prompt");
      prompt.value = say(wordsKey, wordsEnglish);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      prompt.focus();
      prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    });
    row.append(chip);
  }
  return row;
}
function buildCalm() {
  document.addEventListener("branch-run-finished", (event) => void offerNextSteps(event));
  buildCalmComposer();
  buildMore();
  buildSettingsRow();
  buildServerWatch();
  watchCalmWork();
  watchInboxBadge();
  $("demo-connect")?.addEventListener("click", () => displayView("settings:models"));
}

/* ---------- start ---------- */
function start() {
  buildRail();
  for (const [id, spec] of Object.entries(PLACES)) buildPlace(id, spec);
  buildInboxLists();
  buildSettings();
  buildSettingsDirectories();
  moveAll();
  buildTitleBar();
  tagPaneBlocks();
  buildQuiet();
  buildOwnerMenu();
  buildModelChip();
  buildCalm();
  installGrownComposer();
  wireKeys();
  extendPalette();
  globalThis.branchLayout = { go, reveal, homes: () => [...Object.keys(ROUTES)], checkServer, showOwnerSettings };
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

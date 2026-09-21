import { assistantIdentity } from "./identity.js";
import { comfortRows } from "./comfort/terminal.js"; // R17-S21
import { lockdownState } from "./lockdown.js";
import { permissionRows, type PlaceApp, type Row } from "./terminal-place-data.js";
import type { Look, LookMode, TerminalSwitches } from "./terminal-theme.js";
import type { Words } from "./terminal-words.js";

/**
 * What each Settings page shows in the terminal. The pages the terminal can change (Appearance,
 * Models › Defaults, Permissions) carry a command on each row, run when the row is chosen; the
 * others say plainly what is on the page and name the `branch` command or the window that changes it.
 */
export interface SettingsState { look: Look; mode: LookMode | "follow"; themeName: string; switches: TerminalSwitches }

const inWindow = (words: Words, page: string): Row => ({
  title: words.t("terminal.settings.inWindow", "The rest of this page is in the window"),
  detail: words.t("terminal.settings.inWindowDetail", "Open Branch and choose Settings › {page}.", { page }), tone: "muted",
});
const switchWord = (words: Words, value: string): string =>
  value === "on" ? words.t("terminal.state.on", "on") : value === "off" ? words.t("terminal.state.off", "off") : words.t("terminal.state.whenNeeded", "when needed");

function appearance(words: Words, state: SettingsState): Row[] {
  const mode = { dark: words.t("look.mode.dark", "Dark"), light: words.t("look.mode.light", "Light"), follow: words.t("look.mode.follow", "Follow this computer") }[state.mode];
  const language = state.look.language === "auto" ? words.t("terminal.settings.languageAuto", "Same as this computer") : state.look.language === "fr" ? "Français" : "English";
  const s = state.switches;
  return [
    { title: `${words.t("look.theme", "Theme")}: ${state.themeName}`, detail: words.t("terminal.settings.themeDetail", "All 44 themes, shared with the window. Enter shows them."), command: "/theme list" },
    { title: `${words.t("look.mode", "Light and dark")}: ${mode}`, detail: words.t("terminal.settings.modeDetail", "Enter moves to the next choice."), command: "/theme mode" },
    { title: `${words.t("look.contrast", "More contrast between text and background")}: ${switchWord(words, state.look.contrast === "more" ? "on" : "off")}`, command: "/theme contrast" },
    { title: `${words.t("terminal.settings.language", "Language")}: ${language}`, command: "/theme language" },
    { title: `${words.t("terminal.switch.mouse", "Clicks and the wheel")}: ${switchWord(words, s.mouse)}`, detail: words.t("terminal.switch.mouseDetail", "Off keeps your terminal's own text selection."), command: "/switch mouse" },
    { title: `${words.t("terminal.switch.sidePane", "Side pane opens by itself")}: ${switchWord(words, s.sidePane)}`, detail: words.t("terminal.switch.sidePaneDetail", "When needed, it opens while a task works."), command: "/switch sidePane" },
    { title: `${words.t("terminal.switch.oak", "The oak on a new conversation")}: ${switchWord(words, s.oak)}`, detail: words.t("terminal.switch.oakDetail", "When needed, only when the terminal is tall enough."), command: "/switch oak" },
  ];
}
function models(app: PlaceApp, words: Words, sub: string): Row[] {
  const summary = app.runtime.models.summary(app.runtime.owner);
  const active = summary.activePreset ?? summary.defaultPreset;
  const presets = summary.presets.filter((preset) => sub !== "local" || app.runtime.models.runsLocally(preset.id));
  if (sub === "connection" || sub === "local" || sub === "defaults") {
    const rows: Row[] = presets.map((preset) => ({
      title: `${preset.id === active ? "● " : ""}${preset.name}`, detail: `${preset.id} · ${preset.model}${preset.coolingDownUntil ? " · resting" : ""}`,
      tone: preset.id === active ? "ok" as const : undefined,
      ...(sub === "defaults" ? { command: `/default ${preset.id}` } : {}),
    }));
    if (sub === "connection") rows.push({ title: words.t("terminal.settings.signIn", "Sign in to a ChatGPT account"), detail: "branch login", tone: "muted" });
    if (sub === "defaults") rows.push({ title: words.t("terminal.settings.fallbacks", "Tried next when one fails"), detail: summary.fallbackOrder.join(", ") || "—", tone: "muted" });
    return rows.length ? rows : [inWindow(words, words.t("settings.page.models", "Models"))];
  }
  return [inWindow(words, words.t("settings.page.models", "Models"))];
}

const directory = (words: Words, key: string, english: string, detailKey: string, detail: string, command: string): Row => ({
  title: words.t(key, english), detail: words.t(detailKey, detail), command,
});
function directoryRows(words: Words, page: string): Row[] | null {
  const row = (key: string, english: string, line: string, detail: string, command: string): Row =>
    directory(words, key, english, line, detail, command);
  const pages: Record<string, Row[]> = {
    trunks: [
      row("settingsDirectory.trunks", "Trunks", "settingsDirectory.trunks.line", "Create and change your own assistants.", "/go customize specialists"),
      row("place.overview", "Overview", "settingsDirectory.overview.line", "See what this computer or a Trunk is doing.", "/go overview here"),
      row("place.household", "People", "settingsDirectory.people.line", "Manage the people who use Branch on this computer.", "/go household people"),
    ],
    channels: [row("settings.page.channels", "Chat apps & devices", "settingsDirectory.channels.line", "Set up chat apps, pages and devices that reach Branch.", "/go customize channels")],
    connections: [row("settings.page.connections", "Connections", "settingsDirectory.connections.line", "Manage tool servers, app connections and your own connected accounts.", "/go customize connections")],
    skills: [
      row("place.customize.skills", "Skills", "settingsDirectory.skills.line", "Choose and inspect instructions for particular kinds of work.", "/go customize skills"),
      row("place.customize.specialists", "Specialists", "settingsDirectory.specialists.line", "Create and manage Trunks with their own jobs and character.", "/go customize specialists"),
      row("place.customize.plugins", "Plugins", "settingsDirectory.plugins.line", "Install and review add-ons from other tools and people.", "/go customize plugins"),
    ],
    memory: [
      row("place.library.memory", "Memory", "settingsDirectory.memory.line", "Review what Branch remembers and how it learns.", "/go library memory"),
      row("place.library.documents", "Documents", "settingsDirectory.documents.line", "Manage the documents Branch may use when it answers.", "/go library documents"),
      row("place.library.made", "Made for you", "settingsDirectory.made.line", "Open the pages, articles and widgets Branch made.", "/go library made"),
    ],
    automations: [
      row("place.automations.scheduled", "Scheduled", "settingsDirectory.scheduled.line", "Manage work that runs at a particular time.", "/go automations scheduled"),
      row("place.automations.procedures", "Procedures", "settingsDirectory.procedures.line", "Manage saved ways of doing repeatable work.", "/go automations procedures"),
      row("place.automations.triggers", "Triggers", "settingsDirectory.triggers.line", "Manage work started by an outside event.", "/go automations triggers"),
      row("place.inbox.needs", "Needs you", "settingsDirectory.needs.line", "Answer work waiting for your decision.", "/go inbox needs"),
      row("place.inbox.history", "History", "settingsDirectory.history.line", "Review what ran and how it ended.", "/go inbox history"),
    ],
  };
  return pages[page] ?? null;
}

/** The rows of one Settings page (and Models tab). */
export function settingsRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState): Row[] {
  // R17-S21: the comfort settings on each page are real controls (src/comfort/terminal.ts), put
  // after the page's own rows and before its last row, the pointer to the window.
  const comfort = comfortRows(app.store, app.runtime.owner, words, page);
  const rows = pageRows(app, words, page, sub, state);
  return comfort.length ? [...rows.slice(0, -1), ...comfort, ...rows.slice(-1)] : rows;
}
function pageRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState): Row[] {
  const name = (id: string, english: string): string => words.t(`settings.page.${id}`, english);
  const owner = app.runtime.owner;
  const directoryPage = directoryRows(words, page);
  if (directoryPage) return directoryPage;
  switch (page) {
    case "appearance": return appearance(words, state);
    case "models": return models(app, words, sub || "connection");
    case "permissions": {
      const lock = lockdownState(app.store, owner).on;
      return [...permissionRows(app), { title: `${words.t("lockdown.label", "Lockdown")}: ${switchWord(words, lock ? "on" : "off")}`, detail: words.t("lockdown.on", "Lockdown is on. Commands are refused; all else asks you."), command: `/lockdown ${lock ? "off" : "on"}`, tone: lock ? "bad" : undefined }];
    }
    case "general": return [
      ...app.store.projects.list(owner).map((project) => ({ title: project.name, detail: project.id === app.store.projects.active(owner).id ? words.t("terminal.settings.activeProject", "the project in use") : project.id })),
      { title: words.t("terminal.settings.daemon", "Starting with the computer"), detail: "branch daemon status", tone: "muted" }, inWindow(words, name("general", "General"))];
    case "assistant": {
      const identity = assistantIdentity(app.store, owner);
      return [{ title: identity.name, detail: identity.instructions.split("\n")[0] || words.t("terminal.settings.noInstructions", "No working instructions yet.") }, inWindow(words, name("assistant", "Assistant"))];
    }
    case "data": return [{ title: words.t("terminal.settings.tasks", "{count} tasks on record", { count: app.store.runs(owner).length }), detail: "branch backup <file>" }, inWindow(words, name("data", "Data & usage"))];
    case "advanced": return [{ title: words.t("terminal.settings.doctor", "Check that everything works"), detail: "branch doctor" }, inWindow(words, name("advanced", "Advanced"))];
    case "about": return [{ title: `Branch Agent ${app.version}`, detail: "branch update" }, inWindow(words, name("about", "Updates & about"))];
    default: return [inWindow(words, words.t(`settings.page.${page}`, page))];
  }
}

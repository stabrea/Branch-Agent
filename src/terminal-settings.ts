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

/** The rows of one Settings page (and Models tab). */
export function settingsRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState): Row[] {
  // R17-S21: the comfort settings on each page are real controls (src/comfort/terminal.ts), put
  // before the page's own rows and its pointer to the window.
  const comfort = comfortRows(app.store, app.runtime.owner, words, page);
  const rows = pageRows(app, words, page, sub, state);
  return comfort.length ? [...comfort, ...rows] : rows;
}
function pageRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState): Row[] {
  const name = (id: string, english: string): string => words.t(`settings.page.${id}`, english);
  const owner = app.runtime.owner;
  switch (page) {
    case "appearance": return appearance(words, state);
    case "models": return models(app, words, sub || "connection");
    case "permissions": {
      const lock = lockdownState(app.store, owner).on;
      return [...permissionRows(app), { title: `${words.t("lockdown.label", "Lockdown")}: ${switchWord(words, lock ? "on" : "off")}`, detail: words.t("lockdown.on", "Lockdown is on. Everything waits for your yes."), command: `/lockdown ${lock ? "off" : "on"}`, tone: lock ? "bad" : undefined }];
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

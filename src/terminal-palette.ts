import { ALL_PLACES, MODEL_TABS, SETTINGS_PAGES } from "./terminal-places.js";
import { TERMINAL_COMMANDS, type TerminalCommand } from "./terminal-command-table.js";
import type { PaletteItem } from "./terminal-screen.js";
import type { ThemeCatalogue } from "./terminal-theme.js";
import type { Words } from "./terminal-words.js";

/**
 * What Ctrl+K offers, in the window's order: the places and their tabs, every Settings page, the
 * top actions, recent conversations, and every slash command. Typing narrows the list; starting
 * with "/" lists only the commands.
 */
export interface RecentConversation { sessionId: string; opening: string }

function placeItems(words: Words, crumb: string): PaletteItem[] {
  const section = words.t("rail.sections", "Sections");
  const items: PaletteItem[] = [];
  for (const place of ALL_PLACES) {
    const name = words.t(place.key, place.english);
    items.push({ label: name, section, run: `/go ${place.id}` });
    for (const tab of place.tabs) items.push({ label: `${name}${crumb}${words.t(tab.key, tab.english)}`, section, run: `/go ${place.id}:${tab.id}` });
  }
  const settings = words.t("settings.title", "Settings");
  for (const page of SETTINGS_PAGES) {
    const name = `${settings}${crumb}${words.t(page.key, page.english)}`;
    if (page.id !== "models") { items.push({ label: name, section: settings, run: `/go settings:${page.id}` }); continue; }
    for (const tab of MODEL_TABS) items.push({ label: `${name}${crumb}${words.t(tab.key, tab.english)}`, section: settings, run: `/go settings:models:${tab.id}` });
  }
  return items;
}
function actionItems(words: Words): PaletteItem[] {
  const section = words.t("terminal.palette.actions", "Actions");
  return [
    { label: words.t("rail.new", "New conversation"), section, hint: "Ctrl+N", run: "/new" },
    { label: words.t("pane.label", "Side pane"), section, hint: "Ctrl+P", run: "/pane" },
    { label: words.t("look.allThemes", "All 44 themes…"), section, run: "/theme list" },
    { label: words.t("rail.recents", "Recents"), section, run: "/sessions" },
    { label: words.t("lockdown.label", "Lockdown"), section, run: "/lockdown" },
    { label: words.t("terminal.command.keys", "every key the view answers to"), section, hint: "F1", run: "/keys" },
    { label: words.t("terminal.command.exit", "leave"), section, hint: "Ctrl+D", run: "/exit" },
  ];
}
const squash = (text: string): string => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function paletteItems(words: Words, recent: RecentConversation[], query: string, crumb = " › ", table: TerminalCommand[] = TERMINAL_COMMANDS): PaletteItem[] {
  const commands = table.map((entry) => ({
    label: `/${entry.name}${entry.args ? " " + entry.args : ""}`, section: words.t("terminal.palette.commands", "Commands"),
    hint: words.t(entry.key, entry.english), run: `/${entry.name}`,
  }));
  if (query.startsWith("/")) {
    const typed = query.slice(1).split(/\s+/)[0]!.toLowerCase();
    return commands.filter((item) => item.run.slice(1).startsWith(typed) || table.find((entry) => `/${entry.name}` === item.run)!.aliases.some((alias) => alias.startsWith(typed)));
  }
  const conversations = recent.map((entry) => ({
    label: entry.opening.replace(/\s+/g, " ").slice(0, 80) || entry.sessionId.slice(0, 8), section: words.t("rail.conversations", "Conversations"),
    run: `/sessions ${entry.sessionId}`,
  }));
  const all: PaletteItem[] = [...placeItems(words, crumb), ...actionItems(words), ...conversations, ...commands];
  const wanted = squash(query).split(/\s+/).filter(Boolean);
  return all.filter((item) => wanted.every((word) => squash(`${item.label} ${item.section} ${item.hint ?? ""}`).includes(word)));
}

/** The 44 themes as a picker, in the window's two groups. */
export function themeItems(table: ThemeCatalogue, current: string): PaletteItem[] {
  const groups = new Map(table.THEME_GROUPS);
  return table.THEMES.map((theme) => ({
    label: `${theme[0] === current ? "● " : ""}${theme[1]}`, section: groups.get(theme[2]) ?? theme[2], hint: theme[0], run: `/theme ${theme[0]}`,
  }));
}

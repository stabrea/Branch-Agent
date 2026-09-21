import type { Words } from "./terminal-words.js";

/**
 * The map of Branch, as the terminal shows it: the five places in the window's order with the
 * window's names, their tabs, the Settings pages, the five Models tabs and the four side-pane
 * tabs. Every key is the one `public/layout.js` uses, so both surfaces say the same words, and
 * `tests/terminal-places.test.mjs` checks this list against `docs/places.md` and `layout.js`.
 */
export type PlaceId = "chat" | "inbox" | "automations" | "library" | "customize" | "overview" | "household";
export interface Named { id: string; key: string; english: string }
export interface Place extends Named { intro: [string, string]; tabs: Named[] }
export interface SettingsPage extends Named { intro: [string, string] }

const tab = (id: string, key: string, english: string): Named => ({ id, key, english });
export const PLACES: Place[] = [
  { id: "chat", key: "nav.chat", english: "Conversation",
    intro: ["terminal.place.chat.intro", "The work happening now, and what this conversation is using."], tabs: [] },
  { id: "inbox", key: "place.inbox", english: "Inbox",
    intro: ["place.inbox.intro", "What needs your yes, what finished while you were away, and everything that happened."],
    tabs: [tab("needs", "place.inbox.needs", "Needs you"), tab("finished", "place.inbox.finished", "Finished"), tab("history", "place.inbox.history", "History")] },
  { id: "automations", key: "place.automations", english: "Automations",
    intro: ["place.automations.intro", "Work that runs without you asking each time: on a schedule, as a procedure, or when something happens."],
    tabs: [tab("scheduled", "place.automations.scheduled", "Scheduled"), tab("procedures", "place.automations.procedures", "Procedures"),
      tab("triggers", "place.automations.triggers", "Triggers")] },
  { id: "library", key: "place.library", english: "Library",
    intro: ["place.library.intro", "What your assistant knows and what it has made for you."],
    tabs: [tab("memory", "place.library.memory", "Memory"), tab("documents", "place.library.documents", "Documents"),
      tab("made", "place.library.made", "Made for you")] },
  { id: "customize", key: "place.customize", english: "Customize",
    intro: ["place.customize.intro", "What your assistant can do, and who can reach it."],
    tabs: [tab("skills", "place.customize.skills", "Skills"), tab("specialists", "place.customize.specialists", "Specialists"),
      tab("plugins", "place.customize.plugins", "Plugins"), tab("connections", "place.customize.connections", "Connections"),
      tab("channels", "place.customize.channels", "Channels")] },
];
export const STRIP_PLACES: Place[] = [
  { id: "overview", key: "place.overview", english: "Overview",
    intro: ["place.overview.intro", "What a computer or a Trunk is doing, in one screen."],
    tabs: [tab("here", "place.overview.here", "Overview")] },
  { id: "household", key: "place.household", english: "People",
    intro: ["place.household.intro", "Everyone who uses Branch here, and what each may do."],
    tabs: [tab("people", "place.household.people", "People")] },
];
const ALL_PLACES = [...PLACES, ...STRIP_PLACES];

const page = (id: string, english: string, intro: string): SettingsPage =>
  ({ id, key: `settings.page.${id}`, english, intro: [`terminal.settings.${id}.intro`, intro] });
export const SETTINGS_PAGES: SettingsPage[] = [
  page("general", "General", "How Branch starts and runs on this computer, your projects, and the people who use it."),
  page("assistant", "Assistant", "Who your assistant is, and how much it keeps and learns."),
  page("instructions", "Instructions & personality", "Plain files Branch reads before it works: who it is, who you are, and how you want things done."),
  page("appearance", "Appearance", "Every KeepOak theme, light or dark. Changes show in this terminal and in the window."),
  page("notifications", "Notifications", "When Branch may interrupt you, and the days it should leave you alone."),
  page("models", "Models", "Which models your assistant uses, and how it signs in to them."),
  page("accounts", "Accounts", "Every sign-in and key Branch can use, which one answers, and what happens when one runs low."),
  page("voice", "Voice", "Talking to your assistant and hearing it answer."),
  page("permissions", "Permissions", "What your assistant may do without asking, and how much it may do at once."),
  page("computer", "Computer & browser", "What it may touch on this computer, in your browser and on your other machines."),
  page("secrets", "Secrets", "Keys and passwords your assistant may use, one item at a time."),
  page("data", "Data & usage", "What it costs, what is kept, and your safety copies."),
  page("advanced", "Advanced", "Tools for checking and fixing Branch."),
  page("about", "Updates & about", "Your version, and updates."),
  page("trunks", "Trunks & people", "Your own assistants, the computers they use, and the people who use Branch here."),
  page("channels", "Chat apps & devices", "The chat apps, pages and devices that reach Branch."),
  page("connections", "Connections", "Tool servers Branch uses, other AI tools using Branch, and your own accounts."),
  page("skills", "Skills & plugins", "What your assistant can do: skills, specialists and plugins."),
  page("memory", "Memory & library", "What it remembers, your documents and what it has made."),
  page("automations", "Automations & inbox", "Work that runs by itself, and how Inbox keeps the record."),
];
export const MODEL_TABS: Named[] = [
  tab("connection", "settings.models.connection", "Connection"), tab("defaults", "settings.models.defaults", "Defaults"),
  tab("local", "settings.models.local", "On this computer"), tab("second", "settings.models.second", "Second opinion"),
  tab("media", "settings.models.media", "Pictures & sound"),
];
export const PANE_TABS: Named[] = [
  tab("activity", "pane.activity", "Activity"), tab("plan", "pane.plan", "Plan"), tab("files", "pane.files", "Files"), tab("memory", "pane.memory", "Memory"),
];

/** Where the view is: a place and its tab, or a Settings page (and a Models tab). */
export type Route = { place: PlaceId; tab: string } | { settings: string; sub: string };

/** Every home the terminal can open, written as `docs/places.md` writes them. */
export function allHomes(): string[] {
  const homes = ["chat"];
  for (const place of ALL_PLACES) for (const entry of place.tabs) homes.push(`${place.id}:${entry.id}`);
  for (const entry of SETTINGS_PAGES) {
    if (entry.id === "models") for (const sub of MODEL_TABS) homes.push(`settings:models:${sub.id}`);
    else homes.push(`settings:${entry.id}`);
  }
  return homes;
}
export const placeById = (id: string): Place | undefined => ALL_PLACES.find((place) => place.id === id);
export const firstTab = (id: PlaceId): string => placeById(id)?.tabs[0]?.id ?? "";

const squash = (text: string): string => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** True when the typed words name this entry by id, English or the chosen language. */
const names = (entry: Named, words: Words | undefined, typed: string): boolean =>
  [entry.id, entry.english, words?.t(entry.key, entry.english) ?? ""].some((name) => name && squash(name) === typed);

/**
 * A route from what a person types: `inbox`, `inbox:finished`, `Made for you`, `settings models
 * defaults`, `Paramètres Modèles`, a Settings page's name on its own, and so on.
 */
export function parseRoute(text: string, words?: Words): Route | null {
  const parts = text.split(/[:›>/]/).map(squash).filter(Boolean);
  if (!parts.length) return null;
  const [head, ...rest] = parts.length === 1 ? splitWords(parts[0]!, words) : parts;
  const settingsWord = [squash("settings"), squash(words?.t("settings.title", "Settings") ?? "settings")];
  if (settingsWord.includes(head!)) return settingsRoute(rest, words);
  const place = ALL_PLACES.find((entry) => names(entry, words, head!));
  if (place) {
    const wanted = rest.join(" ");
    const chosen = place.tabs.find((entry) => names(entry, words, wanted));
    return { place: place.id as PlaceId, tab: chosen?.id ?? place.tabs[0]?.id ?? "" };
  }
  for (const entry of ALL_PLACES) {
    const chosen = entry.tabs.find((candidate) => names(candidate, words, parts.join(" ")));
    if (chosen) return { place: entry.id as PlaceId, tab: chosen.id };
  }
  return settingsRoute(parts, words);
}
/** "settings models defaults" typed as one run of words becomes its three parts. */
function splitWords(typed: string, words?: Words): string[] {
  const settings = squash(words?.t("settings.title", "Settings") ?? "settings");
  for (const lead of new Set(["settings", settings]))
    if (typed.startsWith(lead + " ")) return [lead, typed.slice(lead.length + 1)];
  const place = ALL_PLACES.find((entry) => [entry.id, squash(entry.english)].some((name) => typed.startsWith(name + " ")));
  return place ? [place.id, typed.slice(typed.indexOf(" ") + 1)] : [typed];
}
function settingsRoute(parts: string[], words?: Words): Route | null {
  const typed = parts.join(" ");
  if (!typed) return { settings: "general", sub: "" };
  const direct = SETTINGS_PAGES.find((entry) => names(entry, words, typed));
  if (direct) return { settings: direct.id, sub: direct.id === "models" ? "connection" : "" };
  const models = SETTINGS_PAGES.find((entry) => entry.id === "models")!;
  const [lead, ...tail] = parts.length > 1 ? parts : typed.split(" ");
  const sub = MODEL_TABS.find((entry) => names(entry, words, (names(models, words, lead ?? "") ? tail.join(" ") : typed)));
  return sub ? { settings: "models", sub: sub.id } : null;
}
/** The home a route stands for, as `docs/places.md` writes it. */
export function homeOf(route: Route): string {
  if ("place" in route) return route.place === "chat" ? "chat" : `${route.place}:${route.tab}`;
  return route.settings === "models" ? `settings:models:${route.sub || "connection"}` : `settings:${route.settings}`;
}

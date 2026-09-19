import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Redesign phase 1: the one quiet bar at the top of the conversation pane that recommends a setting.
 *
 * One bar at a time, at most once each time the window opens, never before the first-run screen is
 * done, and only in the owner's window. Each has Yes, Not now and Don't ask again, and nothing
 * changes unless Yes is pressed. In order of how much they matter:
 *
 *   background  Keep Branch running in the background, so a Trunk on Telegram (or any chat app, or
 *               an automation) keeps answering when the window is closed.
 *   updates     Keep Branch up to date by itself (`notify.autoUpdate` = install).
 *
 * "Not now" is remembered by the window for this launch only; "Don't ask again" is kept here.
 */
export const suggestionIds = ["background", "updates"] as const;
export type SuggestionId = (typeof suggestionIds)[number];

export const SuggestionsSettingsSchema = z.object({
  /** "ask" offers the bar when it applies; "never" is what Don't ask again writes. */
  background: z.enum(["ask", "never"]).default("ask"),
  updates: z.enum(["ask", "never"]).default("ask"),
}).strict();
export type SuggestionsSettings = z.infer<typeof SuggestionsSettingsSchema>;
const settingsKey = "suggestions";

export function suggestionsSettings(store: Pick<Store, "get">, owner: string): SuggestionsSettings {
  const saved = SuggestionsSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : SuggestionsSettingsSchema.parse({});
}
export const SuggestionAnswerSchema = z.object({ id: z.enum(suggestionIds), answer: z.literal("never") }).strict();
export function neverSuggest(store: Pick<Store, "get" | "save">, owner: string, input: unknown): SuggestionsSettings {
  const { id } = SuggestionAnswerSchema.parse(input);
  const next = { ...suggestionsSettings(store, owner), [id]: "never" };
  store.save("settings", owner, settingsKey, next);
  return next;
}

export interface SuggestionFacts {
  /** The owner, in the app window: not a household profile and not a short-lived key. */
  owner: boolean;
  /** The first-run screen has been finished. */
  onboarded: boolean;
  settings: SuggestionsSettings;
  /** Branch is installed on this computer, so a background engine can be set up at all. */
  installed: boolean;
  /** Branch already keeps working with the window closed (the background engine is set up, or this is it). */
  background: boolean;
  autoUpdate: "off" | "check" | "install";
}

/** The one bar to offer now, most important first, or null. */
export function nextSuggestion(facts: SuggestionFacts): SuggestionId | null {
  if (!facts.owner || !facts.onboarded) return null;
  if (facts.settings.background === "ask" && facts.installed && !facts.background) return "background";
  if (facts.settings.updates === "ask" && facts.autoUpdate === "off") return "updates";
  return null;
}

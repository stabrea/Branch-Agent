import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket 15: add-ons other people wrote. Each part has the owner's three-way switch — off, when
 * needed, on — and every one ships off, so a fresh install reads, installs and runs nothing here.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * One more choice sits beside the switches: whether plugin files the owner put in the plugins
 * folder by hand also run in their own walled program. It ships off, so a plugin a developer wrote
 * for themselves keeps working exactly as before; add-ons installed from a package or a list always
 * run walled, whatever this says.
 */
export const addOnParts = ["packages", "lists", "filters", "pipelines", "drafts", "search", "export"] as const;
export type AddOnPart = (typeof addOnParts)[number];
export const AddOnPartSchema = z.enum(addOnParts);
const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type AddOnMode = z.infer<typeof ModeSchema>;

export const AddOnSettingsSchema = z.object({
  modes: z.object(Object.fromEntries(addOnParts.map((part) => [part, ModeSchema.default("off")])) as Record<AddOnPart, z.ZodDefault<typeof ModeSchema>>).strict().prefault({}),
  /** Also run hand-placed plugin files in their own walled program. */
  wallEveryPlugin: z.boolean().default(false),
}).strict();
export type AddOnSettings = z.infer<typeof AddOnSettingsSchema>;

export const addOnSettingsKey = "add-ons";

/** What each part is, in the owner's words, for the card and for a refusal. */
export const addOnLabels: Record<AddOnPart, string> = {
  packages: "Installing add-on packages (Branch, Claude Code, Codex and Gemini CLI formats)",
  lists: "Add-on lists you name",
  filters: "Your own filters on what goes in and out",
  pipelines: "Reading a Pipelines server",
  drafts: "Letting the assistant draft an add-on for you to review",
  search: "Search sources that plugins bring",
  export: "Branch as a plugin for Claude Code and Codex",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const addOnTools: Partial<Record<AddOnPart, readonly string[]>> = {
  drafts: ["addon.draft"],
  search: ["addon.search"],
};

type Reader = Pick<Store, "get">;
export function addOnSettings(store: Reader, owner: string): AddOnSettings {
  const parsed = AddOnSettingsSchema.safeParse(store.get("settings", owner, addOnSettingsKey)?.data ?? {});
  return parsed.success ? parsed.data : AddOnSettingsSchema.parse({});
}

export function addOnMode(store: Reader, owner: string, part: AddOnPart): AddOnMode {
  return addOnSettings(store, owner).modes[part];
}

/** Saves a change: only the modes that were sent move, and the rest keep what they had. */
export function saveAddOnSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): AddOnSettings {
  const change = z.object({
    modes: z.object(Object.fromEntries(addOnParts.map((part) => [part, ModeSchema.optional()]))).strict().optional(),
    wallEveryPlugin: z.boolean().optional(),
  }).strict().parse(input ?? {});
  const current = addOnSettings(store, owner);
  const sent = Object.fromEntries(Object.entries(change.modes ?? {}).filter(([, mode]) => mode !== undefined));
  const next = AddOnSettingsSchema.parse({
    modes: { ...current.modes, ...sent },
    wallEveryPlugin: change.wallEveryPlugin ?? current.wallEveryPlugin,
  });
  store.save("settings", owner, addOnSettingsKey, next);
  return next;
}

export const partOffSentence = (part: AddOnPart): string =>
  `"${addOnLabels[part]}" is switched off. Switch it on in Customize, Plugins, to use it.`;

/** Throws the plain sentence when a part is off. */
export function requirePart(store: Reader, owner: string, part: AddOnPart): void {
  if (addOnMode(store, owner, part) === "off") throw new Error(partOffSentence(part));
}

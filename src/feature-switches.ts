import { z } from "zod";
import type { Store } from "./store.js";

/**
 * The owner's three-way switch for a feature: off, when needed, or on. Every one ships off.
 *
 *   off          the feature refuses in one plain sentence, and its tools are not advertised
 *   when-needed  the feature works, and its tools stay a line in the index (or a search away),
 *                loaded only when the work calls for them — the ordinary tiering in tool-loading.ts
 *   on           the feature works, and its tools are loaded from the first round
 *
 * Older saves only had a yes/no switch. A saved "yes" meant the tools were tiered like any other,
 * which is what "when needed" is now, so that is what it becomes.
 */
export const featureModes = ["off", "when-needed", "on"] as const;
export type FeatureMode = (typeof featureModes)[number];
export const FeatureModeSchema = z.enum(featureModes);

export interface Switched { enabled: boolean; mode: FeatureMode }

/** The mode a saved record stands for, whether it was written before or after the three-way switch. */
export function modeOf(saved: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }): FeatureMode {
  return saved.mode ?? (saved.enabled ? "when-needed" : "off");
}

/**
 * The switch after a change. A mode wins. A bare yes/no (the older tick box) turns the feature off,
 * or back on in the mode it had, "when needed" if it had none.
 */
export function settleSwitch(current: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }, input: { enabled?: boolean | undefined; mode?: FeatureMode | undefined }): Switched {
  const was = modeOf(current);
  let mode: FeatureMode = was;
  if (input.mode) mode = input.mode;
  else if (input.enabled === false) mode = "off";
  else if (input.enabled === true) mode = was === "off" ? "when-needed" : was;
  return { mode, enabled: mode !== "off" };
}

/**
 * Only the fields a caller really sent. A zod `.partial()` still fills in each field's default, so
 * without this, saving one limit would quietly switch the feature off.
 */
export function sentFields<T extends object>(parsed: T, input: unknown): Partial<T> {
  const sent = input && typeof input === "object" ? Object.keys(input) : [];
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => sent.includes(key))) as Partial<T>;
}

/**
 * The same object with every field optional and no defaults, for a form or tool that sends only
 * what changed. Unlike `.partial()`, which in zod 4 still fills each missing field with its default,
 * a field that was not sent stays missing, so merging over the saved settings keeps it.
 */
export function optionalFields<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) =>
    [key, (field instanceof z.ZodDefault ? field.unwrap() as z.ZodType : field as z.ZodType).optional()]));
  return z.object(shape as unknown as { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I> ? I : T[K]> }).strict();
}

/* ---------- which tools each switched feature owns ---------- */

/** The screen and keyboard tools (src/integrations/desktop-tools.ts). */
export const screenTools = ["desktop.screenshot", "desktop.windows", "desktop.read", "desktop.click",
  "desktop.type", "desktop.key", "desktop.open", "desktop.clipboard"] as const;
/** Reading aloud with the computer's own voice (src/voice-service.ts). */
export const systemVoiceTools = ["voice.say"] as const;

type Reader = Pick<Store, "get">;
const savedMode = (store: Reader, owner: string, key: string, field: "mode" | "systemVoice" = "mode"): FeatureMode => {
  const data = (store.get("settings", owner, key)?.data ?? {}) as Record<string, unknown>;
  const mode = FeatureModeSchema.safeParse(data[field]);
  if (mode.success) return mode.data;
  return field === "mode" && data.enabled === true ? "when-needed" : "off";
};

/**
 * Each switched feature that has tools, and where its mode is kept. `voice.say` also reads aloud
 * with a provider's voice, so the system voice being off refuses that one route rather than hiding
 * the tool; the refusal lives in the voice service.
 */
const toolFeatures: { reason: string; tools: readonly string[]; hideWhenOff: boolean; mode: (store: Reader, owner: string) => FeatureMode }[] = [
  { reason: "your screen and keyboard are switched on", tools: screenTools, hideWhenOff: true, mode: (s, o) => savedMode(s, o, "desktop-control") },
  { reason: "your computer's own voice is switched on", tools: systemVoiceTools, hideWhenOff: false, mode: (s, o) => savedMode(s, o, "voice", "systemVoice") },
];

/**
 * What the switches mean for one task's tool list: the tools to load from the start ("on"), and the
 * ones not to advertise ("off"). "When needed" adds nothing, because that is the ordinary tiering.
 */
export function switchedToolTiers(store: Reader, owner: string, available: readonly string[]): {
  preload: { name: string; reason: string }[]; hidden: string[];
} {
  const present = new Set(available);
  const preload: { name: string; reason: string }[] = [];
  const hidden: string[] = [];
  for (const feature of toolFeatures) {
    const mode = feature.mode(store, owner);
    const tools = feature.tools.filter((name) => present.has(name));
    if (mode === "on") preload.push(...tools.map((name) => ({ name, reason: feature.reason })));
    if (mode === "off" && feature.hideWhenOff) hidden.push(...tools);
  }
  return { preload, hidden };
}

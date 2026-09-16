import { z } from "zod";
import type { ModelRouter } from "./models.js";
import type { Store } from "./store.js";
import { tablePrice } from "./pricing.js";

/**
 * Routing profiles: a named set of choices about which connection answers which kind of work. A
 * profile is nothing but data — a list saved in settings — so the owner can read it, change it and
 * hand it to someone else. Branch fills in four to start with, worked out from the connections
 * that actually exist on this computer, so nothing in them points at a model that is not there.
 */
export const taskKinds = ["chat", "plan", "code", "vision", "voice", "embeddings", "summarise"] as const;
export type TaskKind = (typeof taskKinds)[number];

const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);
const ChoiceSchema = z.object({
  preset: presetId,
  /** Tried in this order when the first one is resting after a failure or is no longer set up. */
  fallbacks: z.array(presetId).max(8).default([]),
}).strict();
export const RoutingProfileSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(240).default(""),
  /** Used for any kind of work the profile does not name. */
  fallback: ChoiceSchema.optional(),
  routes: z.partialRecord(z.enum(taskKinds), ChoiceSchema).default({}),
}).strict();
export type RoutingProfile = z.infer<typeof RoutingProfileSchema>;

export const ProfileSettingsSchema = z.object({
  /** The profile in use, or null to leave the ordinary model choice alone. */
  active: z.string().max(64).nullable().default(null),
  profiles: z.array(RoutingProfileSchema).max(16).default([]),
}).strict();
export type ProfileSettings = z.infer<typeof ProfileSettingsSchema>;

export interface ProfileChoice {
  /** The connection to use, or null when the profile has nothing usable to say. */
  preset: string | null;
  profile: string | null;
  kind: TaskKind;
  /** One plain sentence for the run inspector: why this model and not another. */
  reason: string;
}

/** A price to compare connections by: dollars per million output tokens, or null with none on file. */
function priceOf(model: string): number | null {
  const price = tablePrice(model);
  return price ? price.output : null;
}

/**
 * The four profiles Branch starts with, built from the connections that exist right now. Ordering
 * is always something that can be justified: what runs here, and what the price table says. A
 * connection with no price on file is put last rather than guessed at.
 */
export function defaultProfiles(models: ModelRouter): RoutingProfile[] {
  const presets = [...models.presets.values()].map((preset) => ({
    id: preset.id, local: models.runsLocally(preset.id), price: priceOf(preset.model),
  }));
  const cheapFirst = [...presets].sort(byCheapest);
  const dearFirst = [...presets].sort((a, b) => byCheapest(b, a));
  const local = presets.filter((preset) => preset.local).map((preset) => preset.id);
  return [
    profile("cheap-and-fast", "Cheap and fast", "Whatever runs on this computer first, then the least expensive connection with a price on file.", cheapFirst.map((p) => p.id)),
    profile("best-quality", "Best quality", "The most expensive connection first, which is the only ranking Branch can justify from published prices.", dearFirst.map((p) => p.id)),
    profile("private", "Private", "Only connections that run on this computer, so nothing leaves it. Empty until you set one up.", local),
    profile("long-context", "Long context", "Your own order for very long pieces of work. Branch cannot read how much a cloud model holds, so this list starts the same as Best quality and is yours to change.", dearFirst.map((p) => p.id)),
  ];
}
function byCheapest(a: { local: boolean; price: number | null }, b: { local: boolean; price: number | null }): number {
  if (a.local !== b.local) return a.local ? -1 : 1;
  if (a.price === null || b.price === null) return a.price === null ? 1 : -1;
  return a.price - b.price;
}
function profile(id: string, name: string, description: string, order: string[]): RoutingProfile {
  const first = order[0];
  return RoutingProfileSchema.parse({
    id, name, description,
    ...(first ? { fallback: { preset: first, fallbacks: order.slice(1, 9) } } : {}),
    routes: {},
  });
}

export function profileSettings(store: Store, owner: string, models: ModelRouter): ProfileSettings {
  const saved = ProfileSettingsSchema.safeParse(store.get("settings", owner, "model-profiles")?.data ?? {});
  const value = saved.success ? saved.data : ProfileSettingsSchema.parse({});
  if (!value.profiles.length) value.profiles = defaultProfiles(models);
  return value;
}

export function saveProfileSettings(store: Store, owner: string, models: ModelRouter, input: unknown): ProfileSettings {
  const value = ProfileSettingsSchema.parse({ ...profileSettings(store, owner, models), ...(input as object) });
  if (value.active && !value.profiles.some((entry) => entry.id === value.active))
    throw new Error(`There is no routing profile called ${value.active}`);
  if (new Set(value.profiles.map((entry) => entry.id)).size !== value.profiles.length)
    throw new Error("Two profiles cannot share a name");
  store.save("settings", owner, "model-profiles", value);
  return value;
}

/**
 * Which connection a profile sends this kind of work to. Candidates are tried in the order the
 * profile lists them, skipping anything that is no longer set up or is resting after a failure,
 * and the reason says in one sentence which rule fired — that sentence is what the inspector shows.
 */
export function chooseFromProfile(
  profile: RoutingProfile | null,
  kind: TaskKind,
  known: (id: string) => boolean,
  resting: (id: string) => boolean,
): ProfileChoice {
  if (!profile) return { preset: null, profile: null, kind, reason: "No routing profile is switched on, so your usual choice answered" };
  const choice = profile.routes[kind] ?? profile.fallback;
  const named = profile.routes[kind] ? `for ${kind}` : "for anything it does not name";
  if (!choice) return { preset: null, profile: profile.id, kind, reason: `The "${profile.name}" profile has nothing set up ${named}, so your usual choice answered` };
  const order = [choice.preset, ...choice.fallbacks];
  const usable = order.filter(known);
  const first = usable.find((id) => !resting(id));
  if (!first)
    return { preset: null, profile: profile.id, kind,
      reason: `Every connection the "${profile.name}" profile lists ${named} is resting or no longer set up, so your usual choice answered` };
  if (first === order[0])
    return { preset: first, profile: profile.id, kind, reason: `The "${profile.name}" profile sends ${kind} work to ${first}` };
  const skipped = order.slice(0, order.indexOf(first));
  return { preset: first, profile: profile.id, kind,
    reason: `The "${profile.name}" profile asked for ${skipped.join(", ")} first ${named}, but ${skipped.length > 1 ? "none were" : "it was not"} available, so ${first} took it` };
}

/** The whole decision for one piece of work: reads the saved profiles and resolves the candidates. */
export function routeByProfile(store: Store, models: ModelRouter, owner: string, kind: TaskKind): ProfileChoice {
  const settings = profileSettings(store, owner, models);
  const active = settings.profiles.find((entry) => entry.id === settings.active) ?? null;
  return chooseFromProfile(active, kind, (id) => models.presets.has(id), (id) => models.coolingDown(id));
}

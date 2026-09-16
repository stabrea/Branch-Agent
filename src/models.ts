import { z } from "zod";
import type { Provider } from "./contracts.js";
import type { Store } from "./store.js";
import { fallbackEligible } from "./provider-retry.js";

export const reasoningEfforts = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];
export interface ModelPreset {
  id: string;
  name: string;
  provider: Provider;
  model: string;
  reasoning?: ReasoningEffort;
}
export interface ModelChoice {
  presetId: string;
  presetName: string;
  provider: string;
  model: string;
  reasoning: ReasoningEffort | null;
  source: "session" | "project" | "owner" | "default" | "cooldown";
  /** True when this model runs on this computer, so nothing leaves it and nothing is charged. */
  local: boolean;
}
const onThisComputer = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/**
 * Whether a connection's address is on this computer. Providers already hand out their own address
 * for the routes they share (embeddings, audio), so no new provider method is needed.
 */
export function presetRunsLocally(preset: ModelPreset): boolean {
  const sharing = preset.provider as { embeddings?: () => { endpoint: string } | null; audio?: () => { endpoint: string } | null };
  const route = sharing.embeddings?.() ?? sharing.audio?.() ?? null;
  if (!route) return false;
  try { return onThisComputer.has(new URL(route.endpoint).hostname.toLowerCase()); } catch { return false; }
}
const presetId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);
const reasoning = z.enum(reasoningEfforts).nullable();
export const ModelSettingsSchema = z.object({
  activePreset: presetId.nullable().default(null),
  fallbackOrder: z.array(presetId).max(16).default([]),
  cooldownMs: z.number().int().min(0).max(3_600_000).default(60_000),
  reasoning: reasoning.default(null),
}).strict();
export const SessionModelSchema = z.object({
  preset: presetId.nullable().default(null),
  reasoning: reasoning.default(null),
}).strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
/** A one-run choice, for example from the terminal's /model and /think commands. */
export interface RunModelOverride { preset?: string | null; reasoning?: ReasoningEffort | null }
export type SessionModel = z.infer<typeof SessionModelSchema>;

export class ModelRouter {
  private readonly registry = new Map<string, ModelPreset>();
  private readonly cooldowns = new Map<string, number>();
  constructor(
    private readonly store: Store,
    presets: ModelPreset[],
    /** Clock used for cooldowns; tests may replace it. */
    public now: () => number = Date.now,
  ) {
    if (!presets.length) throw new Error("At least one model preset is required");
    for (const preset of presets) this.register(preset);
  }
  get presets(): ReadonlyMap<string, ModelPreset> {
    return this.registry;
  }
  get default(): ModelPreset {
    return this.registry.values().next().value as ModelPreset;
  }
  /** Adds a preset at runtime, for example after a ChatGPT sign-in. Existing ids are replaced in place. */
  register(preset: ModelPreset): void {
    presetId.parse(preset.id);
    if (this.registry.size >= 32 && !this.registry.has(preset.id)) throw new Error("At most 32 model presets");
    this.registry.set(preset.id, preset);
  }
  /** Removes presets whose id starts with the prefix; the first remaining preset becomes the default. */
  unregister(prefix: string): string[] {
    const removed = [...this.registry.keys()].filter(id => id.startsWith(prefix));
    if (removed.length === this.registry.size) throw new Error("At least one model preset must remain");
    for (const id of removed) { this.registry.delete(id); this.cooldowns.delete(id); }
    return removed;
  }
  settings(owner: string): ModelSettings {
    const saved = ModelSettingsSchema.safeParse(this.store.get("settings", owner, "models")?.data ?? {});
    const value = saved.success ? saved.data : ModelSettingsSchema.parse({});
    if (value.activePreset && !this.presets.has(value.activePreset)) value.activePreset = null;
    value.fallbackOrder = value.fallbackOrder.filter(id => this.presets.has(id));
    return value;
  }
  configure(owner: string, input: unknown): ModelSettings {
    const value = ModelSettingsSchema.parse({ ...this.settings(owner), ...(input as object) });
    for (const id of [value.activePreset, ...value.fallbackOrder])
      if (id && !this.presets.has(id)) throw new Error(`Unknown model preset ${id}`);
    if (new Set(value.fallbackOrder).size !== value.fallbackOrder.length)
      throw new Error("Fallback order lists a preset twice");
    this.store.save("settings", owner, "models", value);
    return value;
  }
  session(owner: string, sessionId: string): SessionModel {
    const saved = SessionModelSchema.safeParse(this.store.get("settings", owner, `session-model:${sessionId}`)?.data ?? {});
    const value = saved.success ? saved.data : SessionModelSchema.parse({});
    if (value.preset && !this.presets.has(value.preset)) value.preset = null;
    return value;
  }
  configureSession(owner: string, sessionId: string, input: unknown): SessionModel {
    if (!this.store.ownsSession(owner, sessionId)) throw new Error("Session not found");
    const value = SessionModelSchema.parse({ ...this.session(owner, sessionId), ...(input as object) });
    if (value.preset && !this.presets.has(value.preset)) throw new Error(`Unknown model preset ${value.preset}`);
    this.store.save("settings", owner, `session-model:${sessionId}`, value);
    return value;
  }
  /** Ordered candidates: the chosen preset first, then configured fallbacks that are not cooling down. */
  plan(owner: string, sessionId: string, override: RunModelOverride = {}): { choice: ModelChoice; candidates: ModelPreset[] } {
    if (override.preset && !this.presets.has(override.preset)) throw new Error(`Unknown model preset ${override.preset}`);
    const owned = this.settings(owner), scoped = this.session(owner, sessionId);
    const chosen = override.preset ?? scoped.preset;
    const project = this.store.projects.active(owner).modelPreset;
    const projectPreset = project && this.presets.has(project) ? project : null;
    const source = chosen ? "session" : projectPreset ? "project" : owned.activePreset ? "owner" : "default";
    const first = this.presets.get(chosen ?? projectPreset ?? owned.activePreset ?? this.default.id) ?? this.default;
    const effort = override.reasoning !== undefined ? override.reasoning : (scoped.reasoning ?? owned.reasoning ?? first.reasoning ?? null);
    const fallbacks = owned.fallbackOrder
      .filter(id => id !== first.id && !this.coolingDown(id))
      .map(id => this.presets.get(id)!);
    if (this.coolingDown(first.id) && fallbacks.length)
      return { choice: this.describe(fallbacks[0]!, effort, "cooldown"), candidates: fallbacks };
    return { choice: this.describe(first, effort, source), candidates: [first, ...fallbacks] };
  }
  describe(preset: ModelPreset, effort: ReasoningEffort | null, source: ModelChoice["source"]): ModelChoice {
    return { presetId: preset.id, presetName: preset.name, provider: preset.provider.name,
      model: preset.model, reasoning: effort, source, local: presetRunsLocally(preset) };
  }
  /** Whether the named connection runs on this computer. Unknown names are not local. */
  runsLocally(id: string): boolean {
    const preset = this.registry.get(id);
    return preset ? presetRunsLocally(preset) : false;
  }
  /** Records a cooldown for an eligible provider failure; returns the cooldown end or null when not eligible. */
  markFailure(owner: string, id: string, error: unknown): string | null {
    if (!fallbackEligible(error)) return null;
    const until = this.now() + this.settings(owner).cooldownMs;
    this.cooldowns.set(id, until);
    return new Date(until).toISOString();
  }
  coolingDown(id: string): boolean {
    const until = this.cooldowns.get(id);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.cooldowns.delete(id);
    return false;
  }
  summary(owner: string) {
    const settings = this.settings(owner);
    return {
      ...settings,
      defaultPreset: this.default.id,
      presets: [...this.presets.values()].map(preset => ({
        id: preset.id, name: preset.name, provider: preset.provider.name, model: preset.model,
        reasoning: preset.reasoning ?? null,
        local: presetRunsLocally(preset),
        coolingDownUntil: this.coolingDown(preset.id) ? new Date(this.cooldowns.get(preset.id)!).toISOString() : null,
      })),
    };
  }
}

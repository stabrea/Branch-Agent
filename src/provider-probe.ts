import type { Provider } from "./contracts.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import { providerEmbeddings, supportsImages } from "./providers.js";
import { geminiAuth } from "./voice-stt.js";

/**
 * What each model connection can actually do, asked of the service itself rather than guessed
 * from its name. One small, free request per connection — the list of models — tells us whether
 * the key still works; everything else is read from what the connection says about itself.
 */
export interface ProviderProbe {
  id: string;
  name: string;
  model: string;
  /** True when the service answered the list-of-models request without complaining about the key. */
  signedIn: boolean;
  /** How many models the service listed, or null when it does not offer a list. */
  models: number | null;
  supportsAudio: boolean;
  supportsImages: boolean;
  supportsEmbeddings: boolean;
  onThisComputer: boolean;
  resting: boolean;
  /** One line a person can act on. */
  summary: string;
  fix?: string;
}

/** The list-of-models address for a connection, or null when it does not offer one. */
export function modelsUrl(provider: Provider): { url: string; headers: Record<string, string> } | null {
  const audio = provider.audio?.() ?? null;
  const shared = audio ?? providerEmbeddings(provider);
  if (!shared) return null;
  // A Gemini sign-in hands back an OAuth token, not a key. Google refuses one in the key header,
  // so `bearer` decides which header it goes in — the same choice speech and pictures make.
  if (provider.name === "gemini")
    return { url: shared.endpoint.replace(/\/$/, "") + "/v1beta/models", headers: geminiAuth(shared) };
  return { url: shared.endpoint.replace(/\/$/, "") + "/models", headers: { authorization: `Bearer ${shared.apiKey}` } };
}

/** Counts the models in whichever shape the service answered with, without trusting either. */
export function countModels(body: unknown): number | null {
  const shape = body as { data?: unknown[]; models?: unknown[] };
  if (Array.isArray(shape?.data)) return shape.data.length;
  if (Array.isArray(shape?.models)) return shape.models.length;
  return null;
}

/** Asks one connection what it can do. Never throws: a connection that fails reports why. */
export async function probeProvider(
  models: ModelRouter, id: string, policy: NetworkPolicy, fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderProbe> {
  const preset = models.presets.get(id);
  if (!preset) throw new Error(`There is no connection called ${id}`);
  const base: ProviderProbe = {
    id, name: preset.name, model: preset.model, signedIn: false, models: null,
    supportsAudio: (preset.provider.audio?.() ?? null) !== null,
    supportsImages: supportsImages(preset.provider),
    supportsEmbeddings: providerEmbeddings(preset.provider) !== null,
    onThisComputer: models.runsLocally(id),
    resting: models.coolingDown(id),
    summary: "",
  };
  const target = modelsUrl(preset.provider);
  if (!target)
    return { ...base, summary: `${preset.name} does not offer a list of models, so its key can only be checked by using it.`,
      fix: "Press Test under Settings → Models to send one small request." };
  try {
    await policy.assertAllowed(new URL(target.url), "model connection check");
    const response = await fetchImpl(target.url, { headers: target.headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok)
      return { ...base, summary: `${preset.name} answered ${response.status} when asked what models it has.`,
        fix: response.status === 401 || response.status === 403
          ? "The key was refused. Put a fresh one in under Settings → Models."
          : "The service is there but would not answer. Try again in a moment." };
    const listed = countModels(await response.json().catch(() => null));
    return { ...base, signedIn: true, models: listed, summary: describe(preset.name, listed, base) };
  } catch (error) {
    return { ...base, summary: `${preset.name} could not be reached: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`,
      fix: "Check the address under Settings → Models, and that this computer is online." };
  }
}

function describe(name: string, listed: number | null, probe: ProviderProbe): string {
  const can = [probe.supportsAudio ? "speech" : "", probe.supportsImages ? "pictures" : "", probe.supportsEmbeddings ? "comparing passages" : ""].filter(Boolean);
  return `${name} answered${listed === null ? "" : ` with ${listed} model(s)`}; it can do ${can.length ? can.join(", ") : "text only"}.`;
}

/** Every connection at once, for `branch doctor` and Settings → Models. */
export async function probeAll(
  models: ModelRouter, policy: NetworkPolicy, fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderProbe[]> {
  return Promise.all([...models.presets.keys()].map((id) => probeProvider(models, id, policy, fetchImpl)));
}

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Provider } from "./contracts.js";
import type { ModelRouter } from "./models.js";

/**
 * A plugin may bring its own way of talking to a model. It exports one or more provider adapters
 * under `plugin.provider.<id>`; each is a factory that, given the address and the name of a saved
 * secret, hands back something that answers the same way every built-in connection does. Nothing
 * else about the plugin changes: the file still only loads when the owner switches the plugin on,
 * and the address it reaches still has to pass the network settings, because the adapter is handed
 * the check to call rather than being trusted to make the request on its own terms.
 *
 * This slots into the plugin loader: a plugin's default export may carry `providers`, beside the
 * `tools` and `hooks` it already carries.
 */
export const providerPluginId = z.string().regex(/^plugin\.provider\.[a-z][a-z0-9-]{0,30}$/,
  "Provider plugins are named plugin.provider.<id>");

export interface ProviderPluginSetup {
  /** Where the model lives. The plugin never chooses this; the owner types it in. */
  endpoint: string;
  /** The key for that address, already taken out of the locker. Empty when none is needed. */
  apiKey: string;
  /** The model name the owner picked. */
  model: string;
  /** Refuses an address the owner's network settings do not allow. Call it before every request. */
  assertAllowed(url: URL, description: string): Promise<void>;
  /** The fetch to use, so tests and the network settings can stand in front of it. */
  fetch: typeof fetch;
  userAgent: string;
}
export interface BranchPluginProvider {
  /** Must be plugin.provider.<id>, so a plugin cannot claim a name that looks built in. */
  id: string;
  /** What to call it in the model list, in the owner's words. */
  name: string;
  description?: string;
  /** Makes one connection. Called again whenever the owner saves different settings. */
  create(setup: ProviderPluginSetup): Provider;
}
/** What the plugin loader sees on a plugin that brings providers as well as tools and hooks. */
export interface ProviderCapablePlugin { id: string; providers?: BranchPluginProvider[] }

export const ProviderPresetInputSchema = z.object({
  /** Which registered plugin adapter to use. */
  driver: providerPluginId,
  /** The preset id the owner will see in the model list. */
  preset: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  name: z.string().trim().min(1).max(80),
  endpoint: z.string().url(),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().max(400).default(""),
}).strict();
export type ProviderPresetInput = z.infer<typeof ProviderPresetInputSchema>;

export interface ProviderPluginSummary { id: string; name: string; description: string; plugin: string }

/**
 * The adapters plugins have brought. Registering one only makes it available to choose; a model
 * preset is made from it separately, so a plugin cannot quietly become the model the owner uses.
 */
export class ProviderPlugins {
  private readonly drivers = new Map<string, { entry: BranchPluginProvider; plugin: string }>();
  /** Which model presets each adapter was used to make, so they go when the plugin does. */
  private readonly presets = new Map<string, string[]>();
  constructor(
    private readonly models: ModelRouter,
    private readonly guard: { assertAllowed(url: URL, description: string): Promise<void> },
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly userAgent = "BranchAgent",
  ) {}
  /** Adds one adapter from a plugin; the name and the factory are checked before it is kept. */
  register(pluginId: string, entry: BranchPluginProvider): ProviderPluginSummary {
    providerPluginId.parse(String(entry?.id ?? ""));
    if (typeof entry.create !== "function") throw new Error(`The provider ${entry.id} has no create function`);
    if (this.drivers.has(entry.id)) throw new Error(`A provider called ${entry.id} is already registered`);
    const summary = { id: entry.id, name: String(entry.name ?? entry.id).slice(0, 80), description: String(entry.description ?? "").slice(0, 300), plugin: pluginId };
    this.drivers.set(entry.id, { entry, plugin: pluginId });
    return summary;
  }
  /** Every adapter a plugin brought, with which plugin brought it. */
  list(): ProviderPluginSummary[] {
    return [...this.drivers.values()].map(({ entry, plugin }) => ({
      id: entry.id, name: String(entry.name ?? entry.id).slice(0, 80),
      description: String(entry.description ?? "").slice(0, 300), plugin,
    }));
  }
  /** Takes one plugin's adapters back out, with every model preset made from them. */
  forget(pluginId: string): { drivers: string[]; presets: string[] } {
    const drivers: string[] = [], presets: string[] = [];
    for (const [id, held] of this.drivers) {
      if (held.plugin !== pluginId) continue;
      this.drivers.delete(id);
      drivers.push(id);
      for (const preset of this.presets.get(id) ?? []) { this.models.unregister(preset); presets.push(preset); }
      this.presets.delete(id);
    }
    return { drivers, presets };
  }
  /**
   * The fetch handed to an adapter checks the address against the owner's network settings itself,
   * so a plugin that simply makes its request still cannot reach somewhere they have not allowed.
   */
  private guardedFetch(): typeof fetch {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      await this.guard.assertAllowed(url, "a model connection a plugin brought");
      return this.fetchImpl(input as RequestInfo, init);
    };
  }
  /** Makes a connection from one adapter, without adding it to the model list. */
  connect(input: unknown): Provider {
    const value = ProviderPresetInputSchema.parse(input);
    const held = this.drivers.get(value.driver);
    if (!held) throw new Error(`No plugin has brought a provider called ${value.driver}`);
    const provider = held.entry.create({
      endpoint: value.endpoint, apiKey: value.apiKey, model: value.model,
      assertAllowed: (url, description) => this.guard.assertAllowed(url, description),
      fetch: this.guardedFetch(), userAgent: this.userAgent,
    });
    if (!provider || typeof provider.complete !== "function")
      throw new Error(`${value.driver} did not return something that can answer a question`);
    return provider;
  }
  /** Makes a connection and puts it in the model list, so the owner can pick it like any other. */
  addPreset(input: unknown): { preset: string; name: string; driver: string; model: string } {
    const value = ProviderPresetInputSchema.parse(input);
    const provider = this.connect(value);
    this.models.register({ id: value.preset, name: value.name, provider, model: value.model });
    const made = this.presets.get(value.driver) ?? [];
    if (!made.includes(value.preset)) made.push(value.preset);
    this.presets.set(value.driver, made);
    return { preset: value.preset, name: value.name, driver: value.driver, model: value.model };
  }
}

/**
 * Reads one plugin file and hands back the provider adapters it declares. This runs the code in
 * that file, which is why it is only ever called for a plugin the owner has switched on.
 */
export async function readProviderPlugin(folder: string, id: string): Promise<BranchPluginProvider[]> {
  z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).parse(id);
  const file = join(folder, `${id}.mjs`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`There is no plugin file called ${id}.mjs`);
  const module = await import(`${pathToFileURL(file).href}?loaded=${info.mtimeMs}`) as { default?: ProviderCapablePlugin };
  const plugin = module.default;
  if (!plugin || typeof plugin !== "object") throw new Error(`${id}.mjs does not export a plugin as its default export`);
  if (plugin.id !== id) throw new Error(`The plugin file is called ${id}.mjs but declares the id "${plugin.id}"`);
  return Array.isArray(plugin.providers) ? plugin.providers : [];
}

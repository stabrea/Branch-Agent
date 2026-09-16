import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { schemaFor } from "./skill-http-tools.js";
import { ParametersSchema, type InputValue } from "./recipes.js";
import type { BranchPluginProvider } from "./provider-plugins.js";

/**
 * Plugins are single files a developer drops into the `plugins` folder beside the private data.
 * A plugin may add tools and may react to events; it may not add screens to the app. Nothing a
 * plugin brings is loaded until the owner switches it on, and every tool it adds still needs the
 * permission the plugin declared, checked the same way every built-in tool is checked. That
 * permission check is the only thing keeping a plugin in bounds: a plugin runs as part of the
 * assistant, with the same reach over this computer, so only install files you trust.
 */
export const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const PluginManifestSchema = z.object({
  id: pluginId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(20).default([]),
}).strict();
export interface BranchPluginTool {
  /** Must be plugin.<id>.<name>, so a plugin cannot claim a name that looks built in. */
  name: string;
  description: string;
  /** One of the permissions the plugin declares; the owner's task must hold it for the tool to run. */
  permission: string;
  /** Declared inputs, the same shape a recipe uses: name to { type, required, description }. */
  input?: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; description?: string; default?: InputValue }>;
  run(args: Record<string, InputValue>, context: ToolContext): Promise<unknown>;
}
export interface BranchPluginHook { event: string; run(payload: { event: string; runId: string; data: Record<string, unknown> }): Promise<void> }
export interface BranchPlugin {
  id: string; name: string; description?: string; permissions?: string[];
  tools?: BranchPluginTool[]; hooks?: BranchPluginHook[];
  /** Ways of talking to a model this plugin brings; see src/provider-plugins.ts. */
  providers?: BranchPluginProvider[];
}
/** Where a plugin's model connections go. Kept structural so the loader needs no extra import. */
export interface PluginProviderHost {
  register(pluginId: string, entry: BranchPluginProvider): unknown;
  forget(pluginId: string): unknown;
}
export interface PluginSummary { id: string; name: string; description: string; permissions: string[]; tools: { name: string; description: string; permission: string }[]; hooks: string[] }
interface Loaded { summary: PluginSummary; toolNames: string[]; stopHooks: (() => void)[] }

export class Plugins {
  private readonly loaded = new Map<string, Loaded>();
  /** Set by the launch when this copy can hold model connections; left unset, plugins bring none. */
  providers?: PluginProviderHost | undefined;
  constructor(private readonly store: Store, private readonly owner: string, private readonly registry: ToolRegistry, private readonly folder: string) {}
  private key(id: string): string { return `plugin:${id}`; }
  private saved(id: string): { enabled: boolean; summary?: PluginSummary } | undefined {
    return this.store.get("settings", this.owner, this.key(id))?.data as { enabled: boolean; summary?: PluginSummary } | undefined;
  }
  /** The plugin files present, with what the owner already decided. Listing does not load any file. */
  async list() {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    return names.filter((name) => name.endsWith(".mjs")).map((name) => {
      const id = name.slice(0, -4), saved = this.saved(id);
      return { id, file: name, enabled: saved?.enabled === true, loaded: this.loaded.has(id), summary: saved?.summary ?? null };
    });
  }
  /** Loads one plugin file to show what it would add. This runs the code in that file. */
  async inspect(id: string): Promise<PluginSummary> {
    const plugin = await this.read(id);
    const manifest = PluginManifestSchema.parse({ id: plugin.id, name: plugin.name, description: plugin.description ?? "", permissions: plugin.permissions ?? [] });
    if (manifest.id !== id) throw new Error(`The plugin file is called ${id}.mjs but declares the id "${manifest.id}"`);
    const tools = (plugin.tools ?? []).map((tool) => this.checkTool(manifest, tool));
    const hooks = (plugin.hooks ?? []).map((hook) => String(hook.event));
    return { ...manifest, tools, hooks };
  }
  private checkTool(manifest: z.infer<typeof PluginManifestSchema>, tool: BranchPluginTool) {
    const shape = new RegExp(`^plugin\\.${manifest.id}\\.[a-z][a-z0-9_]{0,30}$`);
    if (!shape.test(String(tool.name))) throw new Error(`Plugin tools are named plugin.${manifest.id}.<name>; "${tool.name}" is not`);
    if (!manifest.permissions.includes(tool.permission))
      throw new Error(`The tool ${tool.name} asks for the permission "${tool.permission}", which this plugin does not declare`);
    if (typeof tool.run !== "function") throw new Error(`The tool ${tool.name} has no run function`);
    return { name: tool.name, description: String(tool.description ?? "").slice(0, 300), permission: tool.permission };
  }
  private async read(id: string): Promise<BranchPlugin> {
    pluginId.parse(id);
    const file = join(this.folder, `${id}.mjs`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`There is no plugin file called ${id}.mjs`);
    const module = await import(`${pathToFileURL(file).href}?loaded=${info.mtimeMs}`) as { default?: BranchPlugin };
    if (!module.default || typeof module.default !== "object") throw new Error(`${id}.mjs does not export a plugin as its default export`);
    return module.default;
  }
  /** Switches a plugin on: its tools join the catalog and its hooks start listening. */
  async enable(id: string): Promise<PluginSummary> {
    if (this.loaded.has(id)) return this.loaded.get(id)!.summary;
    const plugin = await this.read(id), summary = await this.inspect(id);
    const toolNames: string[] = [], stopHooks: (() => void)[] = [];
    try {
      for (const tool of plugin.tools ?? []) {
        this.registry.register({
          name: tool.name, description: tool.description, permission: tool.permission, external: true,
          parameters: schemaFor(ParametersSchema.parse(tool.input ?? {})),
          execute: async (args, context) => tool.run(args, context),
        });
        toolNames.push(tool.name);
      }
      // A way of talking to a model is only made available to choose; no model is switched over.
      for (const provider of plugin.providers ?? []) this.providers?.register(id, provider);
    } catch (error) {
      for (const name of toolNames) this.registry.unregister(name);
      this.providers?.forget(id);
      throw error;
    }
    for (const hook of plugin.hooks ?? [])
      stopHooks.push(this.store.onEvent((runId, kind, data) => { if (kind === hook.event) void hook.run({ event: kind, runId, data }).catch(() => undefined); }));
    this.loaded.set(id, { summary, toolNames, stopHooks });
    this.store.save("settings", this.owner, this.key(id), { enabled: true, summary });
    return summary;
  }
  /** Takes a plugin out of this running copy without changing the owner's choice. */
  private unload(id: string): void {
    const entry = this.loaded.get(id);
    for (const name of entry?.toolNames ?? []) this.registry.unregister(name);
    for (const stop of entry?.stopHooks ?? []) stop();
    // Its model connections go with it, along with every preset made from them.
    if (entry) this.providers?.forget(id);
    this.loaded.delete(id);
  }
  /** Switches a plugin off: its tools leave the catalog, its hooks stop, and it stays off next time. */
  disable(id: string): { id: string; enabled: false } {
    this.unload(id);
    const saved = this.saved(id);
    this.store.save("settings", this.owner, this.key(id), { enabled: false, ...(saved?.summary ? { summary: saved.summary } : {}) });
    return { id, enabled: false };
  }
  /** Loads the plugins the owner switched on before, at start-up. A broken one is reported, not fatal. */
  async restore(): Promise<{ id: string; error: string }[]> {
    const problems: { id: string; error: string }[] = [];
    for (const entry of await this.list())
      if (entry.enabled) await this.enable(entry.id).catch((error: unknown) => problems.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) }));
    return problems;
  }
  /** Shutdown: unload everything without turning the owner's choices off. */
  stop(): void { for (const id of [...this.loaded.keys()]) this.unload(id); }
}

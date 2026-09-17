import { z } from "zod";
import { ApprovalRequiredError } from "../approvals.js";
import type { ToolContext } from "../contracts.js";
import type { Plugins } from "../plugins.js";
import type { ToolRegistry } from "../registry.js";
import type { ToolGateOptions } from "../tool-gate.js";

/**
 * Bucket 15 (A2130): search sources that plugins bring.
 *
 * A plugin tool may say it is a search source (`search: { label }`). `addon.search` puts every such
 * source the owner has switched on behind one name, so a task can search "everywhere my add-ons
 * look" or one source by its label.
 *
 * It never reaches further than calling each source directly would: a source whose permission this
 * task does not hold is skipped, and each call goes through the same gate as a hand-run tool
 * (src/tool-gate.ts) in its strict mode — a source your rules would ask about is not run, and the
 * answer says to call it directly so the question can be put to you.
 */
export const searchToolName = "addon.search";
export interface SearchSource { tool: string; label: string; permission: string; plugin: string }
type Execute = (name: string, args: unknown, options: ToolGateOptions) => Promise<unknown>;

/** Every search source from the plugins that are switched on and loaded right now. */
export async function searchSources(plugins: Plugins, registry: ToolRegistry): Promise<SearchSource[]> {
  const present = new Set(registry.names());
  const sources: SearchSource[] = [];
  for (const entry of await plugins.list()) {
    if (!entry.loaded || !entry.summary) continue;
    for (const tool of entry.summary.tools)
      if (tool.search && present.has(tool.name)) sources.push({ tool: tool.name, label: tool.search, permission: tool.permission, plugin: entry.id });
  }
  return sources;
}

const Input = z.object({ query: z.string().trim().min(1).max(500), source: z.string().trim().max(60).optional() }).strict();

async function searchOne(source: SearchSource, query: string, context: ToolContext, execute: Execute) {
  if (!context.permissions.has(source.permission))
    return { source: source.label, skipped: `This task may not use ${source.permission}.` };
  if (context.dryRun) return { source: source.label, skipped: `A practice run would have searched ${source.label}.` };
  try {
    const found = await execute(source.tool, { query }, { mode: "policy", source: context.source ?? "owner",
      ...(context.approvalKey ? { approvalKey: context.approvalKey } : {}) });
    return { source: source.label, results: found };
  } catch (error) {
    if (error instanceof ApprovalRequiredError) return { source: source.label, skipped: `Your rules ask first about this source; call ${source.tool} directly.` };
    return { source: source.label, skipped: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

export function registerSearchTool(registry: ToolRegistry, plugins: Plugins, execute: Execute): void {
  registry.register({
    name: searchToolName,
    description: "Search the sources your switched-on plugins bring, all at once or one by its label. With no query match, lists the sources.",
    permission: "addons.search",
    parameters: Input,
    execute: async (args, context) => {
      const sources = await searchSources(plugins, registry);
      const chosen = args.source ? sources.filter((source) => source.label.toLowerCase() === args.source!.toLowerCase()) : sources;
      if (!chosen.length) return { sources: sources.map((source) => source.label), results: [], note: sources.length ? `No source is called ${args.source}.` : "No plugin that is switched on brings a search source." };
      const results = [];
      for (const source of chosen.slice(0, 8)) results.push(await searchOne(source, args.query, context, execute));
      return { sources: sources.map((source) => source.label), results };
    },
  });
}

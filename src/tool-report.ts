import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { catalogHealthId, type CatalogHealth, type PreloadReason } from "./tool-usage.js";

/**
 * What the Developer card shows: which tools travelled with the last request and which were only
 * mentioned by name, what the tool list weighed against its ceiling, what this computer decided to
 * load before being asked and why, and everything it has been told to remember about a tool.
 * Read-only — the only thing this screen can change is deleting what was learned.
 */
export interface ToolCatalogReport {
  tools: number;
  groups: { group: string; tools: number }[];
  lastRound: { loaded: number; indexed: number; deferred: number; estimatedTokens: number; budgetTokens: number; at: string } | null;
  preloaded: PreloadReason[];
  notes: { id: string; tool: string; note: string; createdAt: string }[];
  health: CatalogHealth;
}

const dataOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});

export function toolCatalogReport(app: { registry: ToolRegistry; store: Store; runtime: { owner: string } }): ToolCatalogReport {
  const owner = app.runtime.owner;
  const counts = new Map<string, number>();
  for (const name of app.registry.names()) {
    const group = app.registry.groupOf(name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const events = app.store.recentEvents(owner, 400);
  const size = events.find((event) => event.kind === "catalog.size");
  const chosen = events.find((event) => event.kind === "catalog.preselected");
  const preloaded = (dataOf(chosen?.data).preloadedFromHistory ?? []) as PreloadReason[];
  const saved = app.store.get("settings", owner, catalogHealthId);
  return {
    tools: app.registry.names().length,
    groups: [...counts].map(([group, tools]) => ({ group, tools })).sort((a, b) => b.tools - a.tools),
    lastRound: size ? {
      loaded: Number(size.data.loaded ?? 0), indexed: Number(size.data.indexed ?? 0),
      deferred: Number(size.data.deferred ?? 0), estimatedTokens: Number(size.data.estimatedTokens ?? 0),
      budgetTokens: Number(size.data.budgetTokens ?? 0), at: size.createdAt,
    } : null,
    preloaded: Array.isArray(preloaded) ? preloaded.slice(0, 8) : [],
    notes: app.store.toolUsage.notes(owner),
    health: (saved?.data as unknown as CatalogHealth | undefined) ?? app.store.toolUsage.health(owner),
  };
}

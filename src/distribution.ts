import { z } from "zod";
import { audit } from "./audit.js";
import { connectionsSetting, savedConnections, type ConnectionRecord } from "./connections-preset.js";
import { assistantIdentity, saveAssistantIdentity } from "./identity.js";
import { catalogEntry, isRetired } from "./provider-catalog.js";
import type { Store } from "./store.js";

/**
 * A custom distribution's own branding and model presets: the two pieces `--assistant` never
 * brings in (docs/features.json, operations.distribution). Read from a plain JSON file beside the
 * installer, the same way an assistant file is, and brought in once on a fresh install by
 * `unixInstall` (src/install/unix-install-cli.ts) through `branch apply-distribution <file>`.
 *
 * What this can set:
 *   branding   the assistant's display name, the same field the owner edits from Settings. Applied
 *              only while it still reads "Branch Agent" with no edits of its own, so a distribution
 *              never overwrites a name the owner (or an earlier distribution) already chose.
 *   providers  model connections to a known catalog service (docs/configuration.md's provider
 *              catalog), saved the way "Settings, Add a connection" saves one — everything except
 *              the key. No key ever travels in a distribution file; the owner still pastes their
 *              own, or the preset sits unusable until they do. A connection whose id is already
 *              set up, or whose service is unknown or retired, is left alone rather than guessed at.
 *
 * What this never touches, the same rules a market keeps: approval settings, which model answers by
 * default, and memory.
 */
export const DistributionProviderSchema = z.object({
  /** The connection id the owner will see in the model list; must not collide with one already set up. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  /** Which catalog service (docs/configuration.md), e.g. "anthropic", "lm-studio". */
  provider: z.string().min(1).max(64),
  /** What to call it on screen; defaults to the service's own name. */
  name: z.string().trim().max(80).optional(),
  model: z.string().trim().min(1).max(256),
  extras: z.record(z.string().min(1).max(40), z.string().max(500)).default({}),
}).strict();
export type DistributionProvider = z.infer<typeof DistributionProviderSchema>;

export const DistributionSchema = z.object({
  format: z.literal("branch-agent-distribution"),
  version: z.literal(1),
  branding: z.object({ name: z.string().trim().min(1).max(80) }).strict().optional(),
  providers: z.array(DistributionProviderSchema).max(16).default([]),
}).strict();
export type Distribution = z.infer<typeof DistributionSchema>;

/** Parses a distribution file's already-read JSON; throws the zod message when it is not one. */
export function parseDistribution(input: unknown): Distribution {
  return DistributionSchema.parse(input);
}

function applyBranding(store: Store, owner: string, branding: { name: string }): string {
  const current = assistantIdentity(store, owner);
  if (current.name !== "Branch Agent" || current.revision !== 0)
    return `The assistant is already named "${current.name}", so the distribution's branding was not applied.`;
  saveAssistantIdentity(store, owner, { name: branding.name, instructions: current.instructions, expectedRevision: current.revision });
  return `The assistant is now named "${branding.name}".`;
}

function applyProviders(store: Store, owner: string, providers: readonly DistributionProvider[]): string {
  const existing = savedConnections(store, owner);
  const known = new Set(existing.map((connection) => connection.id));
  const kept: ConnectionRecord[] = [...existing];
  const added: string[] = [];
  for (const entry of providers) {
    if (known.has(entry.id) || kept.length >= 32) continue; // never replaces one already set up
    const service = catalogEntry(entry.provider);
    if (!service || isRetired(service)) continue; // an unknown or retired service is never guessed at
    kept.push({ id: entry.id, name: entry.name || service.name, catalogId: service.id, model: entry.model, extras: entry.extras });
    known.add(entry.id);
    added.push(entry.id);
  }
  if (!added.length)
    return "No preset provider from the distribution was brought in (each was already set up, unknown or retired).";
  store.save("settings", owner, connectionsSetting, { connections: kept });
  audit(store, owner, {
    action: "connection.changed", actor: "branch", subject: added.join(", ").slice(0, 300),
    reason: "A custom distribution's preset provider connection was brought in", outcome: "added",
  });
  return `${added.length} preset provider connection(s) were brought in: ${added.join(", ")}. Add a key for each in Settings before it can answer.`;
}

/** Brings in a parsed distribution's branding and preset providers; returns lines to print. */
export function applyDistribution(store: Store, owner: string, dist: Distribution): string[] {
  const lines: string[] = [];
  if (dist.branding) lines.push(applyBranding(store, owner, dist.branding));
  if (dist.providers.length) lines.push(applyProviders(store, owner, dist.providers));
  if (!lines.length) lines.push("The distribution file named no branding and no preset providers, so nothing was brought in.");
  return lines;
}

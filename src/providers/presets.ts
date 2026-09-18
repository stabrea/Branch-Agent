import { z } from "zod";
import { type CatalogEntry, catalogEntries, routeStandings } from "../provider-catalog.js";

export const headerStyle = z.enum(["bearer", "x-api-key", "azure-key", "google-key", "query-key", "aws-sigv4", "none"]);
export type HeaderStyle = z.infer<typeof headerStyle>;

export const providerKind = z.enum(["cloud", "local"]);
export type ProviderKind = z.infer<typeof providerKind>;

export const ProviderPresetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i),
  displayName: z.string().min(1).max(100),
  baseUrl: z.string().url().max(2048),
  headerStyle,
  /** Well-known model identifiers for this provider; may not be exhaustive. */
  modelIds: z.array(z.string().min(1).max(256)).max(20),
  /** Plain-language help text: where to get an API key or how to set up the local service. */
  keyHelp: z.string().min(1).max(500),
  kind: providerKind,
  /** The Terms line: the route Branch uses, the service's terms, and whether the route is official. */
  terms: z.object({
    route: z.string(), url: z.string(), standing: z.enum(routeStandings), warning: z.string().optional(),
  }).strict(),
}).strict();

export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

const styles: Record<CatalogEntry["auth"], HeaderStyle> = {
  bearer: "bearer", "x-api-key": "x-api-key", "api-key": "azure-key", "google-key": "google-key",
  "query-key": "query-key", "aws-sigv4": "aws-sigv4", none: "none",
};

/** The address as a person reads it, with anything they have to fill in shown in angle brackets. */
function readableUrl(baseUrl: string): string {
  return baseUrl.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_all, name: string) => `<${name}>`);
}

/** One line of setup help: what the service needs, and where to go and get it. */
function keyHelpFor(entry: CatalogEntry): string {
  const where = entry.signUp ? ` Get what you need from ${entry.signUp}.` : "";
  const care = entry.kind === "cloud" ? " Keep your key private and replace it if it ever leaks." : "";
  return (entry.note + where + care).slice(0, 500);
}

function toPreset(entry: CatalogEntry): ProviderPreset {
  return {
    id: entry.id,
    displayName: entry.name,
    baseUrl: readableUrl(entry.baseUrl),
    headerStyle: styles[entry.auth],
    modelIds: entry.recommendedModels.slice(0, 20),
    keyHelp: keyHelpFor(entry),
    kind: entry.kind,
    terms: { ...entry.terms },
  };
}

/**
 * The named provider presets the Settings screen offers, every one of them read out of the
 * catalog in data/providers.json rather than written down here a second time. Correcting the
 * catalog corrects this list, the documentation table and the setup route all at once.
 */
export function allPresets(): ProviderPreset[] {
  return catalogEntries().map(toPreset);
}

/** Returns a preset by id, or undefined if not found. */
export function findPreset(id: string): ProviderPreset | undefined {
  const entry = catalogEntries().find((candidate) => candidate.id === id);
  return entry ? toPreset(entry) : undefined;
}

/** Kept for callers that read the list as a value; it is the same derived list. */
export const builtInPresets: ProviderPreset[] = allPresets();

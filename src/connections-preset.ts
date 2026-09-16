import { z } from "zod";
import type { Provider } from "./contracts.js";
import type { Locker } from "./locker.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import { catalogEntry, modelsAddress } from "./provider-catalog.js";
import { buildConnection } from "./provider-factory.js";
import { countModels } from "./provider-probe.js";

/**
 * Adding a model connection in plain language: pick a service, paste the key, answer whatever else
 * that service asks for. Branch checks the key by using it before anything is saved, puts the key
 * in the locker rather than in a settings file, and reports what it found. The key itself is never
 * written to a log, returned in an answer, or put in an error message.
 */
export const FromPresetSchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().max(4096).default(""),
  extras: z.record(z.string().min(1).max(40), z.string().max(500)).default({}),
  model: z.string().max(256).optional(),
  /** What to call it on screen; defaults to the service's name. */
  name: z.string().trim().max(80).optional(),
}).strict();
export type FromPresetInput = z.infer<typeof FromPresetSchema>;

export interface FromPresetResult {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Models the service listed, capped so one reply cannot flood the screen. */
  models: string[];
  /** Null when the service offers no list; then the key was checked by asking for one small reply. */
  modelsFound: number | null;
  can: string[];
  /** Where the key was put, so a person can find it again. Never the key itself. */
  secret: { project: string; name: string };
  message: string;
}

/** The locker project every model-service key lives in, so they are easy to find and to clear out. */
export const connectionProject = "model-connections";
/** `lm-studio` becomes `LM_STUDIO_KEY`, which is the shape the locker insists on. */
export function secretNameFor(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^([^A-Z])/, "P$1").slice(0, 60) + "_KEY";
}

const listed = z.object({
  data: z.array(z.object({ id: z.string().max(256) }).loose()).optional(),
  models: z.array(z.object({ id: z.string().max(256).optional(), name: z.string().max(256).optional() }).loose()).optional(),
}).loose();

/** The names in whichever shape the service answered with; an unfamiliar shape gives an empty list. */
export function modelNames(body: unknown): string[] {
  const parsed = listed.safeParse(body);
  if (!parsed.success) return [];
  const rows: { id?: string | undefined; name?: string | undefined }[] = parsed.data.data ?? parsed.data.models ?? [];
  return rows.map((row) => row.id ?? row.name ?? "").filter((name) => name.length > 0).slice(0, 50);
}

export interface FromPresetDeps {
  models: ModelRouter;
  locker: Locker;
  owner: string;
  policy: NetworkPolicy;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Checks a service is really reachable with this key, then remembers it. The order matters: a key
 * that does not work is never stored, so nothing accumulates that a person would later have to
 * clean up.
 */
export async function connectFromPreset(deps: FromPresetDeps, input: unknown): Promise<FromPresetResult> {
  const asked = FromPresetSchema.parse(input);
  const entry = catalogEntry(asked.provider);
  if (!entry) throw new Error(`Branch does not know a model service called "${asked.provider}"`);
  const call = deps.fetchImpl ?? globalThis.fetch;
  const built = buildConnection({
    provider: asked.provider, key: asked.key, extras: asked.extras,
    ...(asked.model ? { model: asked.model } : {}),
    policy: deps.policy, fetchImpl: deps.models.health.watch(asked.provider, call),
  });
  const list = modelsAddress(entry, built.baseUrl);
  const found = list ? await probeList(deps, list, asked.key, entry.auth, call) : null;
  if (!list) await probeChat(built.provider);
  const id = uniqueId(deps.models, asked.provider);
  if (asked.key) await deps.locker.set(deps.owner, connectionProject, secretNameFor(asked.provider), asked.key);
  deps.models.register({
    id, name: asked.name || entry.name, provider: built.provider, model: built.model, catalogId: entry.id,
  });
  return {
    id, name: asked.name || entry.name, provider: entry.id, model: built.model,
    models: found ?? [], modelsFound: found ? found.length : null,
    can: entry.capabilities,
    secret: { project: connectionProject, name: secretNameFor(asked.provider) },
    message: found
      ? `${entry.name} answered and listed ${found.length} model(s). It is set up as "${id}".`
      : `${entry.name} answered a small test request. It is set up as "${id}", and it does not publish a list of models.`,
  };
}

async function probeList(
  deps: FromPresetDeps, url: string, key: string, auth: string, call: typeof globalThis.fetch,
): Promise<string[]> {
  await deps.policy.assertAllowed(new URL(url), "model connection check");
  const headers: Record<string, string> =
    auth === "x-api-key" ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : auth === "api-key" ? { "api-key": key }
    : auth === "google-key" ? { "x-goog-api-key": key }
    : auth === "none" ? {}
    : { authorization: `Bearer ${key}` };
  const response = await call(url, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(response.status === 401 || response.status === 403
      ? "That key was refused. Check you copied all of it, and that it is for this service."
      : `The service answered ${response.status} when asked what models it has. Try again in a moment.`);
  return modelNames(await response.json().catch(() => null));
}

/** For a service with no list of models: one very small request, which is the only other check. */
async function probeChat(provider: Provider): Promise<void> {
  await provider.complete({
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    tools: [], maxTokens: 16, signal: AbortSignal.timeout(30_000),
  });
}

function uniqueId(models: ModelRouter, base: string): string {
  if (!models.presets.has(base)) return base;
  for (let at = 2; at < 100; at++) if (!models.presets.has(`${base}-${at}`)) return `${base}-${at}`;
  throw new Error("There are already too many connections to this service");
}

/** How many models a service listed, for the places that only want the count. */
export const countFromBody = countModels;

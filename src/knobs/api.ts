import { thinkingLevels } from "../thinking-levels.js"; // phase2/accounts
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "../store.js";
import { leakKinds } from "../leak-guard.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { allKnobs, knobCardNames, resetKnobs, saveKnobs, type KnobCard } from "./settings.js";
import { memoryProvider, saveMemoryProvider } from "./apply.js";
import { refusedEnvironmentName } from "./environment.js";
import { launchFileView, saveLaunchFile } from "./launch-file.js";
import { contextLimit } from "../runtime.js";

/**
 * R17-S-B: the screen's way in.
 *
 *   GET  /api/knobs              every card's values, what "as launched" means, and the choices offered
 *   POST /api/knobs              { card, values } saves one card; { card, reset: true } puts it back
 *   GET  /api/knobs/launch-file  what the launch settings file (BRANCH_INTEGRATIONS) says, in plain words
 *   POST /api/knobs/launch-file  changes the few fields the card offers; used from the next start
 *
 * Every change is the owner's: a short-lived key is refused before this is reached (src/server.ts,
 * src/short-lived-keys.ts), and a household profile is refused here, since every card is the owner's
 * own setting. The owner's "about you" note is shown to the owner only.
 */
export class KnobsApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface KnobsApp {
  store: Store;
  runtime: {
    owner: string;
    models: { presets: ReadonlyMap<string, { id: string; name: string; model: string; provider: { name: string } }> };
    reliability: { toolResultChars: number; toolTimeoutMs: number; localFirstReplyMs: number; maxModelRounds: number };
    retryPolicy: { maxRetries: number };
  };
}
/** Both routes; a short-lived key is refused every change to them (knobsRefusal in src/short-lived-keys.ts). */
export const knobsRoutes: readonly string[] = ["/api/knobs", "/api/knobs/launch-file"];
export const handlesKnobsPath = (path: string): boolean => knobsRoutes.includes(path);

const SaveSchema = z.object({
  card: z.enum(knobCardNames as [KnobCard, ...KnobCard[]]),
  values: z.record(z.string(), z.unknown()).optional(),
  reset: z.boolean().optional(),
  memoryProvider: z.enum(["branch", "branch-and-hindsight"]).optional(),
}).strict();

/** Only the owner, in the owner's own profile and with the computer's own key, may loosen these. */
function requireOwnerHere(store: Store, what: string): void {
  if (startedWithShortLivedKey() || currentPerson())
    throw new KnobsApiError(403, `${what} can only be changed by the owner, in the app window.`);
  try { store.profiles.requireOwner(what); } catch (error) { throw new KnobsApiError(400, (error as Error).message); }
}

/** Whether the one asking is the owner, in the owner's own profile and with the computer's own key. */
const ownerHere = (store: Store): boolean => !startedWithShortLivedKey() && !currentPerson() && store.profiles.isOwner();

/** What anyone but the owner sees of the launch settings file: nothing it sets up. */
const launchFileHidden = { path: null, ownerOnly: true, problem: "Only the owner can see what the launch settings file sets up.", facts: null, editable: null };

function view(app: KnobsApp) {
  const { store, runtime } = app;
  const values = allKnobs(store, runtime.owner);
  if (!ownerHere(store)) values.memory = { ...values.memory, aboutYou: "" };
  return {
    values,
    aboutYouHidden: !ownerHere(store),
    memoryProvider: memoryProvider(store, runtime.owner),
    // phase2/accounts (#22): which thinking levels each model really takes (src/thinking-levels.ts).
    connections: [...runtime.models.presets.values()].map((preset) =>
      ({ id: preset.id, name: preset.name, thinking: thinkingLevels(preset.provider.name, preset.model) })),
    leakKinds: leakKinds.filter((kind) => kind !== "private key"),
    launched: {
      contextWindowTokens: contextLimit,
      toolAnswerChars: runtime.reliability.toolResultChars,
      toolTimeoutSeconds: Math.round(runtime.reliability.toolTimeoutMs / 1000),
      apiRetries: runtime.retryPolicy.maxRetries,
      localFirstReplySeconds: Math.round(runtime.reliability.localFirstReplyMs / 1000), // mac7/coding-next
      maxModelRounds: runtime.reliability.maxModelRounds, // mac7/speed
    },
  };
}

/** Checks what a save would change that plain field ranges cannot. */
function checkValues(app: KnobsApp, card: KnobCard, values: Record<string, unknown>): void {
  const known = (id: unknown) => typeof id !== "string" || app.runtime.models.presets.has(id);
  if (card === "subtasks" && (!known(values.subtaskModel) || !known(values.sideJobModel)))
    throw new KnobsApiError(400, "That connection is not set up. Pick one from the list.");
  if (card === "reasoning" && values.effortByModel && typeof values.effortByModel === "object"
    && !Object.keys(values.effortByModel).every(known))
    throw new KnobsApiError(400, "That connection is not set up. Pick one from the list.");
  if (card === "commands" && "passEnvironment" in values) {
    for (const name of Array.isArray(values.passEnvironment) ? values.passEnvironment : []) {
      const refused = refusedEnvironmentName(String(name));
      if (refused) throw new KnobsApiError(400, refused);
    }
  }
  if (card === "leakGuard") {
    const allowed = new Set(leakKinds.filter((kind) => kind !== "private key"));
    for (const kind of Array.isArray(values.exceptions) ? values.exceptions : [])
      if (!allowed.has(String(kind))) throw new KnobsApiError(400, `"${String(kind).slice(0, 40)}" is not a kind of value that can be let through.`);
  }
}

function save(app: KnobsApp, body: unknown) {
  const input = SaveSchema.parse(body);
  const { store, runtime: { owner } } = app;
  requireOwnerHere(store, "These settings");
  if (input.reset) {
    resetKnobs(store, owner, input.card);
  } else if (input.values) {
    checkValues(app, input.card, input.values);
    saveKnobs(store, owner, input.card, input.values);
  }
  if (input.memoryProvider) saveMemoryProvider(store, owner, input.memoryProvider);
  return view(app);
}

export async function knobsApi(app: KnobsApp, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage) => Promise<unknown>, integrationsPath: () => string | null): Promise<unknown> {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "POST") throw new KnobsApiError(405, "Use GET or POST");
  try {
    if (path === "/api/knobs/launch-file") {
      if (method === "GET") return ownerHere(app.store) ? await launchFileView(integrationsPath()) : launchFileHidden;
      requireOwnerHere(app.store, "The launch settings file");
      return await saveLaunchFile(integrationsPath(), await readBody(request));
    }
    return method === "GET" ? view(app) : save(app, await readBody(request));
  } catch (error) {
    if (error instanceof KnobsApiError) throw error;
    if (error instanceof z.ZodError) throw new KnobsApiError(400, error.issues[0]?.message ?? "That value is not allowed.");
    throw new KnobsApiError(400, (error as Error).message);
  }
}

import { z } from "zod";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { saveVoiceSettings } from "./voice.js";
import { audioPricedAt, sttPricesPerMinute } from "./voice-stt.js";
import { speechPricedAt, ttsPricesPerThousand } from "./voice-tts.js";
import { realtimeNote } from "./voice-talk.js";
import type { VoiceService } from "./voice-service.js";
import { listModels, switchModel } from "./model-switch.js";
import { profileSettings, routeByProfile, saveProfileSettings, taskKinds } from "./model-profiles.js";
import { probeAll, probeProvider } from "./provider-probe.js";

/**
 * The `/api/voice/*` and `/api/models/*` screens behind one function, so the route table in
 * src/server.ts gains a single short block. Nothing here plays a sound or opens a microphone: the
 * browser does the recording and the playing, and this only decides and fetches.
 */
export interface VoiceApiDeps {
  store: Store;
  models: ModelRouter;
  owner: string;
  voice: VoiceService;
  policy: NetworkPolicy;
  fetch: typeof globalThis.fetch;
}

const switchBody = z.object({ sessionId: z.string().uuid(), model: z.string().trim().min(1).max(120) }).strict();
const kindBody = z.object({ kind: z.enum(taskKinds).default("chat") }).strict();

export async function voiceApi(
  deps: VoiceApiDeps, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  const { store, models, owner, voice } = deps;
  if (method === "GET" && path === "/api/voice/plan") return voicePlan(deps);
  if (method === "POST" && path === "/api/voice/settings") return saveVoiceSettings(store, owner, await body());
  if (method === "GET" && path === "/api/voice/voices") return { windows: await voice.speech.windowsVoices() };
  if (method === "GET" && path === "/api/models/profiles") return profileSettings(store, owner, models);
  if (method === "POST" && path === "/api/models/profiles") return saveProfileSettings(store, owner, models, await body());
  if (method === "POST" && path === "/api/models/profiles/preview") {
    const { kind } = kindBody.parse(await body());
    return { choice: routeByProfile(store, models, owner, kind) };
  }
  if (method === "GET" && path === "/api/models/switch") return listModels(models, owner, "");
  if (method === "POST" && path === "/api/models/switch") {
    const input = switchBody.parse(await body());
    return switchModel(models, owner, input.sessionId, input.model);
  }
  if (method === "GET" && path === "/api/models/probe") return { connections: await probeAll(models, deps.policy, deps.fetch) };
  if (method === "POST" && path === "/api/models/probe") {
    const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(await body());
    return { connection: await probeProvider(models, id, deps.policy, deps.fetch) };
  }
  throw new Error("That is not something Branch can do with voice or model settings");
}

/**
 * What the Voice screen shows: which service would do the work right now, where the sound would
 * go, and what a minute of it costs — said plainly, and never invented when no price is on file.
 */
export function voicePlan(deps: VoiceApiDeps) {
  const plan = deps.voice.plan(deps.owner);
  return {
    settings: plan.settings,
    speechToText: { route: plan.stt.kind, reason: plan.stt.reason, ready: plan.stt.kind === "local" || plan.stt.provider !== null },
    readAloud: { route: plan.tts.kind, reason: plan.tts.reason, ready: plan.tts.kind === "windows" || plan.tts.provider !== null },
    whereAudioGoes: whereAudioGoes(plan.stt.kind, plan.tts.kind),
    prices: { perMinute: sttPricesPerMinute, perThousandCharacters: ttsPricesPerThousand, transcriptionPricedAt: audioPricedAt, speechPricedAt },
    realtimeNote,
  };
}

/** One sentence about where recordings and spoken replies travel, in the owner's own terms. */
export function whereAudioGoes(stt: string, tts: string): string {
  const both = stt === "local" && tts === "windows";
  if (both) return "Nothing leaves this computer: recordings are written out here, and replies are read aloud by a voice that comes with Windows.";
  const parts: string[] = [];
  parts.push(stt === "local"
    ? "Your recordings are written out on this computer."
    : "Your recordings are sent to your model provider to be written out, and you are charged for the minutes.");
  parts.push(tts === "windows"
    ? "Replies are read aloud by a voice that comes with Windows, which costs nothing."
    : "The words of a reply are sent to your model provider to be read aloud, and you are charged for the characters.");
  return parts.join(" ");
}

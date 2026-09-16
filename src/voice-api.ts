import { z } from "zod";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { saveVoiceSettings } from "./voice.js";
import { audioPricedAt, sttPricesPerMinute } from "./voice-stt.js";
import { speechPricedAt, ttsPricesPerThousand } from "./voice-tts.js";
import { realtimeNote } from "./voice-talk.js";
import { livePlanFor, liveDollarsPerMinute, livePricedAt } from "./realtime-voice.js";
import type { VoiceService } from "./voice-service.js";
import { listModels, switchModel } from "./model-switch.js";
import { profileSettings, routeByProfile, saveProfileSettings, taskKinds } from "./model-profiles.js";
import { probeAll, probeProvider } from "./provider-probe.js";
import type { OAuthConnections } from "./oauth.js";
import { GeminiSignInSchema, geminiSignInNote, registerSignedInGemini } from "./gemini-signin.js";

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
  /** Wave 7: signing in with Google for Gemini. Absent in tests that do not use it. */
  oauth?: OAuthConnections;
}

const switchBody = z.object({ sessionId: z.string().uuid(), model: z.string().trim().min(1).max(120) }).strict();
const kindBody = z.object({ kind: z.enum(taskKinds).default("chat") }).strict();
const liveBody = z.object({ sessionId: z.string().uuid().nullable().default(null) }).strict();

export async function voiceApi(
  deps: VoiceApiDeps, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  const { store, models, owner, voice } = deps;
  if (method === "GET" && path === "/api/voice/plan") return voicePlan(deps);
  if (method === "POST" && path === "/api/voice/settings") return saveVoiceSettings(store, owner, await body());
  if (method === "GET" && path === "/api/voice/voices") return { windows: await voice.speech.windowsVoices() };
  // Wave 8: a live conversation hangs off a task like everything else, so the browser is given one
  // to open a socket on. Nothing reaches outside this computer until the browser says "start" on
  // that socket, and a connection that cannot hold a live conversation is refused here in words.
  if (method === "POST" && path === "/api/voice/live") return openLive(deps, await body());
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
  // Wave 7: "Sign in with Google" on the Gemini card. The settings are kept so the card can say
  // whether a sign-in has been set up at all; the note is never hidden, because signing in only
  // works against the person's own Google Cloud project.
  if (path === "/api/models/gemini-signin") {
    if (method === "GET") return geminiSignInState(store, owner, models);
    if (method === "POST") return signInWithGoogle(deps, await body());
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
export function openLive(deps: VoiceApiDeps, input: unknown) {
  const { sessionId } = liveBody.parse(input);
  const plan = livePlanFor(deps.voice.settings(deps.owner), deps.models.plan(deps.owner, sessionId ?? "voice").candidates[0]);
  if (!plan.available) throw new Error(plan.reason);
  const run = deps.store.createRun(deps.owner, "A live conversation", sessionId ?? undefined, false, "web");
  return { runId: run.id, sessionId: run.sessionId, plan };
}

export function voicePlan(deps: VoiceApiDeps) {
  const plan = deps.voice.plan(deps.owner);
  return {
    settings: plan.settings,
    speechToText: { route: plan.stt.kind, reason: plan.stt.reason, ready: plan.stt.kind === "local" || plan.stt.provider !== null },
    readAloud: { route: plan.tts.kind, reason: plan.tts.reason, ready: plan.tts.kind === "windows" || plan.tts.provider !== null },
    whereAudioGoes: whereAudioGoes(plan.stt.kind, plan.tts.kind),
    prices: { perMinute: sttPricesPerMinute, perThousandCharacters: ttsPricesPerThousand, transcriptionPricedAt: audioPricedAt, speechPricedAt },
    realtimeNote,
    // Wave 8: whether a live conversation is possible on the connection chosen right now, and the
    // limits it would run under. The composer asks the same question before it offers the button.
    live: { ...livePlanFor(plan.settings, deps.models.plan(deps.owner, "voice").candidates[0]), dollarsPerMinute: liveDollarsPerMinute, pricedAt: livePricedAt },
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

/* ---------- Wave 7: signing in with Google for Gemini ---------- */

const geminiSettingsKey = "gemini-signin";

/** What the Gemini card shows before anybody presses anything. */
export function geminiSignInState(store: Store, owner: string, models: ModelRouter) {
  const saved = GeminiSignInSchema.safeParse(store.get("settings", owner, geminiSettingsKey)?.data);
  const settings = saved.success ? saved.data : GeminiSignInSchema.parse({});
  return {
    settings,
    /** True once a signed-in connection is registered; it goes when Branch restarts. */
    connected: models.presets.has("google-gemini"),
    note: geminiSignInNote,
  };
}

/**
 * Signs in and registers the connection. The client id is saved first so the card remembers it,
 * then a token is asked for. Whatever Google refuses comes back as plain words, and the ordinary
 * key flow is never taken away.
 */
export async function signInWithGoogle(deps: VoiceApiDeps, input: unknown) {
  const { store, owner, models } = deps;
  const settings = GeminiSignInSchema.parse(input);
  store.save("settings", owner, geminiSettingsKey, settings);
  if (!deps.oauth) throw new Error(`Signing in with Google is not set up on this copy. ${geminiSignInNote}`);
  const preset = await registerSignedInGemini(deps.oauth, settings, (value) => models.register(value));
  return { connected: true, preset: { id: preset.id, name: preset.name, model: preset.model }, note: geminiSignInNote };
}

import { z } from "zod";
import type { Provider, ToolContext } from "./contracts.js";
import type { ModelRouter } from "./models.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { voiceSettings, type AudioProvider, type VoiceSettings } from "./voice.js";
import { LocalSpeechSchema, Transcription, type AudioClip, type SttRoute, type TranscriptionResult } from "./voice-stt.js";
import { Speech, SpeakRequestSchema, type SpeakRequest, type SpokenAudio, type TtsRoute } from "./voice-tts.js";

/**
 * Voice as the rest of the app sees it: hand it a recording and get words back, hand it words and
 * get sound back. This is where the owner's own choices are applied — which service, which voice,
 * which language, and whether anything containing sound is allowed to leave this computer at all.
 */
export interface VoiceRoute<K> {
  kind: K;
  provider: AudioProvider | null;
  /** Why this route was chosen, in plain words, for the record and the settings screen. */
  reason: string;
}

/** The audio address of a connection, plus how Gemini is told who is asking. */
export function audioOf(provider: Provider | undefined): AudioProvider | null {
  const route = provider?.audio?.() ?? null;
  return route && route.apiKey ? route : null;
}

/** Whether a connection speaks Gemini's shape rather than the OpenAI one. */
export const isGemini = (provider: Provider | undefined): boolean => provider?.name === "gemini";

/** Which service should write a recording out, given what the owner chose and what is connected. */
export function sttRouteFor(settings: VoiceSettings, provider: Provider | undefined): VoiceRoute<SttRoute> {
  const audio = audioOf(provider);
  if (settings.keepAudioOnThisComputer)
    return { kind: "local", provider: null, reason: "You asked for audio to stay on this computer" };
  if (settings.sttRoute === "local") return { kind: "local", provider: null, reason: "You chose the speech program on this computer" };
  if (settings.sttRoute === "gemini") return { kind: "gemini", provider: audio, reason: "You chose Gemini" };
  if (settings.sttRoute === "openai") return { kind: "openai", provider: audio, reason: "You chose your model provider" };
  if (isGemini(provider)) return { kind: "gemini", provider: audio, reason: `${provider?.name} is connected, and it can write speech out` };
  if (settings.localSpeechExecutable && !audio)
    return { kind: "local", provider: null, reason: "No connected model offers this, but a speech program is set up here" };
  return { kind: "openai", provider: audio, reason: "Your connected model offers this" };
}

/** Which service should read a reply aloud. Windows' own voice is the one that needs nothing. */
export function ttsRouteFor(settings: VoiceSettings, provider: Provider | undefined): VoiceRoute<TtsRoute> {
  const audio = audioOf(provider);
  if (settings.keepAudioOnThisComputer)
    return { kind: "windows", provider: null, reason: "You asked for audio to stay on this computer" };
  if (settings.ttsRoute === "windows") return { kind: "windows", provider: null, reason: "You chose the voice that comes with Windows" };
  if (settings.ttsRoute === "gemini") return { kind: "gemini", provider: audio, reason: "You chose Gemini" };
  if (settings.ttsRoute === "openai") return { kind: "openai", provider: audio, reason: "You chose your model provider" };
  if (!settings.useProviderVoice) return { kind: "windows", provider: null, reason: "Higher-quality voice is switched off, so the free Windows voice is used" };
  if (isGemini(provider)) return { kind: "gemini", provider: audio, reason: `${provider?.name} is connected, and it can read text aloud` };
  if (!audio) return { kind: "windows", provider: null, reason: "No connected model offers this, so the free Windows voice is used" };
  return { kind: "openai", provider: audio, reason: "Your connected model offers this" };
}

/** Everything the voice screens and routes need in one object, so callers never wire it up twice. */
export class VoiceService {
  readonly transcription: Transcription;
  readonly speech: Speech;
  constructor(
    private readonly store: Store,
    private readonly models: ModelRouter,
    policy: NetworkPolicy,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    /** Replaced in tests so no program is ever started on the owner's computer. */
    runProgram?: (file: string, args: string[], signal?: AbortSignal) => Promise<string>,
  ) {
    this.transcription = runProgram ? new Transcription(policy, fetchImpl, runProgram) : new Transcription(policy, fetchImpl);
    this.speech = runProgram ? new Speech(policy, fetchImpl, runProgram) : new Speech(policy, fetchImpl);
  }
  settings(owner: string): VoiceSettings { return voiceSettings(this.store, owner); }
  /** The connection that answers for this owner right now, for whichever conversation is open. */
  private provider(owner: string, sessionId = "voice"): Provider | undefined {
    return this.models.plan(owner, sessionId).candidates[0]?.provider;
  }
  /** What would happen if the owner pressed the microphone or Read aloud right now. */
  plan(owner: string): { stt: VoiceRoute<SttRoute>; tts: VoiceRoute<TtsRoute>; settings: VoiceSettings } {
    const settings = this.settings(owner), provider = this.provider(owner);
    return { stt: sttRouteFor(settings, provider), tts: ttsRouteFor(settings, provider), settings };
  }
  /** Writes a recording out, using the owner's chosen service and language. */
  async transcribe(owner: string, clip: AudioClip, options: { signal?: AbortSignal } = {}): Promise<TranscriptionResult> {
    const settings = this.settings(owner);
    const route = sttRouteFor(settings, this.provider(owner));
    return this.transcription.transcribe(clip, {
      kind: route.kind, provider: route.provider,
      local: LocalSpeechSchema.parse({ executable: settings.localSpeechExecutable, model: settings.localSpeechModel, kind: settings.localSpeechKind }),
    }, {
      ...(settings.sttModel ? { model: settings.sttModel } : {}),
      language: settings.language || null,
      keepOnThisComputer: settings.keepAudioOnThisComputer,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
  /** Reads text aloud, using the owner's chosen voice and speed. */
  async speak(owner: string, input: SpeakRequest, options: { signal?: AbortSignal } = {}): Promise<SpokenAudio> {
    const settings = this.settings(owner);
    const route = ttsRouteFor(settings, this.provider(owner));
    const request: SpeakRequest = {
      text: input.text,
      voice: input.voice || (settings.voiceId === "default" ? "" : settings.voiceId),
      speed: input.speed ?? settings.speechRate,
      ...(input.model || settings.ttsModel ? { model: input.model || settings.ttsModel } : {}),
    };
    return this.speech.speak(request, { kind: route.kind, provider: route.provider }, {
      keepOnThisComputer: settings.keepAudioOnThisComputer,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

/**
 * The `voice.say` tool. It hands back sound the person's own screen plays, and it obeys "keep
 * audio on this computer" because the refusal lives in the service, not in the web route.
 */
export function registerVoice(registry: ToolRegistry, voice: VoiceService, store?: Store): void {
  registry.register({
    name: "voice.say", permission: "media.write",
    description: "Read a short piece of text aloud for the person, using the voice they chose. Use it when someone asks to hear something rather than read it.",
    parameters: SpeakRequestSchema.extend({ voice: z.string().trim().max(80).default("") }),
    target: () => "reading something aloud",
    execute: async (input: SpeakRequest, context: ToolContext) => {
      if (context.dryRun) return { wouldSay: input.text.slice(0, 200) };
      const spoken = await voice.speak(context.owner, input, { signal: context.signal });
      // What this cost goes into the task's own record, beside every other cost, so the Usage
      // screen is not the only place money is accounted for.
      if (store && context.runId)
        store.event(context.runId, "voice.spoken", {
          route: spoken.route, characters: input.text.length,
          cost: spoken.cost.amount, note: spoken.cost.note,
        });
      return {
        spoken: input.text.slice(0, 500), voice: spoken.voice, route: spoken.route,
        seconds: null, bytes: spoken.bytes.byteLength, mediaType: spoken.mediaType,
        cost: spoken.cost.amount, costNote: spoken.cost.note,
      };
    },
  });
}

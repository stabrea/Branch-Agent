import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";

/**
 * Voice settings stored per owner. Preferences for speech input and output.
 */
export const VoiceSettingsSchema = z
  .object({
    autoReadAloud: z.boolean().default(false),
    voiceId: z.string().max(200).default("default"),
    speechRate: z.number().min(0.5).max(2).default(1),
    useProviderVoice: z.boolean().default(false),
  })
  .strict();
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

export function voiceSettings(store: Store, owner: string): VoiceSettings {
  const saved = store.get("settings", owner, "voice")?.data;
  if (!saved) return VoiceSettingsSchema.parse({});
  return VoiceSettingsSchema.parse(saved);
}

export function saveVoiceSettings(
  store: Store,
  owner: string,
  settings: unknown,
): VoiceSettings {
  const parsed = VoiceSettingsSchema.parse(settings);
  store.save("settings", owner, "voice", parsed);
  return parsed;
}

/**
 * Audio endpoint info from a provider's audio() method
 */
export interface AudioProvider {
  readonly endpoint: string;
  readonly apiKey: string;
}

/**
 * Transcribe audio from a browser's MediaRecorder to text using the configured provider's
 * OpenAI-compatible /audio/transcriptions endpoint. Throws a plain-language error if:
 * - The provider has no /audio/transcriptions endpoint or no API key
 * - The audio exceeds size or duration limits
 */
export async function transcribeAudio(
  audio: Uint8Array,
  provider: AudioProvider | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
): Promise<string> {
  if (!provider) {
    throw new Error(
      "Speech to text needs an OpenAI-compatible provider with a key. Add one in Settings → Model.",
    );
  }

  const url = new URL("/v1/audio/transcriptions", provider.endpoint);

  // Check network policy before making the request
  try {
    await policy.assertAllowed(url, "audio transcription");
  } catch (e) {
    throw new Error(`Cannot reach audio transcription endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }

  const form = new FormData();
  const audioBlob = new Blob([Buffer.from(audio)], { type: "audio/webm" });
  form.append("file", audioBlob, "audio.webm");
  form.append("model", "whisper-1");

  const response = await fetch(url.href, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Transcription failed: ${response.status} ${error}`);
  }

  const result = await response.json() as { text?: string };
  if (!result.text) throw new Error("No text in transcription response");
  return result.text;
}

/**
 * Request the configured provider's /audio/speech endpoint to generate speech from text.
 * Throws a plain-language error if the provider has no endpoint or no API key.
 * Returns the audio stream (Uint8Array) for the client to play.
 */
export async function generateSpeech(
  text: string,
  provider: AudioProvider | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  /** Which voice to use and which speech model to ask; both fall back to the defaults below. */
  options: { voice?: string; model?: string } = {},
): Promise<Uint8Array> {
  if (!provider) {
    throw new Error(
      "Higher-quality voice needs an OpenAI-compatible provider with a key. Add one in Settings → Model.",
    );
  }

  const url = new URL("/v1/audio/speech", provider.endpoint);

  try {
    await policy.assertAllowed(url, "audio speech");
  } catch (e) {
    throw new Error(`Cannot reach speech endpoint: ${e instanceof Error ? e.message : String(e)}`);
  }

  const response = await fetch(url.href, {
    method: "POST",
    headers: {
      authorization: `Bearer ${provider.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model ?? "tts-1",
      input: text,
      voice: options.voice || "alloy",
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    throw new Error(`Speech generation failed: ${response.status} ${error}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

import { execFile } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { AudioProvider } from "./voice.js";

/**
 * Writing out what someone said, wherever the sound came from: the microphone in the composer, a
 * voice note that arrived on a chat app, or a sound file in the workspace. One service, three
 * routes — an OpenAI-shaped `/audio/transcriptions`, Gemini's own inline-audio route, and a
 * speech program already installed on this computer — so the rest of the app never has to care.
 */
export type SttRoute = "openai" | "gemini" | "local";

export interface AudioClip {
  bytes: Uint8Array;
  /** For example audio/webm or audio/ogg; what the recorder or the chat app said it is. */
  mediaType: string;
  /** A short name for the sound, used as the file name the service is shown. */
  name: string;
  /** How long the sound runs, when the caller knows; used only to work out the cost. */
  seconds?: number | undefined;
}
export interface TranscriptionResult {
  text: string;
  /** Which route did the work, in plain words for the record. */
  route: SttRoute;
  /** The language the service reported, when it reported one. */
  language: string | null;
  cost: AudioCostEstimate;
}
export interface AudioCostEstimate {
  amount: number | null;
  currency: "USD";
  confidence: "table" | "unknown" | "free";
  note: string;
}

/** The day the per-minute prices below were read. Nothing here is ever guessed. */
export const audioPricedAt = "2026-09-16";
/** Published prices for writing out one minute of speech, in US dollars. */
export const sttPricesPerMinute: Record<string, number> = {
  "whisper-1": 0.006,
  "gpt-4o-transcribe": 0.006,
  "gpt-4o-mini-transcribe": 0.003,
};

/**
 * What a piece of sound probably costs to write out. A model with no price on file, or a sound of
 * unknown length, reports no amount at all rather than a figure that only looks right.
 */
export function estimateAudioCost(model: string, seconds: number | undefined, route: SttRoute): AudioCostEstimate {
  if (route === "local")
    return { amount: 0, currency: "USD", confidence: "free", note: "this ran on your computer, so nothing was charged" };
  const each = sttPricesPerMinute[model] ?? sttPricesPerMinute[model.toLowerCase()];
  if (each === undefined || seconds === undefined || seconds <= 0)
    return { amount: null, currency: "USD", confidence: "unknown", note: `no per-minute price on file for ${model}` };
  return {
    amount: Math.round((each * seconds / 60) * 1_000_000) / 1_000_000,
    currency: "USD", confidence: "table",
    note: `list price for ${model} as of ${audioPricedAt}`,
  };
}

/** Where a local speech program lives and how it is called. Branch never downloads one. */
export const LocalSpeechSchema = z.object({
  /** The whisper.cpp or faster-whisper program the owner already installed. Empty means none. */
  executable: z.string().trim().max(400).default(""),
  /** The model file whisper.cpp needs, or the model name faster-whisper should load. */
  model: z.string().trim().max(400).default(""),
  kind: z.enum(["whisper-cpp", "faster-whisper"]).default("whisper-cpp"),
}).strict();
export type LocalSpeech = z.infer<typeof LocalSpeechSchema>;

/**
 * The command line for a local speech program. Pure, so the arguments can be read and checked
 * without a program being installed. Both programs write their answer to standard output.
 */
export function localSttArgs(settings: LocalSpeech, wavPath: string, language: string | null): string[] {
  if (settings.kind === "faster-whisper")
    return [wavPath, "--output_format", "txt", "--output_dir", "-",
      ...(settings.model ? ["--model", settings.model] : []),
      ...(language ? ["--language", language] : [])];
  return ["-f", wavPath, "--no-timestamps", "--output-txt", "--no-prints",
    ...(settings.model ? ["-m", settings.model] : []),
    ...(language ? ["-l", language] : ["-l", "auto"])];
}

const openaiShape = z.object({ text: z.string().optional(), language: z.string().max(80).optional() }).loose();
const geminiShape = z.object({
  candidates: z.array(z.object({
    content: z.object({ parts: z.array(z.object({ text: z.string().optional() }).loose()).default([]) }).optional(),
  })).default([]),
}).loose();

/** What every route needs to do its work: where to send the sound, and what to ask for. */
export interface TranscribeOptions {
  /** The transcription model to ask for; each route has its own sensible default. */
  model?: string | undefined;
  /** A language code such as "en" to force, or null to let the service work it out itself. */
  language?: string | null | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * The one place sound is turned into words. Which route runs is decided by the connection that is
 * handed in and by whether the owner has said audio must stay on this computer.
 */
export class Transcription {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    /** Runs a local speech program; replaced in tests so no program is ever started. */
    private readonly runLocal: (exe: string, args: string[], signal?: AbortSignal) => Promise<string> = runProgram,
  ) {}

  /**
   * Writes out one clip. `keepOnThisComputer` refuses both cloud routes in plain words rather
   * than quietly sending the sound anyway, which is the whole point of the setting.
   */
  async transcribe(
    clip: AudioClip,
    route: { kind: SttRoute; provider?: AudioProvider | null; local?: LocalSpeech },
    options: TranscribeOptions & { keepOnThisComputer?: boolean } = {},
  ): Promise<TranscriptionResult> {
    if (options.keepOnThisComputer && route.kind !== "local")
      throw new Error(
        "You asked for audio to stay on this computer, so this recording was not sent anywhere. Set up a speech program on this computer under Settings → Voice, or turn that setting off.",
      );
    if (route.kind === "local") return this.local(clip, route.local ?? LocalSpeechSchema.parse({}), options);
    if (route.kind === "gemini") return this.gemini(clip, route.provider ?? null, options);
    return this.openai(clip, route.provider ?? null, options);
  }

  /** The Whisper shape every OpenAI-compatible service speaks: a form post with the sound in it. */
  private async openai(clip: AudioClip, provider: AudioProvider | null, options: TranscribeOptions): Promise<TranscriptionResult> {
    if (!provider) throw new Error("Writing out speech needs a connection that offers it. Add one under Settings → Models.");
    const model = options.model || "whisper-1";
    const url = await this.allowed(provider.endpoint, "/audio/transcriptions");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(clip.bytes)], { type: clip.mediaType }), clip.name);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    if (options.language) form.append("language", options.language);
    const response = await this.fetch(url, {
      method: "POST", headers: { authorization: `Bearer ${provider.apiKey}` }, body: form,
      redirect: "error", ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = openaiShape.parse(await readJson(response, "Writing out the speech"));
    if (!parsed.text) throw new Error("The speech service answered without any words in it");
    return { text: parsed.text, route: "openai", language: parsed.language ?? options.language ?? null,
      cost: estimateAudioCost(model, clip.seconds, "openai") };
  }

  /** Gemini takes the sound inline, base64, beside a short instruction, through generateContent. */
  private async gemini(clip: AudioClip, provider: AudioProvider | null, options: TranscribeOptions): Promise<TranscriptionResult> {
    if (!provider) throw new Error("Writing out speech needs a connection that offers it. Add one under Settings → Models.");
    const model = options.model || "gemini-2.5-flash";
    const url = await this.allowed(provider.endpoint, `/v1beta/models/${model}:generateContent`);
    const ask = options.language
      ? `Write out exactly what is said in this recording, in ${options.language}. Answer with the words only.`
      : "Write out exactly what is said in this recording, in whatever language it is spoken. Answer with the words only.";
    const response = await this.fetch(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", ...geminiAuth(provider) },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: ask },
          { inlineData: { mimeType: clip.mediaType, data: Buffer.from(clip.bytes).toString("base64") } },
        ] }],
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const parsed = geminiShape.parse(await readJson(response, "Writing out the speech"));
    const text = (parsed.candidates[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
    if (!text) throw new Error("The speech service answered without any words in it");
    return { text, route: "gemini", language: options.language ?? null, cost: estimateAudioCost(model, clip.seconds, "gemini") };
  }

  /** A speech program the owner installed. The sound is written to a temporary file and removed. */
  private async local(clip: AudioClip, settings: LocalSpeech, options: TranscribeOptions): Promise<TranscriptionResult> {
    if (!settings.executable)
      throw new Error("No speech program is set up on this computer. Point Branch at whisper.cpp or faster-whisper under Settings → Voice; Branch never downloads one for you.");
    await access(settings.executable, constants.X_OK).catch(() => {
      throw new Error(`Branch cannot run ${settings.executable}. Check the path under Settings → Voice.`);
    });
    const folder = await mkdtemp(join(tmpdir(), "branch-speech-"));
    const wav = join(folder, "clip.wav");
    try {
      await writeFile(wav, Buffer.from(clip.bytes), { mode: 0o600 });
      const out = await this.runLocal(settings.executable, localSttArgs(settings, wav, options.language ?? null), options.signal);
      const text = out.replace(/\[[0-9:.\s>-]+\]/g, "").trim();
      if (!text) throw new Error("The speech program on this computer answered without any words in it");
      return { text, route: "local", language: options.language ?? null, cost: estimateAudioCost("local", clip.seconds, "local") };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Every outbound address goes past the network policy before a single byte is sent. */
  private async allowed(endpoint: string, path: string): Promise<string> {
    const url = new URL(endpoint.replace(/\/$/, "") + path);
    try {
      await this.policy.assertAllowed(url, "speech service");
    } catch (error) {
      throw new Error(`Cannot reach the speech service: ${error instanceof Error ? error.message : String(error)}`);
    }
    return url.href;
  }
}

/**
 * How Gemini is told who is asking. A key goes in the header Google documents for keys; a sign-in
 * token goes in the ordinary bearer header. Nothing is ever put in the address itself.
 */
export function geminiAuth(provider: AudioProvider & { bearer?: boolean }): Record<string, string> {
  return provider.bearer ? { authorization: `Bearer ${provider.apiKey}` } : { "x-goog-api-key": provider.apiKey };
}

async function readJson(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`${what} failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response.json();
}

/** Runs a program with an argument list, never a shell line, so nothing in the text can be run. */
export function runProgram(file: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1_048_576, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => (error ? reject(new Error((stderr || error.message).trim().slice(0, 300))) : resolve(stdout))));
}

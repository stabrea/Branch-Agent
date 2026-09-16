import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { AudioProvider } from "./voice.js";
import { geminiAuth, runProgram, type AudioCostEstimate } from "./voice-stt.js";

/**
 * Reading text aloud. Three routes: an OpenAI-shaped `/audio/speech`, Gemini's own speech route,
 * and the voices that come with Windows, which need no key, no account and no internet at all.
 * The Windows route is what makes "read this aloud" work on a computer that is offline.
 */
export type TtsRoute = "openai" | "gemini" | "windows";

export interface SpokenAudio {
  bytes: Uint8Array;
  mediaType: string;
  route: TtsRoute;
  voice: string;
  cost: AudioCostEstimate;
}

/** The day the per-thousand-character prices below were read. */
export const speechPricedAt = "2026-09-16";
/** Published prices for reading aloud one thousand characters, in US dollars. */
export const ttsPricesPerThousand: Record<string, number> = {
  "tts-1": 0.015,
  "tts-1-hd": 0.03,
  "gpt-4o-mini-tts": 0.012,
};

/** What reading a piece of text aloud probably costs. An unlisted model reports no amount. */
export function estimateSpeechCost(model: string, characters: number, route: TtsRoute): AudioCostEstimate {
  if (route === "windows")
    return { amount: 0, currency: "USD", confidence: "free", note: "this used a voice already on your computer, so nothing was charged" };
  const each = ttsPricesPerThousand[model] ?? ttsPricesPerThousand[model.toLowerCase()];
  if (each === undefined)
    return { amount: null, currency: "USD", confidence: "unknown", note: `no price on file for ${model}` };
  return {
    amount: Math.round((each * characters / 1000) * 1_000_000) / 1_000_000,
    currency: "USD", confidence: "table", note: `list price for ${model} as of ${speechPricedAt}`,
  };
}

export const SpeakRequestSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voice: z.string().trim().max(80).default(""),
  /** How fast to speak: 1 is the usual pace. */
  speed: z.number().min(0.5).max(2).default(1),
  model: z.string().trim().max(200).optional(),
}).strict();
export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;

/**
 * The PowerShell that asks Windows to read a sentence into a WAV file with a voice already on the
 * computer. Pure and exported so it can be read and checked without a single sound being played.
 * Every value the model could influence — the words, the voice name, the file — is put in as a
 * single-quoted PowerShell string with its own quotes doubled, so none of it can end the string.
 */
export function sapiScript(input: { text: string; voice: string; rate: number; wavPath: string }): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  // Windows takes a speaking rate from -10 to 10; 0 is the usual pace.
  const rate = Math.max(-10, Math.min(10, Math.round((input.rate - 1) * 10)));
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$speech.Rate = ${rate}`,
    input.voice ? `$speech.SelectVoice(${quote(input.voice)})` : "",
    `$speech.SetOutputToWaveFile(${quote(input.wavPath)})`,
    `$speech.Speak(${quote(input.text)})`,
    "$speech.Dispose()",
  ].filter(Boolean).join("\n");
}

/** The PowerShell that lists the voices installed on this computer, one name per line. */
export const sapiVoicesScript =
  "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Speech\n" +
  "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
  "ForEach-Object { $_.VoiceInfo.Name }";

/** How PowerShell is started: no profile, no questions, no console window, and a file, not a line. */
export function powershellArgs(scriptPath: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
}

/** The one place text is turned into sound, whichever route does the work. */
export class Speech {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
    /** Runs PowerShell; replaced in tests so no sound is ever produced on the owner's computer. */
    private readonly runShell: (file: string, args: string[], signal?: AbortSignal) => Promise<string> = runProgram,
  ) {}

  /**
   * Reads text aloud into sound bytes. `keepOnThisComputer` refuses both cloud routes in plain
   * words, so a tool call cannot quietly send the words away after the owner said not to.
   */
  async speak(
    request: SpeakRequest,
    route: { kind: TtsRoute; provider?: AudioProvider | null },
    options: { keepOnThisComputer?: boolean; signal?: AbortSignal } = {},
  ): Promise<SpokenAudio> {
    if (options.keepOnThisComputer && route.kind !== "windows")
      throw new Error(
        "You asked for audio to stay on this computer, so nothing was sent away. Choose the voice that comes with Windows under Settings → Voice, or turn that setting off.",
      );
    if (route.kind === "windows") return this.windows(request, options.signal);
    if (route.kind === "gemini") return this.gemini(request, route.provider ?? null, options.signal);
    return this.openai(request, route.provider ?? null, options.signal);
  }

  private async openai(request: SpeakRequest, provider: AudioProvider | null, signal?: AbortSignal): Promise<SpokenAudio> {
    if (!provider) throw new Error("Reading aloud through your provider needs a connection that offers it. Add one under Settings → Models.");
    const model = request.model || "tts-1";
    const voice = request.voice || "alloy";
    const url = await this.allowed(provider.endpoint, "/audio/speech");
    const response = await this.fetch(url, {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, input: request.text, voice, speed: request.speed }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: "audio/mpeg", route: "openai", voice,
      cost: estimateSpeechCost(model, request.text.length, "openai") };
  }

  /** Gemini answers with the sound inline, base64, inside its ordinary generateContent reply. */
  private async gemini(request: SpeakRequest, provider: AudioProvider | null, signal?: AbortSignal): Promise<SpokenAudio> {
    if (!provider) throw new Error("Reading aloud through your provider needs a connection that offers it. Add one under Settings → Models.");
    const model = request.model || "gemini-2.5-flash-preview-tts";
    const voice = request.voice || "Kore";
    const url = await this.allowed(provider.endpoint, `/v1beta/models/${model}:generateContent`);
    const response = await this.fetch(url, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", ...geminiAuth(provider) },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: request.text }] }],
        generationConfig: { responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw await failure(response);
    const parsed = geminiSpeech.parse(await response.json());
    const part = (parsed.candidates[0]?.content?.parts ?? []).find((entry) => entry.inlineData?.data);
    if (!part?.inlineData?.data) throw new Error("The speech service answered without any sound in it");
    return { bytes: new Uint8Array(Buffer.from(part.inlineData.data, "base64")),
      mediaType: part.inlineData.mimeType || "audio/wav", route: "gemini", voice,
      cost: estimateSpeechCost(model, request.text.length, "gemini") };
  }

  /** A voice that comes with Windows. Nothing leaves the computer and nothing is charged. */
  private async windows(request: SpeakRequest, signal?: AbortSignal): Promise<SpokenAudio> {
    if (process.platform !== "win32")
      throw new Error("The built-in voice is part of Windows, and this is not Windows. Choose a provider voice under Settings → Voice.");
    const folder = await mkdtemp(join(tmpdir(), "branch-voice-"));
    const wav = join(folder, "speech.wav"), script = join(folder, "speak.ps1");
    try {
      await writeFile(script, sapiScript({ text: request.text, voice: request.voice, rate: request.speed, wavPath: wav }), { mode: 0o600 });
      await this.runShell("powershell.exe", powershellArgs(script), signal);
      const bytes = await readFile(wav);
      if (!bytes.length) throw new Error("Windows produced no sound; check that a voice is installed under Windows speech settings.");
      return { bytes: new Uint8Array(bytes), mediaType: "audio/wav", route: "windows", voice: request.voice || "the Windows voice",
        cost: estimateSpeechCost("windows", request.text.length, "windows") };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The voices installed on this computer, for the list in Settings → Voice. Empty off Windows. */
  async windowsVoices(): Promise<string[]> {
    if (process.platform !== "win32") return [];
    const folder = await mkdtemp(join(tmpdir(), "branch-voice-"));
    const script = join(folder, "voices.ps1");
    try {
      await writeFile(script, sapiVoicesScript, { mode: 0o600 });
      const out = await this.runShell("powershell.exe", powershellArgs(script));
      return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 40);
    } catch { return []; } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async allowed(endpoint: string, path: string): Promise<string> {
    const url = new URL(endpoint.replace(/\/$/, "") + path);
    try {
      await this.policy.assertAllowed(url, "reading aloud");
    } catch (error) {
      throw new Error(`Cannot reach the voice service: ${error instanceof Error ? error.message : String(error)}`);
    }
    return url.href;
  }
}

const geminiSpeech = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ inlineData: z.object({ mimeType: z.string().optional(), data: z.string() }).optional() }).loose()).default([]),
    }).optional(),
  })).default([]),
}).loose();

async function failure(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => response.statusText);
  return new Error(`Reading aloud failed: ${response.status} ${detail.slice(0, 300)}`);
}

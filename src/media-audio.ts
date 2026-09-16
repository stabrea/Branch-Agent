import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { AudioProvider } from "./voice.js";

/**
 * Sound files this app can work with on its own. Trimming is done here in plain JavaScript on
 * uncompressed WAV sound; nothing is shelled out to a converter, so MP3, M4A and the rest are
 * turned down in plain words rather than half-handled.
 */
export const trimmableNote =
  "Only WAV sound files can be trimmed here. MP3, M4A, OGG and other squeezed formats need a converter, which is not part of this app.";

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bytes for one moment of sound across every channel. */
  blockAlign: number;
}
export interface WavSound extends WavFormat {
  /** The raw samples, without any header. */
  samples: Buffer;
  seconds: number;
}
const fourcc = (buffer: Buffer, at: number): string => buffer.toString("latin1", at, at + 4);

/** Reads a WAV file's shape and its samples. Throws plain words when the file is not WAV. */
export function readWav(file: Buffer): WavSound {
  if (file.length < 44 || fourcc(file, 0) !== "RIFF" || fourcc(file, 8) !== "WAVE")
    throw new Error(`That file is not a WAV sound file. ${trimmableNote}`);
  let format: WavFormat | null = null;
  let samples: Buffer | null = null;
  let at = 12;
  while (at + 8 <= file.length) {
    const name = fourcc(file, at);
    const size = file.readUInt32LE(at + 4);
    const body = file.subarray(at + 8, Math.min(at + 8 + size, file.length));
    if (name === "fmt " && body.length >= 16) {
      const bits = body.readUInt16LE(14);
      format = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        bitsPerSample: bits,
        blockAlign: body.readUInt16LE(12) || Math.max(1, (body.readUInt16LE(2) * bits) / 8),
      };
    }
    if (name === "data") samples = body;
    at += 8 + size + (size % 2);
  }
  if (!format || !samples) throw new Error("That WAV file is missing its format or its sound");
  if (!format.blockAlign || !format.sampleRate) throw new Error("That WAV file reports an impossible format");
  return { ...format, samples, seconds: samples.length / (format.sampleRate * format.blockAlign) };
}

/** Builds a complete 44-byte-header WAV file around a stretch of samples. */
export function writeWav(format: WavFormat, samples: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = format.sampleRate * format.blockAlign;
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

export const TrimSchema = z
  .object({
    path: z.string().min(1).max(500),
    from: z.number().min(0).max(86400).default(0),
    to: z.number().min(0).max(86400),
    save: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*\.wav$/i, "Save the trimmed sound under a simple name ending in .wav")
      .optional(),
  })
  .strict()
  .refine((input) => input.to > input.from, { message: "The end has to come after the start" });

/** Cuts a stretch of sound out of a WAV file and returns a complete new WAV file. */
export function trimWav(file: Buffer, from: number, to: number): { wav: Buffer; seconds: number; of: number } {
  const sound = readWav(file);
  if (from >= sound.seconds) throw new Error(`That sound is only ${sound.seconds.toFixed(2)} seconds long`);
  const snap = (second: number): number =>
    Math.min(sound.samples.length, Math.floor((second * sound.sampleRate * sound.blockAlign) / sound.blockAlign) * sound.blockAlign);
  const start = snap(from);
  const end = Math.max(start + sound.blockAlign, snap(to));
  const cut = sound.samples.subarray(start, end);
  return { wav: writeWav(sound, cut), seconds: cut.length / (sound.sampleRate * sound.blockAlign), of: sound.seconds };
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
}
const transcriptResponse = z.object({
  text: z.string().optional(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
});

/**
 * Sends one sound file to the provider's transcription route — the same route the microphone
 * button uses — and asks for the times each phrase was said when the caller wants them. A
 * provider that does not offer times simply answers without any, and the tool says so.
 */
export async function transcribeFile(
  file: Buffer,
  name: string,
  mediaType: string,
  provider: AudioProvider | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  options: { model?: string; timestamps?: boolean; signal?: AbortSignal } = {},
): Promise<Transcript> {
  if (!provider)
    throw new Error("Writing out speech needs an OpenAI-compatible provider with a key. Add one in Settings → Model.");
  const url = provider.endpoint.replace(/\/$/, "") + "/audio/transcriptions";
  try {
    await policy.assertAllowed(new URL(url), "writing out speech");
  } catch (e) {
    throw new Error(`Cannot reach the transcription service: ${e instanceof Error ? e.message : String(e)}`);
  }
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file)], { type: mediaType }), name);
  form.append("model", options.model ?? "whisper-1");
  if (options.timestamps) {
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}` },
    body: form,
    ...(options.signal ? { signal: options.signal } : {}),
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Writing out the speech failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  const parsed = transcriptResponse.parse(await response.json());
  if (!parsed.text) throw new Error("The transcription service answered without any words in it");
  return { text: parsed.text, segments: (parsed.segments ?? []).slice(0, 200) };
}

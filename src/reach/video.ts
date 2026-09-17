import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { WorkspaceFiles } from "../files.js";
import { readCapped } from "../interop/agent-market.js";
import type { Store } from "../store.js";
import { reachRecord, requireReach } from "./settings.js";

/**
 * R17-079: making a short video from words, through a provider's own published video API and a key
 * the owner keeps in the locker. Two services are offered, each through its documented route only:
 *
 *   OpenAI   POST /v1/videos, then GET /v1/videos/{id} until it is done, then GET …/content
 *   Google   POST /v1beta/models/{model}:predictLongRunning (the Gemini API's Veo models), then
 *            GET /v1beta/{operation} until it is done, then the file address it gives
 *
 * The key is read from the locker at the moment of the call and only ever goes in a header, never in
 * an address. The fetch handed in follows the owner's network rules for every request, including the
 * download. Nothing is followed silently: a redirect is only taken for Google's download, only over
 * https, and without the key. The finished file is written into the workspace under `made/videos/`.
 * Making videos costs money at both services, which the card says before the switch.
 *
 * The idea is Hermes Agent's video generation tool (MIT); this is an independent implementation.
 */
export const videoServices = ["openai", "google"] as const;
export const VideoSettingsSchema = z.object({
  service: z.enum(videoServices).default("openai"),
  /** The locker entry holding the key. */
  secret: z.string().trim().min(1).max(80).default("OPENAI_API_KEY"),
  model: z.string().trim().max(80).default(""),
}).strict();
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;
const settingsKey = "reach-video-settings";
const defaults = { openai: { model: "sora-2", base: "https://api.openai.com" }, google: { model: "veo-3.0-generate-001", base: "https://generativelanguage.googleapis.com" } };

export const VideoRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  seconds: z.union([z.literal(4), z.literal(8), z.literal(12)]).default(8),
  shape: z.enum(["wide", "tall"]).default("wide"),
}).strict();

export interface VideoDeps {
  fetcher: typeof fetch;
  secret: (name: string) => Promise<string>;
  files: WorkspaceFiles;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}
export const maxVideoBytes = 200 * 1024 * 1024;
const pollMs = 5000, pollTimes = 120;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function videoSettings(store: Store, owner: string): VideoSettings { return reachRecord(store, owner, settingsKey, VideoSettingsSchema); }
export function saveVideoSettings(store: Store, owner: string, input: unknown): VideoSettings {
  const value = VideoSettingsSchema.parse({ ...videoSettings(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, value);
  return value;
}

async function failed(response: Response, what: string): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 300);
  throw new Error(`The video service refused ${what} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

type Job = { key: string; model: string; deps: VideoDeps; signal: AbortSignal };

async function openaiVideo(job: Job, request: z.infer<typeof VideoRequestSchema>): Promise<Buffer> {
  const { deps, key, signal } = job, base = defaults.openai.base, auth = { authorization: `Bearer ${key}` };
  const size = request.shape === "wide" ? "1280x720" : "720x1280";
  const made = await deps.fetcher(`${base}/v1/videos`, { method: "POST", redirect: "error", signal,
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ model: job.model, prompt: request.prompt, seconds: String(request.seconds), size }) });
  if (!made.ok) await failed(made, "the request");
  const { id } = z.object({ id: z.string().regex(/^[\w-]{1,120}$/) }).passthrough().parse(await made.json());
  for (let i = 0; i < pollTimes; i++) {
    const state = await deps.fetcher(`${base}/v1/videos/${id}`, { headers: auth, redirect: "error", signal });
    if (!state.ok) await failed(state, "a progress check");
    const { status, error } = z.object({ status: z.string(), error: z.unknown().optional() }).passthrough().parse(await state.json());
    if (status === "failed") throw new Error(`The video could not be made: ${JSON.stringify(error ?? "no reason given").slice(0, 200)}`);
    if (status === "completed") {
      const file = await deps.fetcher(`${base}/v1/videos/${id}/content`, { headers: auth, redirect: "error", signal });
      if (!file.ok) await failed(file, "the download");
      return readCapped(file, maxVideoBytes);
    }
    await (deps.sleep ?? wait)(pollMs);
  }
  throw new Error("The video was not ready after ten minutes. It may still appear in your OpenAI account.");
}

async function googleVideo(job: Job, request: z.infer<typeof VideoRequestSchema>): Promise<Buffer> {
  const { deps, key, signal } = job, base = defaults.google.base, auth = { "x-goog-api-key": key };
  const made = await deps.fetcher(`${base}/v1beta/models/${encodeURIComponent(job.model)}:predictLongRunning`, {
    method: "POST", redirect: "error", signal, headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ instances: [{ prompt: request.prompt }], parameters: { aspectRatio: request.shape === "wide" ? "16:9" : "9:16", durationSeconds: Math.min(request.seconds, 8) } }) });
  if (!made.ok) await failed(made, "the request");
  const { name } = z.object({ name: z.string().regex(/^[\w/.-]{1,200}$/) }).passthrough().parse(await made.json());
  for (let i = 0; i < pollTimes; i++) {
    const state = await deps.fetcher(`${base}/v1beta/${name}`, { headers: auth, redirect: "error", signal });
    if (!state.ok) await failed(state, "a progress check");
    const body = await state.json() as { done?: boolean; error?: { message?: string }; response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[] } } };
    if (body.error) throw new Error(`The video could not be made: ${String(body.error.message ?? "no reason given").slice(0, 200)}`);
    if (body.done) return googleDownload(job, body.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri);
    await (deps.sleep ?? wait)(pollMs);
  }
  throw new Error("The video was not ready after ten minutes.");
}

/** Google's file address answers with the key and may send the file from elsewhere: followed once, over https, without the key. */
async function googleDownload(job: Job, uri: string | undefined): Promise<Buffer> {
  if (!uri) throw new Error("Google finished without a video in its answer.");
  const first = new URL(uri);
  if (first.protocol !== "https:" || first.host !== new URL(defaults.google.base).host) throw new Error("Google answered with a file address Branch does not trust.");
  const answer = await job.deps.fetcher(first, { headers: { "x-goog-api-key": job.key }, redirect: "manual", signal: job.signal });
  if (answer.status >= 300 && answer.status < 400) {
    const next = new URL(answer.headers.get("location") ?? "", first);
    if (next.protocol !== "https:") throw new Error("Google sent the file somewhere that is not https.");
    const moved = await job.deps.fetcher(next, { redirect: "error", signal: job.signal });
    if (!moved.ok) await failed(moved, "the download");
    return readCapped(moved, maxVideoBytes);
  }
  if (!answer.ok) await failed(answer, "the download");
  return readCapped(answer, maxVideoBytes);
}

/** Makes one video and writes it into the workspace. */
export async function makeVideo(store: Store, owner: string, deps: VideoDeps, input: unknown, signal: AbortSignal): Promise<{ path: string; bytes: number; service: string; model: string }> {
  requireReach(store, owner, "video");
  const request = VideoRequestSchema.parse(input);
  const settings = videoSettings(store, owner);
  const model = settings.model || defaults[settings.service].model;
  const job: Job = { key: await deps.secret(settings.secret), model, deps, signal };
  const bytes = settings.service === "openai" ? await openaiVideo(job, request) : await googleVideo(job, request);
  if (bytes.length < 12 || !["ftyp", "moov", "mdat", "free"].includes(bytes.toString("latin1", 4, 8)))
    throw new Error("The service sent something that is not an MP4 video, so it was not kept.");
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const path = `made/videos/video-${stamp}.mp4`;
  const target = await deps.files.checkedForWrite(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { mode: 0o600 });
  return { path, bytes: bytes.length, service: settings.service, model };
}

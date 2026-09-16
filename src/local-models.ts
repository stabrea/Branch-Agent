import { z } from "zod";
import { defaultEmbeddingModel, type Embedder } from "./document-embeddings.js";

/**
 * Models that run on this computer, through Ollama or LM Studio. Both listen on loopback only, so
 * these requests deliberately skip the outbound network policy the way `/api/providers/local`
 * already does; every address is checked to be on this computer first, and nothing else is allowed.
 */
export const ollamaHome = "http://127.0.0.1:11434";
export const lmStudioHome = "http://127.0.0.1:1234";
export const ollamaDownloadPage = "https://ollama.com/download";
export const lmStudioDownloadPage = "https://lmstudio.ai/";
/** What to use for comparing passages by meaning when the connected model runs on this computer. */
export const defaultLocalEmbeddingModel = "nomic-embed-text";

const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
/** Refuses any address that is not on this computer, before a single request is sent. */
export function assertOnThisComputer(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A local model address must start with http");
  if (url.username || url.password || url.search || url.hash) throw new Error("A local model address must be plain, with no key or extras");
  if (!loopback.has(url.hostname.toLowerCase())) throw new Error(`${url.hostname} is not on this computer, so it cannot be a local model server`);
  return url;
}
export const localModelName = z.string().trim().min(1).max(160)
  .regex(/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/i, "That is not a model name Ollama would recognise");

export interface LocalModel {
  name: string;
  /** Bytes on disk. */
  size: number;
  family: string;
  /** For example "8B"; empty when the server does not say. */
  parameterSize: string;
  /** How much text it can hold at once, in tokens; null when the server does not say. */
  contextLength: number | null;
  /** True for the llava family and other models that can be shown a picture. */
  canSeePictures: boolean;
  modifiedAt: string;
}
/** One progress line while a model is being downloaded. The event name is `model.download.progress`. */
export interface DownloadProgress {
  event: "model.download.progress";
  model: string;
  /** The runtime's own words, for example "pulling manifest" or "downloading". */
  status: string;
  completed: number;
  total: number;
  /** 0 to 100; 100 only once the download finished. */
  percent: number;
  done: boolean;
  error?: string;
}

const detailsSchema = z.object({
  family: z.string().optional(),
  families: z.array(z.string()).nullable().optional(),
  parameter_size: z.string().optional(),
}).optional();
const tagsSchema = z.object({
  models: z.array(z.object({
    name: z.string().min(1), size: z.number().nonnegative().optional(),
    modified_at: z.string().optional(), details: detailsSchema,
  })).default([]),
});
const showSchema = z.object({
  details: detailsSchema,
  model_info: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.array(z.string()).optional(),
});
const progressSchema = z.object({
  status: z.string().optional(), total: z.number().nonnegative().optional(),
  completed: z.number().nonnegative().optional(), error: z.string().optional(),
});
const embeddingSchema = z.object({ embedding: z.array(z.number()).min(1).max(8192) });

const visionNames = /(llava|bakllava|moondream|vision|minicpm-v|gemma3)/i;
/** Whether a model on this computer can be shown a picture, from its name and what it reports. */
export function localModelSupportsImages(name: string, families: string[] = [], capabilities: string[] = []): boolean {
  if (capabilities.includes("vision")) return true;
  if (families.some((family) => /clip|mllama|vision/i.test(family))) return true;
  return visionNames.test(name);
}
/** The largest `*.context_length` figure Ollama reports for a model, or null when it reports none. */
export function contextLengthOf(info: Record<string, unknown> | undefined): number | null {
  const sizes = Object.entries(info ?? {})
    .filter(([key, value]) => key.endsWith(".context_length") && typeof value === "number" && value > 0)
    .map(([, value]) => value as number);
  return sizes.length ? Math.max(...sizes) : null;
}

/** Reads a newline-delimited JSON stream, handing over one complete line at a time. */
async function eachLine(body: ReadableStream<Uint8Array>, handle: (line: string) => void): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line) handle(line);
      }
      if (buffer.length > 65536) throw new Error("The local model server sent an unreadable progress line");
    }
    if (buffer.trim()) handle(buffer.trim());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Turns one line from Ollama into a progress report, keeping the last known totals. */
export function describeProgress(model: string, line: z.infer<typeof progressSchema>, previous: DownloadProgress): DownloadProgress {
  if (line.error) return { ...previous, status: "failed", done: true, error: line.error.slice(0, 200) };
  const total = line.total ?? previous.total;
  const completed = line.completed ?? (line.total === undefined ? previous.completed : 0);
  const status = line.status ?? previous.status;
  const done = status === "success";
  const percent = done ? 100 : total > 0 ? Math.min(99, Math.floor((completed / total) * 100)) : previous.percent;
  return { event: "model.download.progress", model, status, completed, total, percent, done };
}

/** Ollama's own API on this computer: what is installed, downloading a model, and removing one. */
export class OllamaClient {
  readonly base: string;
  constructor(baseUrl: string = ollamaHome, private readonly call: typeof fetch = globalThis.fetch) {
    this.base = assertOnThisComputer(baseUrl).origin;
  }
  private async json(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<unknown> {
    const response = await this.call(this.base + path, {
      redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}`);
    const text = await response.text();
    if (text.length > 4_194_304) throw new Error("Ollama returned too much data");
    return text ? (JSON.parse(text) as unknown) : {};
  }
  /** The running version, or null when Ollama is not installed or has not been started. */
  async version(): Promise<string | null> {
    try {
      const body = z.object({ version: z.string().optional() }).parse(await this.json("/api/version", {}, 1500));
      return body.version ?? "unknown";
    } catch { return null; }
  }
  /** Every model already downloaded on this computer, biggest first. */
  async list(): Promise<LocalModel[]> {
    const body = tagsSchema.parse(await this.json("/api/tags", {}, 4000));
    return body.models.map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      family: model.details?.family ?? model.name.split(":")[0]!,
      parameterSize: model.details?.parameter_size ?? "",
      contextLength: null,
      canSeePictures: localModelSupportsImages(model.name, model.details?.families ?? []),
      modifiedAt: model.modified_at ?? "",
    })).sort((a, b) => b.size - a.size);
  }
  /** What one model is: family, size on disk, how much it can hold, whether it can see pictures. */
  async show(name: string): Promise<LocalModel> {
    const model = localModelName.parse(name);
    const body = showSchema.parse(await this.json("/api/show", { method: "POST", body: JSON.stringify({ model }) }, 8000));
    const listed = (await this.list().catch(() => [] as LocalModel[]))
      .find((entry) => entry.name === model || entry.name.split(":")[0] === model.split(":")[0]);
    return {
      name: model,
      size: listed?.size ?? 0,
      family: body.details?.family ?? listed?.family ?? "",
      parameterSize: body.details?.parameter_size ?? listed?.parameterSize ?? "",
      contextLength: contextLengthOf(body.model_info),
      canSeePictures: localModelSupportsImages(model, body.details?.families ?? [], body.capabilities ?? []),
      modifiedAt: listed?.modifiedAt ?? "",
    };
  }
  /**
   * Downloads a model, reporting progress as it goes. Ollama streams one JSON object per line;
   * each becomes a `model.download.progress` report for the screen.
   */
  async pull(name: string, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal): Promise<DownloadProgress> {
    const model = localModelName.parse(name);
    const response = await this.call(this.base + "/api/pull", {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }), ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama would not start the download (${response.status})`);
    let last: DownloadProgress = { event: "model.download.progress", model, status: "starting", completed: 0, total: 0, percent: 0, done: false };
    await eachLine(response.body, (line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return; }
      const report = progressSchema.safeParse(parsed);
      if (!report.success) return;
      last = describeProgress(model, report.data, last);
      onProgress(last);
    });
    if (last.error) throw new Error(last.error);
    if (!last.done) { last = { ...last, status: "success", percent: 100, done: true }; onProgress(last); }
    return last;
  }
  /** Removes a downloaded model from this computer. */
  async remove(name: string): Promise<{ removed: string }> {
    const model = localModelName.parse(name);
    await this.json("/api/delete", { method: "DELETE", body: JSON.stringify({ model }) }, 20000);
    return { removed: model };
  }
  /** One vector per passage, through Ollama's own embeddings route (one passage per request). */
  async embed(texts: string[], model: string, signal: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (const prompt of texts) {
      const response = await this.call(this.base + "/api/embeddings", {
        method: "POST", redirect: "error", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, prompt }),
      });
      if (!response.ok) throw new Error(`The model on this computer could not read these passages (${response.status})`);
      vectors.push(Float32Array.from(embeddingSchema.parse(JSON.parse(await response.text()) as unknown).embedding));
    }
    return vectors;
  }
}

const lmModelSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1), state: z.string().optional(), max_context_length: z.number().nonnegative().optional(),
  })).default([]),
});
/**
 * LM Studio, as far as its API allows: it lists what is downloaded and says which model is loaded.
 * There is no public route to unload one, and asking a model for anything is what loads it, so
 * `load` sends the smallest possible request and lets LM Studio bring the model into memory.
 */
export class LmStudioClient {
  readonly base: string;
  constructor(baseUrl: string = lmStudioHome, private readonly call: typeof fetch = globalThis.fetch) {
    this.base = assertOnThisComputer(baseUrl).origin;
  }
  async list(): Promise<{ running: boolean; models: { name: string; loaded: boolean; contextLength: number | null }[] }> {
    for (const path of ["/api/v0/models", "/v1/models"]) {
      try {
        const response = await this.call(this.base + path, { redirect: "error", signal: AbortSignal.timeout(2000) });
        if (!response.ok) continue;
        const body = lmModelSchema.parse(JSON.parse(await response.text()) as unknown);
        return {
          running: true,
          models: body.data.map((entry) => ({
            name: entry.id, loaded: entry.state === "loaded", contextLength: entry.max_context_length ?? null,
          })),
        };
      } catch { /* try the next route, then report it is not running */ }
    }
    return { running: false, models: [] };
  }
  /** Asks LM Studio for one token from a model, which is what makes it load the model into memory. */
  async load(model: string, signal = AbortSignal.timeout(120000)): Promise<{ loaded: string }> {
    const name = localModelName.parse(model);
    const response = await this.call(this.base + "/v1/chat/completions", {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: "Bearer local" },
      body: JSON.stringify({ model: name, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (!response.ok) throw new Error(`LM Studio would not load ${name} (${response.status})`);
    await response.text();
    return { loaded: name };
  }
}

/** A passage reader backed by Ollama, used in place of the cloud one when the model runs here. */
export class OllamaEmbedder implements Embedder {
  constructor(private readonly client: OllamaClient, readonly model: string = defaultLocalEmbeddingModel) {}
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    return this.client.embed(texts, this.model, signal);
  }
}

/**
 * An Ollama-backed passage reader when the connected model is Ollama on this computer, otherwise
 * nothing, so the caller falls back to the provider's own embeddings route.
 */
export function localEmbedder(route: { endpoint: string }, model: string, call: typeof fetch = globalThis.fetch): Embedder | null {
  let url: URL;
  try { url = new URL(route.endpoint); } catch { return null; }
  if (!loopback.has(url.hostname.toLowerCase()) || url.port !== "11434") return null;
  const chosen = model === defaultEmbeddingModel ? defaultLocalEmbeddingModel : model;
  try { return new OllamaEmbedder(new OllamaClient(url.origin, call), chosen); } catch { return null; }
}

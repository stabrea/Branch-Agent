import { z } from "zod";
import type { NetworkPolicy } from "./network-policy.js";
import type { Provider } from "./contracts.js";

/**
 * Where a provider makes pictures. `kind` says which shape of request it understands: the
 * OpenAI-compatible `/images/generations` and `/images/edits` routes, or Gemini's single
 * `generateContent` route asked for a picture instead of words.
 */
export interface ImageEndpoint {
  kind: "openai" | "gemini";
  endpoint: string;
  apiKey: string;
  /** The picture model this provider uses when the owner has not named one. */
  defaultModel: string;
}
/** The picture-making route of a provider that has one; every other provider gives nothing. */
export function providerImages(provider: Provider): ImageEndpoint | null {
  const accessor = (provider as { images?: () => ImageEndpoint | null }).images;
  return typeof accessor === "function" ? accessor.call(provider) : null;
}
/** The words said when the connected model simply cannot make pictures. */
export const noImageEndpoint =
  "The model you are connected to cannot make pictures. Connect an OpenAI-compatible model or a Gemini model under Settings → Model, then ask again.";

export const imageSizes = ["256x256", "512x512", "1024x1024", "1024x1536", "1536x1024"] as const;
export const ImageRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    size: z.enum(imageSizes).default("1024x1024"),
    /** A few words about the look, folded into the prompt. */
    style: z.string().trim().max(200).optional(),
    edit: z
      .object({
        /** A picture already in the workspace that the new one is based on. */
        source: z.string().min(1).max(500),
        /** An optional picture of the same size whose clear areas say what to change. */
        mask: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
    /** A file name to keep the finished picture under, inside the workspace media folder. */
    save: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9._-]*\.(png|jpg|jpeg|webp)$/i, "Save under a simple picture file name such as poster.png")
      .optional(),
  })
  .strict();
export type ImageRequest = z.infer<typeof ImageRequestSchema>;

/** A picture a provider handed back: its bytes and what kind of picture it is. */
export interface MadePicture {
  bytes: Buffer;
  mediaType: string;
}
/** A picture handed to a provider to work from. */
export interface SourcePicture {
  bytes: Buffer;
  mediaType: string;
  name: string;
}
const openaiImages = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1).optional(), url: z.string().optional() })).min(1),
});
const geminiImages = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.object({ inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional() })),
        }),
      }),
    )
    .min(1),
});
const route = (endpoint: string, path: string): string => endpoint.replace(/\/$/, "") + path;

/** The one text the provider is asked for, prompt and look together. */
export function imagePromptText(request: ImageRequest): string {
  return request.style ? `${request.prompt}\n\nStyle: ${request.style}` : request.prompt;
}
async function allowed(policy: NetworkPolicy, url: string, what: string): Promise<void> {
  try {
    await policy.assertAllowed(new URL(url), what);
  } catch (e) {
    throw new Error(`Cannot reach the picture service: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function refused(response: Response): Promise<never> {
  const detail = await response.text().catch(() => response.statusText);
  throw new Error(`The picture service refused the request: ${response.status} ${detail.slice(0, 300)}`);
}
function firstOpenAiPicture(parsed: z.infer<typeof openaiImages>): MadePicture {
  const entry = parsed.data[0]!;
  if (!entry.b64_json)
    throw new Error("The picture service answered with a link instead of the picture, which this app does not follow");
  return { bytes: Buffer.from(entry.b64_json, "base64"), mediaType: "image/png" };
}

/** Asks an OpenAI-compatible provider for a brand new picture. */
export async function generateOpenAi(
  where: ImageEndpoint,
  model: string,
  request: ImageRequest,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<MadePicture> {
  const url = route(where.endpoint, "/images/generations");
  await allowed(policy, url, "making a picture");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${where.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: imagePromptText(request), size: request.size, n: 1, response_format: "b64_json" }),
    signal,
    redirect: "error",
  });
  if (!response.ok) await refused(response);
  return firstOpenAiPicture(openaiImages.parse(await response.json()));
}

/** Asks an OpenAI-compatible provider to change a picture the person already has. */
export async function editOpenAi(
  where: ImageEndpoint,
  model: string,
  request: ImageRequest,
  source: SourcePicture,
  mask: SourcePicture | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<MadePicture> {
  const url = route(where.endpoint, "/images/edits");
  await allowed(policy, url, "changing a picture");
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", imagePromptText(request));
  form.append("size", request.size);
  form.append("n", "1");
  form.append("image", new Blob([new Uint8Array(source.bytes)], { type: source.mediaType }), source.name);
  if (mask) form.append("mask", new Blob([new Uint8Array(mask.bytes)], { type: mask.mediaType }), mask.name);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${where.apiKey}` },
    body: form,
    signal,
    redirect: "error",
  });
  if (!response.ok) await refused(response);
  return firstOpenAiPicture(openaiImages.parse(await response.json()));
}

/** Asks Gemini for a picture; the same route makes one and changes one, the source riding along. */
export async function generateGemini(
  where: ImageEndpoint,
  model: string,
  request: ImageRequest,
  source: SourcePicture | null,
  policy: NetworkPolicy,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<MadePicture> {
  const url = new URL(route(where.endpoint, `/v1beta/models/${model}:generateContent`));
  url.searchParams.set("key", where.apiKey);
  await allowed(policy, url.href, "making a picture");
  const parts: Record<string, unknown>[] = [{ text: imagePromptText(request) }];
  if (source) parts.push({ inlineData: { mimeType: source.mediaType, data: source.bytes.toString("base64") } });
  const response = await fetch(url.href, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
    signal,
    redirect: "error",
  });
  if (!response.ok) await refused(response);
  const parsed = geminiImages.parse(await response.json());
  const picture = parsed.candidates[0]!.content.parts.find((part) => part.inlineData)?.inlineData;
  if (!picture) throw new Error("Gemini answered without a picture in it");
  return { bytes: Buffer.from(picture.data, "base64"), mediaType: picture.mimeType || "image/png" };
}

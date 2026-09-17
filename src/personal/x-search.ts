import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { callJson } from "../channels/parity-common.js";
import { clip, outsideTextNote, partSettings, requirePersonal, savePartSettings, secretNameSchema } from "./settings.js";

/**
 * R17-027: searching posts on X through xAI's own `x_search` tool on its Responses API, with an xAI
 * API key the owner saved in Secrets. The key is the only way in: signing in with a SuperGrok
 * subscription is not used, because xAI's terms do not offer that route to other programs.
 *
 * The request shape follows xAI's documentation and Hermes Agent's `tools/x_search_tool.py` (MIT),
 * written again here: the handles and dates are checked on this computer first, because xAI accepts
 * a bad date silently and answers from the model's memory instead of from X.
 */
export const XSearchSettingsSchema = z.object({
  keyName: secretNameSchema.default("XAI_API_KEY"),
  model: z.string().trim().regex(/^[A-Za-z0-9._-]{1,80}$/).default("grok-4.5"),
  address: z.literal("https://api.x.ai/v1").default("https://api.x.ai/v1"),
}).strict();
const settingsKey = "personal-x-search-settings";

const handle = z.string().trim().regex(/^@?[A-Za-z0-9_]{1,15}$/, "An X handle is up to 15 letters, digits or underscores").transform((h) => h.replace(/^@/, ""));
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2026-09-17");
export const XSearchSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  onlyFrom: z.array(handle).max(10).default([]),
  notFrom: z.array(handle).max(10).default([]),
  since: day.optional(),
  until: day.optional(),
}).strict();

/** The `x_search` tool as xAI wants it, after the checks xAI itself does not make. */
export function xSearchTool(input: z.infer<typeof XSearchSchema>, today = new Date()): Record<string, unknown> {
  if (input.onlyFrom.length && input.notFrom.length) throw new Error("Give either handles to search or handles to leave out, not both");
  const valid = (value: string) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  for (const value of [input.since, input.until]) if (value && !valid(value)) throw new Error(`${value} is not a real date`);
  if (input.since && input.until && input.since > input.until) throw new Error("The start date is after the end date");
  if (input.since && input.since > today.toISOString().slice(0, 10)) throw new Error("X search only finds posts already written; the start date is in the future");
  return { type: "x_search",
    ...(input.onlyFrom.length ? { allowed_x_handles: input.onlyFrom } : {}),
    ...(input.notFrom.length ? { excluded_x_handles: input.notFrom } : {}),
    ...(input.since ? { from_date: input.since } : {}), ...(input.until ? { to_date: input.until } : {}) };
}

const Content = z.object({ type: z.string(), text: z.string().optional(),
  annotations: z.array(z.object({ type: z.string(), url: z.string().optional(), title: z.string().optional() }).passthrough()).optional() }).passthrough();
const ResponseSchema = z.object({
  output_text: z.string().optional(),
  output: z.array(z.object({ type: z.string(), content: z.array(Content).optional() }).passthrough()).default([]),
  citations: z.array(z.unknown()).default([]),
}).passthrough();

/** The answer's words and the posts it cited, from either of the places xAI puts them. */
export function readXAnswer(body: unknown): { answer: string; sources: string[] } {
  const parsed = ResponseSchema.parse(body);
  const contents = parsed.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const answer = parsed.output_text?.trim() || contents.filter((c) => c.type === "output_text" || c.type === "text").map((c) => c.text ?? "").join("\n\n").trim();
  const cited = contents.flatMap((c) => c.annotations ?? []).filter((a) => a.type === "url_citation").map((a) => a.url ?? "");
  const listed = parsed.citations.map((c) => (typeof c === "string" ? c : z.object({ url: z.string() }).passthrough().safeParse(c).data?.url ?? ""));
  return { answer, sources: [...new Set([...listed, ...cited].filter((url) => /^https:\/\//.test(url)))].slice(0, 30) };
}

export class XSearch {
  constructor(private readonly store: Store, private readonly owner: string, private readonly fetcher: typeof fetch,
    private readonly secret: (name: string) => Promise<string>) {}
  settings() { return partSettings(this.store, this.owner, settingsKey, XSearchSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.store, this.owner, settingsKey, XSearchSettingsSchema, input); }

  async search(input: unknown, today = new Date()) {
    requirePersonal(this.store, this.owner, "x-search");
    const value = XSearchSchema.parse(input);
    const tool = xSearchTool(value, today);
    const settings = this.settings();
    const key = await this.secret(settings.keyName);
    const body = await callJson(this.fetcher, "xAI", `${settings.address}/responses`, {
      method: "POST", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(180_000),
      json: { model: settings.model, input: [{ role: "user", content: value.query }], tools: [tool], store: false },
    });
    const { answer, sources } = readXAnswer(body);
    const narrowed = Object.keys(tool).length > 1;
    return { answer: clip(answer, 20000), sources, note: outsideTextNote,
      ...(narrowed && !sources.length ? { warning: "No posts were cited, so this answer may come from the model's memory rather than from X." } : {}) };
  }
}

export function registerXSearch(registry: ToolRegistry, x: XSearch): void {
  registry.register({ name: "x.search", permission: "personal.read",
    description: "Search posts on X (Twitter) through xAI, optionally only from or never from some handles, and between two dates. Answers with the posts it cites.",
    parameters: XSearchSchema, execute: async (input) => x.search(input) });
}

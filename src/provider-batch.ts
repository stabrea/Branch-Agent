import { z } from "zod";
import type { BatchAnswer, BatchApi, BatchRequest, Message } from "./contracts.js";
import type { ProviderOptions } from "./providers.js";

/**
 * Handing a whole set of questions to OpenAI or to Anthropic at once. Both services take a large
 * set, work through it in their own time and charge about half what the same questions cost one at
 * a time; neither answers in seconds, which is why this road is only taken when the owner asks for
 * it and only for work that can wait (see src/batch-inference.ts).
 *
 * The two shapes are quite different. OpenAI wants a file of one question per line uploaded first,
 * then a set created against that file, and the answers fetched back as another file. Anthropic
 * takes the questions in the request itself and hands back an address to read the answers from.
 * Both are reduced here to the same three steps — hand over, ask how it is getting on, collect —
 * so nothing above this file has to know which service it is talking to.
 *
 * A question that failed on its own comes back as an answer carrying an error rather than throwing,
 * so a set that half worked keeps the half that worked.
 */

/** The largest answer file this will read, so one enormous set cannot fill this computer's memory. */
const maximumAnswerBytes = 8 * 1024 * 1024;
/** What the services allow as a name for one question: letters, digits, hyphen, underscore. */
const safeId = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The caller's own ids are allowed to be longer and to carry characters the services refuse, so
 * each question is handed over under a plain `q0`, `q1` name and the real id is put back on the
 * answer. The table lives with the set it belongs to, which is why `submit`, `poll` and `collect`
 * are three methods of one object rather than three loose functions.
 */
class IdTable {
  private readonly tables = new Map<string, Map<string, string>>();
  wire(requests: BatchRequest[]): { table: Map<string, string>; wired: { id: string; request: BatchRequest }[] } {
    const table = new Map<string, string>();
    const wired = requests.map((request, at) => {
      const id = safeId.test(request.id) ? request.id : `q${at}`;
      table.set(id, request.id);
      return { id, request };
    });
    return { table, wired };
  }
  remember(batchId: string, table: Map<string, string>): void { this.tables.set(batchId, table); }
  real(batchId: string, wireId: string): string { return this.tables.get(batchId)?.get(wireId) ?? wireId; }
}

/** One call to a service, with the answer read as text under a cap and the errors kept readable. */
async function callService(
  options: ProviderOptions, url: string, init: RequestInit & { headers: Record<string, string> },
): Promise<string> {
  const call = options.fetchImpl ?? globalThis.fetch;
  const response = await call(url, { ...init, redirect: "error" });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximumAnswerBytes)
    throw new Error(`The service offered ${declared} bytes of answers, which is more than this will read at once.`);
  const text = (await response.text()).slice(0, maximumAnswerBytes);
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
  return text;
}
const base = (options: ProviderOptions): string => options.endpoint.replace(/\/$/, "");
const asJson = (text: string): unknown => JSON.parse(text || "{}") as unknown;
/** Every line of a file of answers, ignoring the blank one at the end. */
const jsonLines = (text: string): unknown[] =>
  text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as unknown);

/* ---------- OpenAI ---------- */

const openaiFile = z.object({ id: z.string() });
const openaiBatch = z.object({
  id: z.string(), status: z.string(),
  output_file_id: z.string().nullish(), error_file_id: z.string().nullish(),
});
const openaiLine = z.object({
  custom_id: z.string(),
  response: z.object({
    status_code: z.number(),
    body: z.object({
      choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
      usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).nullish(),
    }),
  }).nullish(),
  error: z.object({ message: z.string().nullish() }).nullish(),
});

/** One question as OpenAI wants it in the uploaded file: a whole chat request on one line. */
function openaiJsonl(model: string, wired: { id: string; request: BatchRequest }[]): string {
  return wired.map((entry) => JSON.stringify({
    custom_id: entry.id, method: "POST", url: "/v1/chat/completions",
    body: { model, max_tokens: entry.request.maxTokens, messages: entry.request.messages.map(plainMessage) },
  })).join("\n");
}
/** A message with only what a batched question can carry: a role and words. */
const plainMessage = (message: Message): { role: string; content: string } =>
  ({ role: message.role === "tool" ? "user" : message.role, content: message.content });

/**
 * OpenAI's road: upload the questions as a file, create a set against it, then read the answers
 * file back. A question that failed on its own is in a second file, which is read too, so a set
 * where nine worked and one did not gives back nine answers and one error rather than nothing.
 */
export function openaiBatchApi(options: ProviderOptions): BatchApi {
  const ids = new IdTable();
  const headers = { authorization: `Bearer ${options.apiKey}` };
  const getJson = async (path: string, signal: AbortSignal): Promise<unknown> =>
    asJson(await callService(options, base(options) + path, { method: "GET", headers, signal }));
  return {
    async submit(requests, signal) {
      const { table, wired } = ids.wire(requests);
      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([openaiJsonl(options.model, wired)], { type: "application/jsonl" }), "batch.jsonl");
      const file = openaiFile.parse(asJson(await callService(options, `${base(options)}/files`,
        { method: "POST", headers, body: form, signal })));
      const created = openaiBatch.parse(asJson(await callService(options, `${base(options)}/batches`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, signal,
        body: JSON.stringify({ input_file_id: file.id, endpoint: "/v1/chat/completions", completion_window: "24h" }),
      })));
      ids.remember(created.id, table);
      return { batchId: created.id };
    },
    async poll(batchId, signal) {
      const state = openaiBatch.parse(await getJson(`/batches/${encodeURIComponent(batchId)}`, signal));
      if (state.status === "completed") return { status: "completed" };
      if (["validating", "in_progress", "finalizing"].includes(state.status)) return { status: "working" };
      return { status: "failed", error: `The service reported the set as "${state.status}".` };
    },
    async collect(batchId, signal) {
      const state = openaiBatch.parse(await getJson(`/batches/${encodeURIComponent(batchId)}`, signal));
      const answers: BatchAnswer[] = [];
      for (const fileId of [state.output_file_id, state.error_file_id]) {
        if (!fileId) continue;
        const text = await callService(options, `${base(options)}/files/${encodeURIComponent(fileId)}/content`,
          { method: "GET", headers, signal });
        for (const line of jsonLines(text)) answers.push(openaiAnswer(ids, batchId, line));
      }
      return answers;
    },
  };
}

/** One line of an answers file turned into the shape every caller already reads. */
function openaiAnswer(ids: IdTable, batchId: string, line: unknown): BatchAnswer {
  const parsed = openaiLine.parse(line);
  const id = ids.real(batchId, parsed.custom_id);
  const body = parsed.response?.status_code === 200 ? parsed.response.body : null;
  if (!body)
    return { id, content: "", error: parsed.error?.message ?? "The service could not answer this question." };
  const usage = body.usage;
  return {
    id, content: body.choices[0]!.message.content ?? "",
    ...(usage ? { usage: { input: usage.prompt_tokens, output: usage.completion_tokens } } : {}),
  };
}

/* ---------- Anthropic ---------- */

const anthropicBatch = z.object({
  id: z.string(), processing_status: z.string(), results_url: z.string().nullish(),
});
const anthropicLine = z.object({
  custom_id: z.string(),
  result: z.object({
    type: z.string(),
    message: z.object({
      content: z.array(z.object({ type: z.string(), text: z.string().nullish() })),
      usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).nullish(),
    }).nullish(),
    error: z.object({ error: z.object({ message: z.string().nullish() }).nullish() }).nullish(),
  }),
});

/** One question as Anthropic wants it: the ordinary message request, under a name. */
function anthropicRequests(model: string, wired: { id: string; request: BatchRequest }[]): unknown[] {
  return wired.map((entry) => {
    const system = entry.request.messages.filter((message) => message.role === "system")
      .map((message) => message.content).join("\n\n");
    const rest = entry.request.messages.filter((message) => message.role !== "system").map(plainMessage);
    return {
      custom_id: entry.id,
      params: {
        model, max_tokens: entry.request.maxTokens, ...(system ? { system } : {}),
        messages: rest.length ? rest : [{ role: "user", content: "" }],
      },
    };
  });
}

/**
 * Anthropic's road: the questions go in the request itself, and when the set has ended the service
 * gives an address to read the answers from. That address is checked against the address the owner
 * configured before anything is fetched from it, so a service that answered with somewhere else
 * cannot make this app fetch from somewhere else.
 */
export function anthropicBatchApi(options: ProviderOptions): BatchApi {
  const ids = new IdTable();
  const headers = { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" };
  return {
    async submit(requests, signal) {
      const { table, wired } = ids.wire(requests);
      const created = anthropicBatch.parse(asJson(await callService(options, `${base(options)}/messages/batches`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, signal,
        body: JSON.stringify({ requests: anthropicRequests(options.model, wired) }),
      })));
      ids.remember(created.id, table);
      return { batchId: created.id };
    },
    async poll(batchId, signal) {
      const state = anthropicBatch.parse(asJson(await callService(options,
        `${base(options)}/messages/batches/${encodeURIComponent(batchId)}`, { method: "GET", headers, signal })));
      if (state.processing_status === "ended") return { status: "completed" };
      if (state.processing_status === "in_progress" || state.processing_status === "canceling")
        return { status: "working" };
      return { status: "failed", error: `The service reported the set as "${state.processing_status}".` };
    },
    async collect(batchId, signal) {
      const state = anthropicBatch.parse(asJson(await callService(options,
        `${base(options)}/messages/batches/${encodeURIComponent(batchId)}`, { method: "GET", headers, signal })));
      if (!state.results_url) return [];
      const text = await callService(options, sameHost(options.endpoint, state.results_url),
        { method: "GET", headers, signal });
      return jsonLines(text).map((line) => anthropicAnswer(ids, batchId, line));
    },
  };
}

/** The address the answers are read from must be the service the owner configured, not another. */
export function sameHost(endpoint: string, given: string): string {
  const wanted = new URL(endpoint), url = new URL(given, wanted);
  if (url.host !== wanted.host || url.protocol !== wanted.protocol)
    throw new Error(`The service pointed at ${url.host} for the answers, which is not ${wanted.host}.`);
  return url.toString();
}

/** One line of Anthropic's answers turned into the shape every caller already reads. */
function anthropicAnswer(ids: IdTable, batchId: string, line: unknown): BatchAnswer {
  const parsed = anthropicLine.parse(line);
  const id = ids.real(batchId, parsed.custom_id);
  if (parsed.result.type !== "succeeded" || !parsed.result.message)
    return { id, content: "", error: parsed.result.error?.error?.message
      ?? `The service reported this question as "${parsed.result.type}".` };
  const message = parsed.result.message;
  const content = message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  return {
    id, content,
    ...(message.usage ? { usage: { input: message.usage.input_tokens, output: message.usage.output_tokens } } : {}),
  };
}

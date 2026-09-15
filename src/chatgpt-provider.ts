import { z } from "zod";
import type { Completion, CompletionRequest, Message, Provider, ToolCall, Usage } from "./contracts.js";
import { estimateTokens, ProviderStreamError } from "./contracts.js";
import { rejectedHttpResponse } from "./provider-retry.js";
import { readEventStream } from "./provider-stream.js";
import { restoreToolNames, wireName } from "./providers.js";
import { chatgptAccountId, chatgptDefaults, type ChatGPTAuth } from "./chatgpt-auth.js";

/** Models the ChatGPT subscription route serves; the first is the suggested default. */
export const chatgptModels = [
  { id: "gpt-5.5", label: "GPT-5.5", reasoning: "medium" },
  { id: "gpt-5.6", label: "GPT-5.6", reasoning: "medium" },
  { id: "gpt-5.4", label: "GPT-5.4", reasoning: "medium" },
] as const;

export interface ChatGPTProviderOptions {
  model: string;
  apiBase?: string;
  userAgent?: string;
  fetch?: typeof fetch;
}
/** Responses API over the ChatGPT subscription backend. Requests always stream; Branch identifies itself. */
export class ChatGPTProvider implements Provider {
  readonly name = "chatgpt";
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetch: typeof fetch;
  constructor(private readonly auth: ChatGPTAuth, private readonly options: ChatGPTProviderOptions) {
    this.apiBase = (options.apiBase ?? chatgptDefaults.apiBase).replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "BranchAgent";
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const stream = new ResponsesStream(request.onTextDelta ?? (() => {}));
    try {
      const response = await this.send(request);
      await readEventStream(response, (data) => stream.consume(data));
      return restoreToolNames(stream.result(), request);
    } catch (error) {
      throw stream.failure(error);
    }
  }
  private async send(request: CompletionRequest): Promise<Response> {
    const token = await this.auth.accessToken();
    const accountId = chatgptAccountId(token);
    const response = await this.fetch(`${this.apiBase}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        originator: chatgptDefaults.originator,
        "user-agent": this.userAgent,
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      body: JSON.stringify(responsesBody(request, this.options.model)),
      signal: request.signal,
      redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, request.signal);
    return response;
  }
}

export function responsesBody(request: CompletionRequest, model: string): Record<string, unknown> {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  return {
    model,
    instructions: system,
    input: request.messages.filter((m) => m.role !== "system").flatMap(inputItems),
    store: false,
    stream: true,
    max_output_tokens: request.maxTokens,
    ...(request.tools.length ? {
      tools: request.tools.map((t) => ({
        type: "function", name: wireName(t.name), description: t.description, parameters: t.parameters,
      })),
      tool_choice: "auto",
      parallel_tool_calls: true,
    } : {}),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
  };
}
function inputItems(message: Message): Record<string, unknown>[] {
  if (message.role === "tool")
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  if (message.role === "user")
    return [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
  return [
    ...(message.content ? [{ role: "assistant", content: [{ type: "output_text", text: message.content }] }] : []),
    ...(message.toolCalls ?? []).map((call) => ({
      type: "function_call", call_id: call.id, name: wireName(call.name), arguments: call.arguments,
    })),
  ];
}

const count = z.number().int().nonnegative();
const responsesEvent = z.object({
  type: z.string(),
  delta: z.string().optional(),
  item: z.object({
    type: z.string(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  }).passthrough().optional(),
  response: z.object({
    status: z.string().optional(),
    usage: z.object({ input_tokens: count, output_tokens: count }).optional(),
    error: z.object({ message: z.string().optional() }).nullable().optional(),
    incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

export class ResponsesStream {
  private content = "";
  private readonly calls: ToolCall[] = [];
  private usage: Usage | undefined;
  private completed = false;
  constructor(private readonly emit: (text: string) => void) {}
  consume(data: string): void {
    if (data === "[DONE]") return;
    if (this.completed) throw new Error("Provider sent data after stream completion");
    const event = responsesEvent.parse(JSON.parse(data));
    switch (event.type) {
      case "response.output_text.delta":
        if (event.delta) { this.content += event.delta; this.emit(event.delta); }
        return;
      case "response.output_item.done":
        if (event.item?.type === "function_call")
          this.calls.push({ id: event.item.call_id ?? "", name: event.item.name ?? "", arguments: event.item.arguments ?? "{}" });
        return;
      case "response.completed":
        this.completed = true;
        if (event.response?.usage)
          this.usage = { input: event.response.usage.input_tokens, output: event.response.usage.output_tokens };
        return;
      case "response.failed":
        throw new Error(event.response?.error?.message || "ChatGPT reported a failed response");
      case "response.incomplete":
        throw new Error(`ChatGPT stopped early (${event.response?.incomplete_details?.reason ?? "unknown reason"})`);
      default:
        return;
    }
  }
  result(): Completion {
    if (!this.completed) throw new Error("Provider stream ended without a complete response");
    if (this.calls.some((call) => !call.id || !call.name)) throw new Error("Provider returned an incomplete tool call");
    return { content: this.content, toolCalls: this.calls, ...(this.usage ? { usage: this.usage } : {}) };
  }
  failure(cause: unknown): ProviderStreamError {
    const observed = this.content || this.calls.length;
    return new ProviderStreamError(cause, observed ? estimateTokens({ content: this.content, toolCalls: this.calls }) : 0, this.usage);
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Completion,
  CompletionRequest,
  Message,
  Provider,
  ToolCall,
} from "./contracts.js";
import { DemoProvider } from "./demo.js";

export interface ProviderOptions {
  endpoint: string;
  model: string;
  apiKey: string;
}
const usageNumber = z.number().int().nonnegative();
const openaiResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: usageNumber, completion_tokens: usageNumber })
    .optional(),
});
const anthropicResponse = z.object({
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      }),
    ]),
  ),
  usage: z
    .object({ input_tokens: usageNumber, output_tokens: usageNumber })
    .optional(),
});
const wireName = (name: string): string =>
  "branch_" + createHash("sha256").update(name).digest("hex").slice(0, 24);
function originalName(wire: string, request: CompletionRequest): string {
  const tool = request.tools.find((t) => wireName(t.name) === wire);
  if (!tool) throw new Error("Provider returned an unknown tool");
  return tool.name;
}
function validateOptions(options: ProviderOptions): void {
  const url = new URL(options.endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(
      "Provider endpoint requires HTTPS (HTTP is allowed only on loopback)",
    );
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Provider endpoint must not contain credentials, query, or fragment",
    );
  if (!options.model || !options.apiKey)
    throw new Error("Provider model and API key are required");
}
async function post(
  options: ProviderOptions,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(options.endpoint.replace(/\/$/, "") + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Provider HTTP ${response.status}; check endpoint, model, credential, and quota`,
    );
  }
  if (!response.body) throw new Error("Provider returned empty body");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error("Provider response exceeds 1 MiB");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function openaiMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool")
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls
      ? {
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: wireName(c.name), arguments: c.arguments },
          })),
        }
      : {}),
  };
}
export class OpenAIProvider implements Provider {
  readonly name = "openai-compatible";
  constructor(private readonly options: ProviderOptions) {
    validateOptions(options);
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = {
      model: this.options.model,
      max_tokens: request.maxTokens,
      messages: request.messages.map(openaiMessage),
      ...(request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: {
                name: wireName(t.name),
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
    };
    const response = openaiResponse.parse(
      await post(
        this.options,
        "/chat/completions",
        body,
        { authorization: `Bearer ${this.options.apiKey}` },
        request.signal,
      ),
    );
    const message = response.choices[0]!.message;
    return {
      content: message.content ?? "",
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: originalName(c.function.name, request),
        arguments: c.function.arguments,
      })),
      ...(response.usage
        ? {
            usage: {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens,
            },
          }
        : {}),
    };
  }
}
function anthropicMessages(messages: Message[]): Record<string, unknown>[] {
  const result: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of messages.filter((m) => m.role !== "system")) {
    const role = message.role === "tool" ? "user" : message.role;
    const content: Record<string, unknown>[] =
      message.role === "tool"
        ? [
            {
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: message.content,
            },
          ]
        : [
            ...(message.content
              ? [{ type: "text", text: message.content }]
              : []),
            ...(message.toolCalls ?? []).map((c: ToolCall) => ({
              type: "tool_use",
              id: c.id,
              name: wireName(c.name),
              input: JSON.parse(c.arguments) as unknown,
            })),
          ];
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  constructor(private readonly options: ProviderOptions) {
    validateOptions(options);
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const body = {
      model: this.options.model,
      max_tokens: request.maxTokens,
      system: request.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n"),
      messages: anthropicMessages(request.messages),
      tools: request.tools.map((t) => ({
        name: wireName(t.name),
        description: t.description,
        input_schema: t.parameters,
      })),
    };
    const response = anthropicResponse.parse(
      await post(
        this.options,
        "/messages",
        body,
        { "x-api-key": this.options.apiKey, "anthropic-version": "2023-06-01" },
        request.signal,
      ),
    );
    return {
      content: response.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      toolCalls: response.content
        .filter((c) => c.type === "tool_use")
        .map((c) => ({
          id: c.id,
          name: originalName(c.name, request),
          arguments: JSON.stringify(c.input),
        })),
      ...(response.usage
        ? {
            usage: {
              input: response.usage.input_tokens,
              output: response.usage.output_tokens,
            },
          }
        : {}),
    };
  }
}
export function providerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Provider {
  const kind = env.BRANCH_PROVIDER ?? "demo";
  if (kind === "demo") return new DemoProvider();
  if (kind !== "openai" && kind !== "anthropic")
    throw new Error("BRANCH_PROVIDER must be demo, openai, or anthropic");
  const required = [
    "BRANCH_ENDPOINT",
    "BRANCH_MODEL",
    "BRANCH_API_KEY",
  ] as const;
  for (const key of required)
    if (!env[key]) throw new Error(`${key} is required for a real provider`);
  const options = {
    endpoint: env.BRANCH_ENDPOINT!,
    model: env.BRANCH_MODEL!,
    apiKey: env.BRANCH_API_KEY!,
  };
  return kind === "openai"
    ? new OpenAIProvider(options)
    : new AnthropicProvider(options);
}

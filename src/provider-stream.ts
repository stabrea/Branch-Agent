import { z } from "zod";
import type { Completion, ToolCall, Usage } from "./contracts.js";
import { estimateTokens, ProviderStreamError } from "./contracts.js";

const count = z.number().int().nonnegative();
const index = count.max(15);
const openaiChunk = z.object({
  choices: z.array(z.object({
    index: z.literal(0),
    delta: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index,
        id: z.string().optional(),
        function: z.object({
          name: z.string().optional(), arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }),
    finish_reason: z.string().nullable().optional(),
  })).max(1),
  usage: z.object({ prompt_tokens: count, completion_tokens: count }).nullable().optional(),
});

/** Parse bounded SSE frames, including UTF-8 and CRLF split across reads. */
export async function readEventStream(
  response: Response,
  consume: (data: string) => void,
): Promise<void> {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("Provider did not return an event stream");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const framing = new EventFraming(consume);
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1048576) throw new Error("Provider response exceeds 1 MiB");
      framing.push(decoder.decode(part.value, { stream: true }));
    }
    framing.push(decoder.decode(), true);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class EventFraming {
  private buffer = "";
  private data: string[] = [];
  constructor(private readonly consume: (data: string) => void) {}
  push(text: string, eof = false): void {
    this.buffer += text;
    while (true) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match || (!eof && match[0] === "\r" && match.index === this.buffer.length - 1)) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) {
        if (this.data.length) this.consume(this.data.join("\n"));
        this.data = [];
      } else if (line === "data" || line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}

export class OpenAIStream {
  private content = "";
  private calls = new Map<number, ToolCall>();
  private usage: Usage | undefined;
  private finish = "";
  private done = false;
  constructor(private readonly emit: (text: string) => void) {}
  consume(data: string): void {
    if (this.done) throw new Error("Provider sent data after stream completion");
    if (data === "[DONE]") { this.done = true; return; }
    const chunk = openaiChunk.parse(JSON.parse(data));
    if (chunk.usage) this.usage = {
      input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens,
    };
    for (const choice of chunk.choices) {
      if (this.finish) throw new Error("Provider sent choices after finish");
      const text = choice.delta.content;
      if (text) { this.content += text; this.emit(text); }
      for (const fragment of choice.delta.tool_calls ?? []) {
        const call = this.calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        call.id += fragment.id ?? "";
        call.name += fragment.function?.name ?? "";
        call.arguments += fragment.function?.arguments ?? "";
        this.calls.set(fragment.index, call);
      }
      if (choice.finish_reason) this.finish = choice.finish_reason;
    }
  }
  result(): Completion {
    if (!this.done || !["stop", "tool_calls"].includes(this.finish))
      throw new Error("Provider stream ended without a complete response");
    if (this.calls.size && this.finish !== "tool_calls")
      throw new Error("Provider did not finish its tool calls");
    return {
      content: this.content,
      toolCalls: [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call),
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
  failure(cause: unknown): ProviderStreamError {
    return streamFailure(cause, this.content, [...this.calls.values()], this.usage);
  }
}

const anthropicEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message_start"), message: z.object({
    usage: z.object({ input_tokens: count, output_tokens: count }).optional(),
  }) }),
  z.object({ type: z.literal("content_block_start"), index, content_block: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  ]) }),
  z.object({ type: z.literal("content_block_delta"), index, delta: z.discriminatedUnion("type", [
    z.object({ type: z.literal("text_delta"), text: z.string() }),
    z.object({ type: z.literal("input_json_delta"), partial_json: z.string() }),
  ]) }),
  z.object({ type: z.literal("content_block_stop"), index }),
  z.object({ type: z.literal("message_delta"), delta: z.object({ stop_reason: z.string().nullable().optional() }),
    usage: z.object({ output_tokens: count }).optional() }),
  z.object({ type: z.literal("message_stop") }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error") }),
]);
type AnthropicEvent = z.infer<typeof anthropicEvent>;
type Block = { text: string } | { call: ToolCall; json: string };

export class AnthropicStream {
  private blocks = new Map<number, Block>();
  private open = new Set<number>();
  private usage: Usage | undefined;
  private finalUsage = false;
  private started = false;
  private done = false;
  private finish = "";
  constructor(private readonly emit: (text: string) => void) {}
  consume(data: string): void {
    const event = anthropicEvent.parse(JSON.parse(data));
    if (event.type === "ping") return;
    if (this.done) throw new Error("Provider sent data after stream completion");
    if (event.type === "error") throw new Error("Provider stream failed");
    if (event.type === "message_start") {
      if (this.started) throw new Error("Duplicate provider message start");
      this.started = true;
      if (event.message.usage) this.usage = {
        input: event.message.usage.input_tokens, output: event.message.usage.output_tokens,
      };
    } else {
      if (!this.started) throw new Error("Provider stream missing message start");
      this.advance(event);
    }
  }
  private advance(event: Exclude<AnthropicEvent, { type: "ping" | "error" | "message_start" }>): void {
    if (event.type === "content_block_start") this.startBlock(event);
    if (event.type === "content_block_delta") this.delta(event);
    if (event.type === "content_block_stop" && !this.open.delete(event.index))
      throw new Error("Provider stopped an unknown content block");
    if (event.type === "message_delta") {
      this.finish = event.delta.stop_reason ?? this.finish;
      if (this.usage && event.usage) {
        this.usage.output = event.usage.output_tokens;
        this.finalUsage = true;
      }
    }
    if (event.type === "message_stop") this.done = true;
  }
  private startBlock(event: Extract<AnthropicEvent, { type: "content_block_start" }>): void {
    if (this.finish || this.blocks.has(event.index)) throw new Error("Invalid provider content block start");
    const block = event.content_block;
    this.open.add(event.index);
    if (block.type === "text") {
      if ([...this.blocks.values()].some((value) => "text" in value)) this.emit("\n");
      this.blocks.set(event.index, { text: block.text });
      if (block.text) this.emit(block.text);
    } else this.blocks.set(event.index, {
      call: { id: block.id, name: block.name, arguments: JSON.stringify(block.input) }, json: "",
    });
  }
  private delta(event: Extract<AnthropicEvent, { type: "content_block_delta" }>): void {
    const block = this.blocks.get(event.index);
    if (!block || !this.open.has(event.index) || this.finish)
      throw new Error("Provider delta has no active content block");
    if (event.delta.type === "text_delta" && "text" in block) {
      block.text += event.delta.text;
      this.emit(event.delta.text);
    } else if (event.delta.type === "input_json_delta" && "call" in block) {
      block.json += event.delta.partial_json;
    } else throw new Error("Provider content delta type mismatch");
  }
  result(): Completion {
    if (!this.done || this.open.size || !["end_turn", "tool_use", "stop_sequence"].includes(this.finish))
      throw new Error("Provider stream ended without a complete response");
    const blocks = [...this.blocks].sort(([a], [b]) => a - b).map(([, block]) => block);
    if (blocks.some((block) => "call" in block) && this.finish !== "tool_use")
      throw new Error("Provider did not finish its tool calls");
    return {
      content: blocks.filter((b) => "text" in b).map((b) => b.text).join("\n"),
      toolCalls: blocks.filter((b) => "call" in b).map((b) => ({ ...b.call, arguments: b.json || b.call.arguments })),
      ...(this.usage && this.finalUsage ? { usage: this.usage } : {}),
    };
  }
  failure(cause: unknown): ProviderStreamError {
    const blocks = [...this.blocks.values()];
    return streamFailure(cause,
      blocks.filter((block) => "text" in block).map((block) => block.text).join("\n"),
      blocks.filter((block) => "call" in block).map((block) => ({ ...block.call, arguments: block.json || block.call.arguments })),
      this.usage);
  }
}

function streamFailure(cause: unknown, content: string, toolCalls: ToolCall[], usage?: Usage): ProviderStreamError {
  const estimatedOutput = content || toolCalls.length ? estimateTokens({ content, toolCalls }) : 0;
  return new ProviderStreamError(cause, estimatedOutput, usage);
}

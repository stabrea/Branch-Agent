import { z } from "zod";

export const ToolCallSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    arguments: z.string().max(65536),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
/** Pictures a model can be asked to look at. Kept for one request only and never written down. */
export const maximumImageBytes = 5 * 1024 * 1024;
export const maximumImagesPerTurn = 4;
export const ImagePartSchema = z.object({
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  /** The picture's bytes, base64 encoded; a data: prefix is accepted and stripped. */
  data: z.string().min(1).max(Math.ceil(maximumImageBytes / 3) * 4 + 1024),
  name: z.string().trim().max(200).optional(),
}).strict();
export type ImagePart = z.infer<typeof ImagePartSchema>;
/** Checks the pictures attached to a turn: how many there are, and how big each one really is. */
export function parseImages(input: unknown): ImagePart[] {
  const parts = z.array(ImagePartSchema).max(maximumImagesPerTurn).parse(input);
  return parts.map((part) => {
    const data = part.data.replace(/^data:[^,]*,/, "");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new Error("That picture came through empty");
    if (bytes.length > maximumImageBytes) throw new Error(`Pictures up to ${maximumImageBytes / 1048576} MB can be attached`);
    return { ...part, data };
  });
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** Pictures for this request only; they are never stored with the conversation. */
  images?: ImagePart[];
}
export interface Usage {
  input: number;
  output: number;
}
export const UsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});
export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompletionRequest {
  messages: Message[];
  tools: ToolDescription[];
  signal: AbortSignal;
  maxTokens: number;
  /** Requested reasoning effort; adapters map it to their own parameter or ignore it. */
  reasoning?: "low" | "medium" | "high";
  /** Live provider text only; partial text is not a committed completion. */
  onTextDelta?: (text: string) => void;
}
export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage | undefined;
}
/** Usage observed before a provider stream failed; content remains uncommitted. */
export class ProviderStreamError extends Error {
  override name = "ProviderStreamError";
  constructor(
    cause: unknown,
    readonly estimatedOutput: number,
    readonly usage?: Usage,
  ) {
    super(errorText(cause), { cause });
  }
}
export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
  /** Optional audio endpoints (OpenAI-compatible transcription and speech); null if unavailable. */
  audio?(): { endpoint: string; apiKey: string } | null;
  /** Whether this connection can be shown a picture; absent means it cannot. */
  supportsImages?(): boolean;
  /** The same answer as a plain flag, the form the browser branch's adapters use. */
  readonly acceptsImages?: boolean;
}
export const CompletionSchema = z.object({
  content: z.string().max(65536),
  toolCalls: z.array(ToolCallSchema).max(16),
  usage: UsageSchema.optional(),
});
export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "needs_input"
  | "interrupted";
export interface Run {
  id: string;
  sessionId: string;
  owner: string;
  prompt: string;
  status: RunStatus;
  output: string;
  createdAt: string;
  updatedAt: string;
}
export interface Event {
  id: number;
  runId: string;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface BudgetOptions {
  maxSteps: number;
  maxTokens: number;
}
export class BudgetError extends Error {
  override name = "BudgetError";
}
/** Raised by the user.ask tool: the task stops and waits for the person's answer. */
export class NeedsInputError extends Error {
  override name = "NeedsInputError";
  constructor(readonly question: string) { super(question); }
}
export class Budget {
  steps = 0;
  tokens = 0;
  constructor(
    // The whole prompt (tool catalog included) is charged every round, so a task with several tool
    // calls needs room; the per-run and delegated budgets can still be set lower.
    readonly limits: BudgetOptions = { maxSteps: 60, maxTokens: 200000 },
  ) {
    if (
      !Number.isInteger(limits.maxSteps) ||
      limits.maxSteps < 1 ||
      !Number.isInteger(limits.maxTokens) ||
      limits.maxTokens < 1
    )
      throw new Error("Invalid budget");
  }
  step(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (++this.steps > this.limits.maxSteps)
      throw new BudgetError("Step budget exhausted");
  }
  charge(tokens: number): void {
    this.tokens += tokens;
    if (this.tokens > this.limits.maxTokens)
      throw new BudgetError("Token budget exhausted");
  }
  remaining(): number {
    return Math.max(0, this.limits.maxTokens - this.tokens);
  }
}
export interface ToolContext {
  owner: string;
  workspace: string;
  runId: string;
  signal: AbortSignal;
  budget: Budget;
  permissions: ReadonlySet<string>;
  depth: number;
  /** Set for delegated specialists: memory reads are limited to shared facts and this agent's own. */
  agent?: string;
  /** Practice run: tools that would change something report what they would have done instead. */
  dryRun?: boolean;
  /** Who started this task; anything but the owner is held to the "Ask before changes" policy. */
  source?: "owner" | "trigger" | "schedule" | "mcp";
}
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  inputSchema?: Record<string, unknown>;
  permission: string;
  execute: (args: T, context: ToolContext) => Promise<unknown>;
  /** What this call would touch, for the approval policy, when the arguments alone do not say. */
  target?: (args: T, context: ToolContext) => string | null;
}
export const RunInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(16000),
    sessionId: z.string().uuid().optional(),
    /** Start a conversation that is never searchable and is discarded when closed. */
    temporary: z.boolean().optional(),
    /** Conditions the final answer must meet (phrases, a pattern, a JSON shape, files that must exist). */
    checks: z.record(z.string(), z.unknown()).optional(),
    /** Practice run: nothing is really changed, and the report lists what would have happened. */
    dryRun: z.boolean().optional(),
    /** Pictures to show the model with this message; text-only models say so plainly. */
    images: z.array(ImagePartSchema).max(maximumImagesPerTurn).optional(),
  })
  .strict();
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);

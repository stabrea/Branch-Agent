import { z } from "zod";

export const ToolCallSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    arguments: z.string().max(65536),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
  /** Live provider text only; partial text is not a committed completion. */
  onTextDelta?: (text: string) => void;
}
export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage | undefined;
}
export interface Provider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
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
export class Budget {
  steps = 0;
  tokens = 0;
  constructor(
    readonly limits: BudgetOptions = { maxSteps: 30, maxTokens: 24000 },
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
}
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  inputSchema?: Record<string, unknown>;
  permission: string;
  execute: (args: T, context: ToolContext) => Promise<unknown>;
}
export const RunInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(16000),
    sessionId: z.string().uuid().optional(),
  })
  .strict();
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);

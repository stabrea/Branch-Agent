import { z } from "zod";
import type { SandboxChoice, WallContext } from "./sandbox.js";
import type { SandboxBackendName } from "./sandbox-backends.js";

export const ToolCallSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    arguments: z.string().max(65536),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
/** A picture shown to the model, such as a screenshot of a web page. Base64, under the size cap. */
export interface MessageImage {
  mediaType: string;
  /** A short label such as the file name, when there is one. */
  name?: string | undefined;
  /** Base64 bytes; never written to the conversation store, so it is not replayed later. */
  data: string;
}
/** The most a single picture may weigh once encoded, so one screenshot cannot fill a request. */
export const maxImageBytes = 4 * 1024 * 1024;
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
  /** Pictures that travel with this message; only user messages carry them. */
  images?: MessageImage[];
}
export interface Usage {
  input: number;
  output: number;
  /** Input tokens the provider served from its own prompt cache, when it reports them. */
  cachedInput?: number | undefined;
}
export const UsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative().optional(),
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
  /** R17-S12: a faster or cheaper service tier, where the service offers one; absent asks for the usual. */
  serviceTier?: "priority" | "flex";
  /** R17-046: OpenRouter's company preferences; only a connection whose address is openrouter.ai sends them. */
  providerRouting?: import("./model-savings/openrouter.js").OpenRouterRouting;
  /** Live provider text only; partial text is not a committed completion. */
  onTextDelta?: (text: string) => void;
  /**
   * mac7/empty-completion: live *thinking* from a reasoning model, which arrives in a field of its
   * own (`reasoning_content`, `reasoning`, `thinking`) rather than in the answer. It is not the
   * answer and never reaches the page, but a model that is visibly thinking is a model that is
   * working, so whatever watches for silence needs to hear it.
   */
  onReasoningDelta?: (text: string) => void;
  /**
   * The exact shape the reply must take. An adapter with a setting of its own for this uses it;
   * one without simply ignores the field, and whatever asked falls back to saying so in the words
   * of the question and checking the reply afterwards. See src/answer-shape.ts.
   */
  responseFormat?: { name: string; schema: Record<string, unknown> };
}
export interface Completion {
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage | undefined;
  /**
   * mac7/empty-completion: how many characters of thinking the model produced that are not part of
   * the answer. Kept so a round that thought and said nothing can be told apart from one that was
   * never answered at all; the thinking itself is not kept.
   */
  reasoningChars?: number | undefined;
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
  /** True when this model can be shown a picture; otherwise the text snapshot is used instead. */
  readonly acceptsImages?: boolean;
  complete(request: CompletionRequest): Promise<Completion>;
  /** Optional audio endpoints (OpenAI-compatible transcription and speech); null if unavailable. */
  audio?(): { endpoint: string; apiKey: string } | null;
  /** Whether this connection can be shown a picture; absent means it cannot. */
  supportsImages?(): boolean;
  /**
   * Where this connection lists its models, when it offers a list. Adapters whose address does not
   * follow the OpenAI pattern say so here rather than having it guessed from their other routes.
   */
  modelsList?(): { url: string; headers: Record<string, string> } | null;
  /**
   * Sending many questions at once and collecting the answers later, where the service offers it
   * (OpenAI and Anthropic both do, at about half price). A connection that does not offer it simply
   * leaves this out, and whatever asked falls back to one ordinary call per question. See
   * src/batch-inference.ts.
   */
  batch?(): BatchApi | null;
}
/** What a service that takes many questions at once must be able to do. */
export interface BatchApi {
  /** Hands the whole set over and gives back the service's own id for it. */
  submit(requests: BatchRequest[], signal: AbortSignal): Promise<{ batchId: string }>;
  /** Where the set has got to; `completed` means the answers can be collected. */
  poll(batchId: string, signal: AbortSignal): Promise<{ status: "working" | "completed" | "failed"; error?: string }>;
  /** The answers, each carrying back the id it was sent with. */
  collect(batchId: string, signal: AbortSignal): Promise<BatchAnswer[]>;
}
export interface BatchRequest {
  /** The caller's own id for this question, handed straight back with the answer. */
  id: string;
  messages: Message[];
  maxTokens: number;
}
export interface BatchAnswer {
  id: string;
  content: string;
  usage?: Usage;
  error?: string;
}
export const CompletionSchema = z.object({
  content: z.string().max(65536),
  toolCalls: z.array(ToolCallSchema).max(16),
  usage: UsageSchema.optional(),
  reasoningChars: z.number().int().nonnegative().optional(),
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
  /** The project this task was done under, so what it cost can be counted against that project. */
  project?: string;
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
  /** The tool call that asked, when a tool asked; a question from anywhere else (a stuck model, a plan to approve) has none. */
  callId?: string;
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
  /** The task whose shared scratch area this run and all of its sub-tasks read and write. */
  scratchRoot?: string;
  /** Practice run: tools that would change something report what they would have done instead. */
  dryRun?: boolean;
  /**
   * mac7/eval-honesty: a question asked in isolation — a grader marking work Branch itself did.
   * Nothing the owner has remembered, written down, installed or asked for standing reaches it, and
   * nothing it does is learned from. See `RunOptions.isolated`.
   */
  isolated?: boolean;
  /** Who started this task; anything but the owner is held to the "Ask before changes" policy. */
  source?: "owner" | "trigger" | "schedule" | "mcp" | "a2a" | "acp" | "channel";
  /**
   * Where answers already given are remembered when there is no conversation to remember them
   * against: a saved workflow uses its own name here, so a yes given to one of its steps still
   * counts when that step is tried again.
   */
  approvalKey?: string;
  /**
   * mac7/coding-next: set on a model's own tool call in a task, where a tool may stop to ask the
   * person (ApprovalRequiredError) and the question is put in the conversation. A tool run by hand
   * has nowhere to put one, so a tool that would ask answers there as it did before.
   */
  askable?: boolean;
  /**
   * mac7/tests-unattended: nobody can answer a question while this task runs — a script's
   * `branch run` or `branch headless` with no terminal to ask in. Only the "Let Branch run this
   * project's tests?" question reads it: the tests are skipped and the task carries on, instead of
   * the task ending on a question nobody will see. Every other question still stops the task.
   */
  unattended?: boolean;
  /**
   * mac7/tests-unattended: `branch run --allow-tests`. The project's tests may run in this one task,
   * as if the owner had answered Once each time; nothing is saved. Honoured only for the owner's own
   * task (src/coding/project-tests.ts), and never under Lockdown.
   */
  allowProjectTests?: boolean;
  /**
   * How tightly a program this call starts is to be held, when an approval rule said so. It is set
   * by the runtime just before the tool runs; a tool no rule says anything about never sees it and
   * behaves exactly as it did before rules could say.
   */
  sandbox?: SandboxChoice;
  /**
   * Where a program this call starts is to run, when an approval rule named somewhere other than
   * this computer, and which folders of the workspace it may see there. Both are set by the
   * runtime just before the tool runs, exactly as `sandbox` is.
   */
  sandboxBackend?: SandboxBackendName;
  sandboxPaths?: readonly string[];
  /**
   * Wave mac3 (os-sandbox): the wall a program this call starts goes behind (macOS's own sandbox or
   * bubblewrap), set by the runtime from the owner's settings. Never set from a tool's arguments.
   */
  osSandbox?: WallContext;
  /**
   * mac7/lockdown-fix: set on a Trunk's turn (and carried into its sub-tasks and side jobs): the keys
   * it may use. A sign-in account never answers for it (src/accounts/trunk-guard.ts).
   */
  trunkKeys?: { copyFromOwner: boolean; accounts: Record<string, string> };
}
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<T>;
  inputSchema?: Record<string, unknown>;
  /** The toolbox this tool belongs to; worked out from its name when it does not say. */
  group?: string;
  /** From a connected server, a plugin or a skill package: its description is somebody else's text. */
  external?: boolean;
  permission: string;
  execute: (args: T, context: ToolContext) => Promise<unknown>;
  /** What this call would touch, for the approval policy, when the arguments alone do not say. */
  target?: (args: T, context: ToolContext) => string | null;
  /**
   * mac7/residuals: the command line a tool that starts a program really runs (`process.start`: the
   * program the owner listed under a short name, its listed arguments, then the call's), so command
   * rules judge it like a shell command. Null when it cannot say; the target is judged as before.
   */
  command?: (args: T) => string | null;
  /**
   * mac7/multi-target: every file, folder or address a call touches, when it touches more than one
   * (a patch, two documents compared, a list of sources) or when its one path is not where the rules
   * look (a repository `folder`). Each is judged by the rules on its own and the call goes ahead only
   * when every one is allowed. Throws when they cannot be worked out, and the call is then refused.
   */
  targets?: (args: T, context: ToolContext) => ToolTarget[];
}
/** mac7/multi-target: one thing a call touches, and whether it only reads it, changes it or deletes it. */
export interface ToolTarget {
  kind: "read" | "write" | "delete";
  /** A workspace path, as the tool will use it. */
  path?: string;
  /** A web address. */
  url?: string;
  /**
   * Integration (multi-target): the call reaches everything inside this folder (a repository's whole
   * working copy, a folder a knowledge base reads), so a rule about a folder inside it counts too.
   */
  folder?: boolean;
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
    /** Ask for a short plan first and work through it step by step. */
    plan: z.boolean().optional(),
    /** Have a reviewer check the finished answer before it is given. */
    verify: z.boolean().optional(),
    /** Redesign phase 1: how much it may do in a conversation this message starts (src/conversation-mode.ts). */
    mode: z.enum(["ask", "plan", "auto", "full"]).optional(),
  })
  .strict();
/** The same message without its pictures, for storing and for measuring how full the context is. */
export function textOnly(message: Message): Message {
  if (!message.images?.length) return message;
  const { images: _images, ...rest } = message;
  return rest;
}
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / 4);

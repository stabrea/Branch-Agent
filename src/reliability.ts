import { access } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { Message } from "./contracts.js";
import { checkResult, ResultSchemaSchema } from "./delegation.js";

/**
 * Reliability helpers for ordinary runs: declared completion checks with bounded retries, a stall
 * watchdog for model calls, and the trimming that keeps a long-running task inside the context limit.
 */
export const CompletionCheckSchema = z.object({
  /** Words or phrases the final answer must contain (case-insensitive). */
  mustMention: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  /** A regular expression the final answer must match. */
  mustMatch: z.string().min(1).max(300).optional(),
  /** The answer must be JSON matching this schema. */
  resultSchema: ResultSchemaSchema.optional(),
  /** Workspace files that must exist when the task claims to be done. */
  files: z.array(z.string().min(1).max(500)).max(20).optional(),
  /** How many more attempts the model gets after a failed check (0 to 2). */
  maxRetries: z.number().int().min(0).max(2).default(1),
}).strict();
export type CompletionCheck = z.infer<typeof CompletionCheckSchema>;

export class CheckError extends Error {
  override name = "CheckError";
}
export class StallError extends Error {
  override name = "StallError";
  constructor(readonly afterMs: number) { super(`No response for ${Math.round(afterMs / 1000)} seconds`); }
}

/** The first reason the answer fails its declared checks, or null when every check passes. */
export async function evaluateChecks(output: string, check: CompletionCheck, workspace: string): Promise<string | null> {
  const lower = output.toLowerCase();
  for (const phrase of check.mustMention ?? [])
    if (!lower.includes(phrase.toLowerCase())) return `The answer does not mention "${phrase}"`;
  if (check.mustMatch) {
    let pattern: RegExp;
    try { pattern = new RegExp(check.mustMatch, "i"); } catch { return "The check's pattern is not a valid regular expression"; }
    if (!pattern.test(output)) return "The answer does not match the expected pattern";
  }
  if (check.resultSchema) {
    const result = checkResult(output, check.resultSchema);
    if (result.status === "unresolved") return result.reason;
  }
  for (const file of check.files ?? []) {
    const path = resolve(workspace, file), rel = relative(workspace, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return `The file ${file} is outside the workspace`;
    try { await access(path); } catch { return `The file ${file} does not exist yet`; }
  }
  return null;
}

/**
 * Runs `work` with a signal that aborts when nothing has been heard for `stallMs`; `touch` resets
 * the clock and is meant to be called on every streamed piece of output.
 */
export async function withStallWatchdog<T>(
  parent: AbortSignal,
  stallMs: number,
  work: (signal: AbortSignal, touch: () => void) => Promise<T>,
): Promise<T> {
  const watchdog = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => watchdog.abort(new StallError(stallMs)), stallMs);
  };
  arm();
  try {
    return await work(AbortSignal.any([parent, watchdog.signal]), arm);
  } catch (error) {
    if (watchdog.signal.aborted && !parent.aborted) throw watchdog.signal.reason;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Shortens a serialised tool result that would crowd out the conversation; the full result stays in the trace. */
export function clipToolResult(serialised: string, limit: number): { text: string; omitted: number } {
  if (serialised.length <= limit) return { text: serialised, omitted: 0 };
  const head = Math.floor(limit * 0.7), tail = Math.floor(limit * 0.2);
  const omitted = serialised.length - head - tail;
  return { text: `${serialised.slice(0, head)}\n[... ${omitted} characters omitted; the full result is in this task's activity trace ...]\n${serialised.slice(-tail)}`, omitted };
}

/**
 * Replaces the content of older tool results with a short note so the model keeps its own
 * reasoning and the recent exchange. Returns how many results were shrunk.
 */
export function shrinkToolResults(messages: Message[], keepRecent: number): number {
  let shrunk = 0;
  const cutoff = Math.max(0, messages.length - keepRecent);
  for (let i = 0; i < cutoff; i++) {
    const message = messages[i]!;
    if (message.role !== "tool" || message.content.length <= 200) continue;
    message.content = JSON.stringify({ ok: true, note: `Earlier result of ${message.content.length} characters removed to make room; ask again if you need it.` });
    shrunk++;
  }
  return shrunk;
}

export const ReliabilityOptionsSchema = z.object({
  /** Abort a model call that stays silent this long (5 s to 10 min). */
  modelStallMs: z.number().int().min(5000).max(600000).default(60000),
  /** What to do after a stalled model call. */
  stallRecovery: z.enum(["retry", "fallback", "fail"]).default("retry"),
  /** Stop a single tool call after this long (5 s to 10 min). */
  toolTimeoutMs: z.number().int().min(5000).max(600000).default(90000),
  /** Tool results longer than this are clipped before the model sees them. */
  toolResultChars: z.number().int().min(1000).max(60000).default(12000),
  /** How long the per-conversation pace window is; normally a minute. */
  rateWindowMs: z.number().int().min(100).max(600000).default(60000),
}).strict();
export type ReliabilityOptions = z.infer<typeof ReliabilityOptionsSchema>;
export type ReliabilityInput = z.input<typeof ReliabilityOptionsSchema>;

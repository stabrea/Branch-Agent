import { z } from "zod";
import type { BatchAnswer, BatchRequest, Message, Provider, Usage } from "./contracts.js";
import type { Store } from "./store.js";
import type { ModelPreset } from "./models.js";
import { estimateCost, formatCost, pricingSettings } from "./pricing.js";

/**
 * Asking a lot of questions at once. Evaluation sets and reading a knowledge base both ask the same
 * model the same kind of thing dozens of times over; OpenAI and Anthropic will both take the whole
 * set at once, work through it in their own time and charge about half. This offers that where the
 * connection supports it, and does the ordinary thing where it does not.
 *
 * It is off until the owner asks for it, because a set handed over this way does not come back in
 * seconds. What it cost is read from what the service reported for the set, never guessed, and the
 * answers land in exactly the same shape one-at-a-time calls produce, so nothing above cares which
 * way the questions went.
 */
export const BatchSettingsSchema = z.object({
  /** Off by default: batch answers arrive later, which is not what most tasks want. */
  enabled: z.boolean().default(false),
  /** How long to keep asking whether the set is done before giving up. */
  maxWaitMs: z.number().int().min(1000).max(86_400_000).default(600_000),
  /** How long to wait between asking. */
  pollMs: z.number().int().min(10).max(600_000).default(5_000),
}).strict();
export type BatchSettings = z.infer<typeof BatchSettingsSchema>;
const settingsKey = "batch-inference";

export function batchSettings(store: Store, owner: string): BatchSettings {
  const saved = BatchSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : BatchSettingsSchema.parse({});
}
export function saveBatchSettings(store: Store, owner: string, input: unknown): BatchSettings {
  const next = BatchSettingsSchema.parse({ ...batchSettings(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, next);
  return next;
}

/** One question in a set, before it is handed over. */
export interface BatchQuestion { id: string; messages: Message[]; maxTokens?: number }
/** How a whole set came back. */
export interface BatchOutcome {
  /** "batch" when the service took the set; "direct" when it could not and each was asked normally. */
  route: "batch" | "direct";
  /** Why it fell back, in one line, when it did. */
  reason: string | null;
  batchId: string | null;
  answers: BatchAnswer[];
  usage: Usage;
  /** What the set cost, from what the service reported. Null when no price is on file. */
  cost: { amount: number | null; display: string };
}

const defaultMaxTokens = 2048;
/** Whether this connection can take a whole set at once. */
export function supportsBatch(provider: Provider): boolean {
  try { return Boolean(provider.batch?.()); } catch { return false; }
}

/**
 * Hands the set over, waits for it, and collects the answers. Anything that goes wrong on the batch
 * road — no support, a refused hand-over, a set that failed or never finished — falls back to one
 * ordinary call per question rather than losing the work, and says so in `reason`.
 */
export async function runBatch(
  store: Store, owner: string, preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<BatchOutcome> {
  const settings = batchSettings(store, owner);
  const api = settings.enabled ? (() => { try { return preset.provider.batch?.() ?? null; } catch { return null; } })() : null;
  if (!api)
    return direct(store, owner, preset, questions, signal,
      settings.enabled ? "This connection does not take a whole set at once." : "Batch mode is switched off.");
  try {
    const requests: BatchRequest[] = questions.map((question) => ({
      id: question.id, messages: question.messages, maxTokens: question.maxTokens ?? defaultMaxTokens,
    }));
    const { batchId } = await api.submit(requests, signal);
    const finished = await waitFor(api, batchId, settings, signal, options.sleep ?? sleep);
    if (finished.status !== "completed")
      return direct(store, owner, preset, questions, signal, finished.error ?? "The set did not finish.");
    const answers = await api.collect(batchId, signal);
    return settle(store, owner, preset, "batch", batchId, answers, null);
  } catch (error) {
    return direct(store, owner, preset, questions, signal,
      error instanceof Error ? error.message : String(error));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** Asks how the set is getting on until it is done, it fails, or the owner's patience runs out. */
async function waitFor(
  api: NonNullable<ReturnType<NonNullable<Provider["batch"]>>>, batchId: string,
  settings: BatchSettings, signal: AbortSignal, pause: (ms: number) => Promise<void>,
): Promise<{ status: "working" | "completed" | "failed"; error?: string }> {
  const until = Date.now() + settings.maxWaitMs;
  for (;;) {
    signal.throwIfAborted();
    const state = await api.poll(batchId, signal);
    if (state.status !== "working") return state;
    if (Date.now() >= until) return { status: "failed", error: "The set was still working when the wait ran out." };
    await pause(settings.pollMs);
  }
}

/** One ordinary call per question. The answers come back in the same shape either way. */
async function direct(
  store: Store, owner: string, preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal, reason: string,
): Promise<BatchOutcome> {
  const answers: BatchAnswer[] = [];
  for (const question of questions) {
    try {
      const completion = await preset.provider.complete({
        messages: question.messages, tools: [], maxTokens: question.maxTokens ?? defaultMaxTokens, signal,
      });
      answers.push({ id: question.id, content: completion.content, ...(completion.usage ? { usage: completion.usage } : {}) });
    } catch (error) {
      answers.push({ id: question.id, content: "", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return settle(store, owner, preset, "direct", null, answers, reason);
}

/** Adds up what came back and prices it from what the service actually reported. */
function settle(
  store: Store, owner: string, preset: ModelPreset, route: "batch" | "direct",
  batchId: string | null, answers: BatchAnswer[], reason: string | null,
): BatchOutcome {
  const usage: Usage = { input: 0, output: 0 };
  for (const answer of answers) {
    usage.input += answer.usage?.input ?? 0;
    usage.output += answer.usage?.output ?? 0;
  }
  const { overrides } = pricingSettings(store, owner);
  const estimate = estimateCost(preset.model, usage, overrides);
  return { route, reason, batchId, answers, usage, cost: { amount: estimate.amount, display: formatCost(estimate) } };
}

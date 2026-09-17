import { z } from "zod";
import type { BatchAnswer, BatchRequest, Message, Provider, Usage } from "./contracts.js";
import type { Store } from "./store.js";
import type { ModelPreset } from "./models.js";
import { estimateCost, formatCost, pricingSettings } from "./pricing.js";
import { FeatureModeSchema, optionalFields, type FeatureMode } from "./feature-switches.js";

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
  /**
   * w911: the three-way switch. "when-needed" hands over only a set big enough to be worth the wait
   * (`minQuestions` or more); a smaller one is asked the ordinary way. "on" hands over every set. A
   * save from before this switch had only `enabled`, and a yes there handed over every set, so it
   * reads as "on".
   */
  mode: FeatureModeSchema.optional(),
  /** Under "when-needed", the smallest set that is handed over rather than asked one at a time. */
  minQuestions: z.number().int().min(2).max(10_000).default(10),
  /** How long to keep asking whether the set is done before giving up. */
  maxWaitMs: z.number().int().min(1000).max(86_400_000).default(600_000),
  /** How long to wait between asking. */
  pollMs: z.number().int().min(10).max(600_000).default(5_000),
  /**
   * How much less a set costs than the same questions one at a time. Both services charge half at
   * the time of writing, so 0.5; the price tables price a model at its ordinary rate, so this is
   * what turns that into what a set actually cost and what handing it over saved.
   */
  discount: z.number().min(0).max(0.9).default(0.5),
}).strict();
export type BatchSettings = z.infer<typeof BatchSettingsSchema>;
const settingsKey = "batch-inference";

export function batchSettings(store: Store, owner: string): BatchSettings {
  const saved = BatchSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : BatchSettingsSchema.parse({});
}
export function saveBatchSettings(store: Store, owner: string, input: unknown): BatchSettings {
  const current = batchSettings(store, owner);
  const given = optionalFields(BatchSettingsSchema).parse(input ?? {});
  const merged = BatchSettingsSchema.parse({ ...current, ...given });
  // A bare yes turns it back on as it was, or fully on: that is what a yes meant before the three-way switch.
  const was = batchMode(current);
  const mode = given.mode ?? (given.enabled === false ? "off" : given.enabled === true ? (was === "off" ? "on" : was) : was);
  const next = { ...merged, mode, enabled: mode !== "off" };
  store.save("settings", owner, settingsKey, next);
  return next;
}
/** The mode a saved record stands for; an older yes handed over every set, so it is "on". */
export function batchMode(settings: Pick<BatchSettings, "enabled" | "mode">): FeatureMode {
  return settings.mode ?? (settings.enabled ? "on" : "off");
}
/** Why a set of this size is asked the ordinary way under these settings, or null when it may be handed over. */
export function batchRefusal(settings: BatchSettings, size: number): string | null {
  const mode = batchMode(settings);
  if (mode === "off") return "Batch mode is switched off.";
  if (mode === "when-needed" && size < settings.minQuestions)
    return `Only ${size} question(s), fewer than the ${settings.minQuestions} worth waiting for, so they were asked one at a time.`;
  return null;
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
  /** What handing the set over saved against asking the same questions one at a time. */
  saved: { amount: number | null; display: string };
  /** The questions the set answered, and the ones that had to be asked again one at a time. */
  counts: { batched: number; askedAgain: number; unanswered: number };
  /** The ids that had to be asked again after the set only half worked. */
  askedAgain: string[];
  /** The ids nothing could answer, so the caller can say so rather than quietly dropping them. */
  unanswered: string[];
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
 *
 * A set that only half worked is the case worth care. Whatever came back is collected first, even
 * when the service called the set failed, and only the questions with no answer are asked again one
 * at a time. The ones already answered are neither lost nor paid for twice, and the outcome names
 * which had to be asked again and which nothing could answer at all.
 */
export async function runBatch(
  store: Store, owner: string, preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal,
  options: { sleep?: (ms: number) => Promise<void>; runId?: string } = {},
): Promise<BatchOutcome> {
  const settings = batchSettings(store, owner);
  const refused = batchRefusal(settings, questions.length);
  const api = refused ? null : (() => { try { return preset.provider.batch?.() ?? null; } catch { return null; } })();
  if (!api)
    return direct(store, owner, preset, questions, signal, options,
      refused ?? "This connection does not take a whole set at once.");
  // A set carries words only. A question with a picture in it would arrive at the service without
  // the picture, which is a different question, so the whole set goes the ordinary way instead.
  if (questions.some((question) => question.messages.some((message) => (message.images?.length ?? 0) > 0)))
    return direct(store, owner, preset, questions, signal, options,
      "One of these questions carries a picture, which a whole set cannot, so they were asked one at a time.");
  let batchId: string | null = null;
  try {
    const requests: BatchRequest[] = questions.map((question) => ({
      id: question.id, messages: question.messages, maxTokens: question.maxTokens ?? defaultMaxTokens,
    }));
    ({ batchId } = await api.submit(requests, signal));
    const finished = await waitFor(api, batchId, settings, signal, options.sleep ?? sleep);
    const collected = await harvest(api, batchId, signal);
    if (finished.status === "completed" && collected.answers.length && !collected.error)
      return await fillGaps(store, owner, preset, questions, signal, options, batchId, collected.answers, null);
    const reason = finished.error ?? collected.error ?? "The set did not finish.";
    if (!collected.answers.length)
      return direct(store, owner, preset, questions, signal, options, reason, batchId);
    return await fillGaps(store, owner, preset, questions, signal, options, batchId, collected.answers, reason);
  } catch (error) {
    // Being stopped is not a reason to fall back: asking every question again one at a time would
    // ignore the very thing that was asked for.
    if (signal.aborted) throw error;
    return direct(store, owner, preset, questions, signal, options,
      error instanceof Error ? error.message : String(error), batchId);
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

/**
 * Whatever the set managed, asked for even when the service called the set failed. Collecting is
 * allowed to fail in turn; an empty harvest simply means everything has to be asked again.
 */
async function harvest(
  api: NonNullable<ReturnType<NonNullable<Provider["batch"]>>>, batchId: string, signal: AbortSignal,
): Promise<{ answers: BatchAnswer[]; error: string | null }> {
  try {
    const answers = await api.collect(batchId, signal);
    return { answers: answers.filter((answer) => !answer.error && answer.content !== undefined), error: null };
  } catch (error) {
    return { answers: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The questions the set did not answer, asked one at a time, and the whole lot put back into the
 * order they were asked in. Nothing already answered is asked again.
 */
async function fillGaps(
  store: Store, owner: string, preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal,
  options: { runId?: string }, batchId: string, fromBatch: BatchAnswer[], reason: string | null,
): Promise<BatchOutcome> {
  const have = new Map(fromBatch.map((answer) => [answer.id, answer]));
  const missing = questions.filter((question) => !have.has(question.id));
  const again = missing.length ? await askEach(preset, missing, signal) : [];
  for (const answer of again) have.set(answer.id, answer);
  const ordered = questions.map((question) =>
    have.get(question.id) ?? { id: question.id, content: "", error: "Nothing answered this question." });
  const note = missing.length
    ? `${reason ? `${reason} ` : "The set did not answer every question. "}`
      + `${missing.length} of ${questions.length} question(s) were asked again one at a time; the rest were kept.`
    : reason;
  return settle(store, owner, preset, "batch", batchId, ordered, note, options,
    { batched: fromBatch.length, askedAgain: missing.map((question) => question.id) });
}

/** One ordinary call per question. The answers come back in the same shape either way. */
async function askEach(preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal): Promise<BatchAnswer[]> {
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
  return answers;
}

/** Every question asked the ordinary way, because the set road was not open or gave nothing back. */
async function direct(
  store: Store, owner: string, preset: ModelPreset, questions: BatchQuestion[], signal: AbortSignal,
  options: { runId?: string }, reason: string, batchId: string | null = null,
): Promise<BatchOutcome> {
  const answers = await askEach(preset, questions, signal);
  return settle(store, owner, preset, "direct", batchId, answers, reason, options,
    { batched: 0, askedAgain: [] });
}

/**
 * Adds up what came back, prices it from what the service reported, and writes the saving down
 * where the Usage screen can find it. A set is charged at a fraction of the ordinary rate, so the
 * ordinary price of the questions the set answered is what handing them over would otherwise have
 * cost; the difference is the saving, and it is written as an event against the run rather than
 * only returned, so it is still there tomorrow.
 */
function settle(
  store: Store, owner: string, preset: ModelPreset, route: "batch" | "direct",
  batchId: string | null, answers: BatchAnswer[], reason: string | null,
  options: { runId?: string }, counts: { batched: number; askedAgain: string[] },
): BatchOutcome {
  const settings = batchSettings(store, owner);
  const usage: Usage = { input: 0, output: 0 }, batched: Usage = { input: 0, output: 0 };
  const done = new Set(answers.filter((answer) => !answer.error).map((answer) => answer.id));
  const askedAgain = new Set(counts.askedAgain);
  for (const answer of answers) {
    usage.input += answer.usage?.input ?? 0;
    usage.output += answer.usage?.output ?? 0;
    if (route !== "batch" || askedAgain.has(answer.id) || answer.error) continue;
    batched.input += answer.usage?.input ?? 0;
    batched.output += answer.usage?.output ?? 0;
  }
  const { overrides } = pricingSettings(store, owner);
  const ordinary = estimateCost(preset.model, usage, overrides);
  const batchedAtFullRate = estimateCost(preset.model, batched, overrides);
  const savedAmount = batchedAtFullRate.amount === null ? null : batchedAtFullRate.amount * settings.discount;
  const amount = ordinary.amount === null || savedAmount === null ? ordinary.amount : ordinary.amount - savedAmount;
  const unanswered = answers.filter((answer) => answer.error).map((answer) => answer.id);
  const outcome: BatchOutcome = {
    route, reason, batchId, answers, usage,
    cost: { amount, display: formatCost({ ...ordinary, amount }) },
    saved: { amount: savedAmount, display: formatCost({ ...batchedAtFullRate, amount: savedAmount }) },
    counts: { batched: counts.batched, askedAgain: counts.askedAgain.length, unanswered: unanswered.length },
    askedAgain: counts.askedAgain, unanswered,
  };
  record(store, preset, outcome, done.size, options.runId);
  return outcome;
}

/**
 * The one line the Usage screen reads. Written for every set, batched or not, so the screen can say
 * both what handing sets over saved and how often a connection could not take one.
 */
function record(
  store: Store, preset: ModelPreset, outcome: BatchOutcome, answered: number, runId: string | undefined,
): void {
  if (!runId) return;
  try {
    store.event(runId, "batch.completed", {
      route: outcome.route, provider: preset.provider.name, model: preset.model, preset: preset.id,
      batchId: outcome.batchId, questions: outcome.answers.length, answered,
      batched: outcome.counts.batched, askedAgain: outcome.counts.askedAgain,
      unanswered: outcome.counts.unanswered,
      input: outcome.usage.input, output: outcome.usage.output,
      cost: outcome.cost.amount, saved: outcome.saved.amount,
      reason: outcome.reason,
    });
  } catch { /* A set asked outside any run still gives its answers back; only the figure is lost. */ }
}

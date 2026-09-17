import { z } from "zod";
import type { Event } from "./contracts.js";
import type { Store } from "./store.js";
import type { ProviderHealth } from "./provider-health.js";
import { estimateCost, pricingTableInUse } from "./pricing.js";

/**
 * The three dashboard pieces the audit still wanted, which are all readings of things the app
 * already writes down rather than new record-keeping:
 *
 * - **The record.** Every step every task took, narrowed down by the kind of step, by the task or
 *   by when it happened, and saved as a file of one line each — the shape a log file has, so it
 *   opens in anything.
 * - **How busy a connection is.** How many calls went to each model service in the last minute,
 *   beside the allowance that service reports in its own answers.
 * - **What asking twice saved.** Every round answered from the kept-answers store, with what it
 *   would have cost had it gone out.
 */

/** What the record can be narrowed down by. Everything is optional; nothing is required. */
export const LogFilterSchema = z.object({
  kind: z.string().trim().max(60).optional(),
  runId: z.string().uuid().optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(2000).default(200),
}).strict();
export type LogFilter = z.infer<typeof LogFilterSchema>;
export interface LogLine { at: string; kind: string; runId: string; detail: Record<string, unknown> }

/** Anything too big to read at a glance, or that should never be copied out, is left behind. */
const heavy = new Set(["html", "image", "images", "bytes", "source", "snapshot"]);
function detailOf(event: Event): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (heavy.has(key)) continue;
    out[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return out;
}

/** The record, newest first, narrowed down by whatever the owner asked for. */
export function readLog(store: Store, owner: string, input: unknown): { lines: LogLine[]; kinds: string[] } {
  const filter = LogFilterSchema.parse(input ?? {});
  const runs = store.runs(owner);
  const wanted = filter.runId ? runs.filter((run) => run.id === filter.runId) : runs;
  const lines: LogLine[] = [];
  const kinds = new Set<string>();
  for (const run of wanted.slice(0, 200)) {
    for (const event of store.events(run.id)) {
      kinds.add(event.kind);
      if (filter.kind && event.kind !== filter.kind) continue;
      if (filter.since && event.createdAt < filter.since) continue;
      if (filter.until && event.createdAt > filter.until) continue;
      lines.push({ at: event.createdAt, kind: event.kind, runId: run.id, detail: detailOf(event) });
    }
    if (lines.length > filter.limit * 4) break;
  }
  lines.sort((a, b) => b.at.localeCompare(a.at));
  return { lines: lines.slice(0, filter.limit), kinds: [...kinds].sort() };
}

/** The same record as a file of one line each — the shape a log file has, so anything can read it. */
export function logJsonl(lines: LogLine[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : "");
}

/**
 * How many calls went to each model service, minute by minute. The counter lives in memory: this
 * is "how busy is it right now", not a figure to bill against, and the usage ledger already keeps
 * the lasting record.
 */
export interface RequestRate { connection: string; lastMinute: number; lastHour: number }
export class RequestCounter {
  private readonly calls = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now, private readonly keepMs = 3_600_000) {}
  record(connection: string): void {
    const at = this.now();
    const kept = (this.calls.get(connection) ?? []).filter((when) => at - when <= this.keepMs);
    kept.push(at);
    /* A busy hour is thousands of calls; past that the oldest go, because the shape is the point. */
    this.calls.set(connection, kept.slice(-5000));
    while (this.calls.size > 64) this.calls.delete(this.calls.keys().next().value!);
  }
  rates(): RequestRate[] {
    const at = this.now();
    return [...this.calls.entries()].map(([connection, when]) => ({
      connection,
      lastMinute: when.filter((one) => at - one <= 60_000).length,
      lastHour: when.filter((one) => at - one <= this.keepMs).length,
    })).sort((a, b) => b.lastMinute - a.lastMinute);
  }
}

export interface RequestAllowance extends RequestRate {
  /** What the service itself says is left, when its answers carry that. */
  limit: number | null; remaining: number | null; resetSeconds: number | null;
  summary: string;
}
/** How busy each connection is, beside the allowance that service reports in its own answers. */
export function requestAllowances(counter: RequestCounter, health: ProviderHealth): RequestAllowance[] {
  const byId = new Map(health.list().map((record) => [record.id, record]));
  const seen = new Set<string>();
  const rows: RequestAllowance[] = [];
  for (const rate of counter.rates()) {
    seen.add(rate.connection);
    const reading = byId.get(rate.connection)?.rateLimit ?? null;
    rows.push({ ...rate, limit: reading?.limit ?? null, remaining: reading?.remaining ?? null,
      resetSeconds: reading?.resetSeconds ?? null, summary: allowanceText(rate, reading) });
  }
  /* A connection that has answered but has had no call this hour still belongs in the list. */
  for (const record of health.list()) {
    if (seen.has(record.id)) continue;
    const empty = { connection: record.id, lastMinute: 0, lastHour: 0 };
    rows.push({ ...empty, limit: record.rateLimit?.limit ?? null, remaining: record.rateLimit?.remaining ?? null,
      resetSeconds: record.rateLimit?.resetSeconds ?? null, summary: allowanceText(empty, record.rateLimit ?? null) });
  }
  return rows;
}
function allowanceText(rate: RequestRate, reading: { limit: number | null; remaining: number | null } | null): string {
  const busy = `${rate.lastMinute} in the last minute, ${rate.lastHour} in the last hour`;
  if (!reading || reading.limit === null) return `${busy}. This service does not say what it allows.`;
  const left = reading.remaining === null ? "" : `, ${reading.remaining} left`;
  return `${busy}. It allows ${reading.limit}${left}.`;
}

export interface CachedLine {
  runId: string; at: string; model: string; provider: string;
  savedInput: number; savedOutput: number; wouldHaveCost: number; reason: string;
}
/**
 * Every round answered out of the kept-answers store, with what it would have cost had it gone to
 * the service. The tokens were written down when the answer was served, so this only prices them.
 */
export function cachedAnswers(store: Store, owner: string, limit = 100): { lines: CachedLine[]; wouldHaveCost: number } {
  const { overrides } = pricingTableInUse(store, owner);
  const lines: CachedLine[] = [];
  for (const run of store.runs(owner).slice(0, 200)) {
    for (const event of store.events(run.id)) {
      if (event.kind !== "model.completed" || event.data?.cached !== true) continue;
      const savedInput = Number(event.data.savedInput ?? 0) || 0;
      const savedOutput = Number(event.data.savedOutput ?? 0) || 0;
      const model = String(event.data.model ?? "");
      const cost = estimateCost(model, { input: savedInput, output: savedOutput }, overrides);
      lines.push({ runId: run.id, at: event.createdAt, model, provider: String(event.data.provider ?? ""),
        savedInput, savedOutput, wouldHaveCost: cost.amount ?? 0,
        reason: String(event.data.cacheReason ?? "The same request was answered before.") });
    }
    if (lines.length >= limit) break;
  }
  lines.sort((a, b) => b.at.localeCompare(a.at));
  const kept = lines.slice(0, limit);
  return { lines: kept, wouldHaveCost: kept.reduce((sum, line) => sum + line.wouldHaveCost, 0) };
}

export interface BatchSetLine {
  runId: string; at: string; model: string; provider: string;
  /** "batch" when the service took the whole set, "direct" when each question went on its own. */
  route: "batch" | "direct";
  questions: number; batched: number; askedAgain: number; unanswered: number;
  cost: number; saved: number; reason: string | null;
}
/**
 * Every set of questions handed over at once, with what it cost and what handing it over saved
 * against asking the same questions one at a time. A set the connection could not take is in here
 * too, showing nothing saved and saying why, so the screen does not quietly imply every set was
 * cheap when in fact none of them took the cheap road.
 */
export function batchSets(store: Store, owner: string, limit = 100): {
  lines: BatchSetLine[]; saved: number; spent: number; batched: number; askedAgain: number;
} {
  const lines: BatchSetLine[] = [];
  for (const run of store.runs(owner).slice(0, 200)) {
    for (const event of store.events(run.id)) {
      if (event.kind !== "batch.completed") continue;
      const data = event.data ?? {};
      lines.push({
        runId: run.id, at: event.createdAt, model: String(data.model ?? ""), provider: String(data.provider ?? ""),
        route: data.route === "batch" ? "batch" : "direct",
        questions: Number(data.questions ?? 0) || 0, batched: Number(data.batched ?? 0) || 0,
        askedAgain: Number(data.askedAgain ?? 0) || 0, unanswered: Number(data.unanswered ?? 0) || 0,
        cost: Number(data.cost ?? 0) || 0, saved: Number(data.saved ?? 0) || 0,
        reason: data.reason === null || data.reason === undefined ? null : String(data.reason),
      });
    }
    if (lines.length >= limit) break;
  }
  lines.sort((a, b) => b.at.localeCompare(a.at));
  const kept = lines.slice(0, limit);
  const add = (pick: (line: BatchSetLine) => number): number => kept.reduce((sum, line) => sum + pick(line), 0);
  return { lines: kept, saved: add((line) => line.saved), spent: add((line) => line.cost),
    batched: add((line) => line.batched), askedAgain: add((line) => line.askedAgain) };
}

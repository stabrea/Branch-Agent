import { randomBytes, randomUUID } from "node:crypto";
import { lateNote } from "./never-break/resume.js"; // mac3/never-break
import { z } from "zod";
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ToolRegistry } from "./registry.js";
import type { SuiteRunner } from "./evaluation-runner.js";

const timezone = z.string().min(1).max(64).refine((zone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}, "Unknown timezone");
export const ScheduleSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    dueAt: z.iso.datetime(),
    /** reminder: a note in Activity; task: run the assistant; check: run it and hand it the previous result; evaluation: run a test suite. */
    kind: z.enum(["reminder", "task", "check", "evaluation"]),
    /** Which evaluation suite to run, for an `evaluation` schedule. */
    suite: z.string().min(1).max(64).optional(),
    /** The model choice the evaluation should use; the one in use otherwise. */
    preset: z.string().min(1).max(64).optional(),
    intervalMs: z.number().int().min(60000).max(31536000000).optional(),
    /** Repeat every day at this local time in `timezone` (HH:MM, 24-hour). */
    dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    timezone: timezone.optional(),
    /** Send the finished result to a connected channel chat. */
    deliverTo: z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().optional(),
    /** Allow an authenticated webhook to trigger this schedule with a payload. */
    webhook: z.boolean().optional(),
    /** Wave 6: what to do when the due moment lands on a holiday, a weekend or a day off. */
    daysOff: z.enum(["run", "skip", "shift"]).default("run"),
    permissions: z.array(z.string().max(100)).max(50).optional(),
  })
  .strict()
  .refine((value) => !(value.intervalMs && value.dailyAt), "Choose either an interval or a daily time")
  .refine((value) => !value.dailyAt || value.timezone, "A daily time needs a timezone")
  .refine((value) => value.kind !== "evaluation" || !!value.suite, "An evaluation schedule needs the name of a suite");
export type DeliveryHandler = (channel: string, chatId: string, text: string, key: string) => Promise<{ messageId?: string | undefined; queued?: number }>;
export interface HistoryEntry { runId: string | null; status: string; startedAt: string; finishedAt?: string; trigger: string }
const historyLimit = 50;
/** How many turns in a row a repeating job may miss before it is paused and the owner told why. */
export const failuresBeforePausing = 3;
/** Whether a schedule comes round again, rather than happening once. */
const repeating = (data: Record<string, unknown>): boolean =>
  typeof data.intervalMs === "number" || typeof data.dailyAt === "string";
/** The moment a repeating schedule is next due after `now`. */
export const nextTurn = (data: Record<string, unknown>, now: Date): string =>
  typeof data.dailyAt === "string"
    ? nextDailyOccurrence(now, data.dailyAt, String(data.timezone)).toISOString()
    : new Date(now.getTime() + Number(data.intervalMs ?? 0)).toISOString();

/** The next moment `HH:MM` occurs in `zone` strictly after `after`. */
export function nextDailyOccurrence(after: Date, hhmm: string, zone: string): Date {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const parts = (date: Date) => {
    const found: Record<string, number> = {};
    for (const part of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date))
      if (part.type !== "literal") found[part.type] = Number(part.value);
    return found;
  };
  const wallToUtc = (y: number, m: number, d: number) => {
    let guess = Date.UTC(y, m - 1, d, hour, minute, 0);
    for (let i = 0; i < 3; i++) {
      const p = parts(new Date(guess));
      const seen = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      const wanted = Date.UTC(y, m - 1, d, hour, minute, 0);
      if (seen === wanted) break;
      guess += wanted - seen;
    }
    return guess;
  };
  const today = parts(after);
  let candidate = wallToUtc(today.year!, today.month!, today.day!);
  if (candidate <= after.getTime()) {
    const tomorrow = new Date(Date.UTC(today.year!, today.month! - 1, today.day! + 1, 12));
    const t = parts(tomorrow);
    candidate = wallToUtc(t.year!, t.month!, t.day!);
  }
  return new Date(candidate);
}

/** What the scheduler needs to know about days off; the calendar settings supply it. */
export interface DayOffAdvice {
  decide(owner: string, at: Date, mode: "run" | "skip" | "shift"): { action: "run" | "skip" | "shift"; reason: string | null; moveTo?: string };
}
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Holidays, weekends and the owner's own days off; nothing is held back until this is connected. */
  calendar: DayOffAdvice | undefined;
  private readonly active = new Set<Promise<Run[]>>();
  /** Runs test suites on a schedule; stays null until `createBranch` connects one. */
  evaluations: SuiteRunner | null = null;
  /** Extra work that runs on every beat alongside the saved schedules: watches, the morning brief. */
  readonly onTick = new Set<(now: Date) => Promise<void>>();
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    private readonly deliver?: DeliveryHandler,
  ) {}
  create(context: ToolContext, input: unknown): SavedRecord {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    const definition = ScheduleSchema.parse(input),
      permissions =
        definition.permissions ??
        [...context.permissions].filter(
          (p) => !p.startsWith("schedules.") && !p.endsWith(".manage"),
        );
    if (permissions.some((p) => !context.permissions.has(p)))
      throw new Error("Schedule permission escalation denied");
    const { webhook, ...rest } = definition;
    return this.store.save("schedules", context.owner, randomUUID(), {
      ...rest,
      dueAt: new Date(definition.dueAt).toISOString(),
      permissions,
      status: "pending",
      history: [],
      ...(webhook ? { hookToken: randomBytes(24).toString("hex") } : {}),
    });
  }
  async tick(now = new Date()): Promise<Run[]> {
    const results: Run[] = [];
    if (this.store.review.dreamDue(this.runtime.owner, now)) await this.store.review.consolidate(this.runtime, this.runtime.owner).catch(() => undefined);
    for (const candidate of this.store.dueSchedules(this.runtime.owner, now.toISOString())) {
      if (this.deferredForDayOff(candidate, now)) continue;
      const claimed = this.store.claimSchedule(this.runtime.owner, candidate.id, now.toISOString());
      if (!claimed) continue;
      const run = await this.execute(claimed, now, "schedule", undefined, true);
      if (run) results.push(run);
    }
    // Last, so that work the person actually asked for is never left waiting behind a watch
    // that is slow to answer. A beat that overlaps the one before it is normal here.
    for (const listener of this.onTick) await listener(now).catch(() => undefined);
    return results;
  }
  /**
   * Holds a schedule back when its moment lands on a day off. "Skip" moves a repeating one on to
   * its next turn and closes a one-off; "shift" moves it to the next working day. Nothing runs.
   */
  private deferredForDayOff(record: SavedRecord, now: Date): boolean {
    const mode = record.data.daysOff;
    if (mode !== "skip" && mode !== "shift") return false;
    const decision = this.calendar?.decide(record.owner, now, mode);
    if (!decision || decision.action === "run") return false;
    const data = record.data;
    const repeats = repeating(data);
    const movedTo = decision.action === "shift" ? decision.moveTo! : repeats ? nextTurn(data, now) : String(data.dueAt);
    this.store.save("schedules", record.owner, record.id, {
      ...data, dueAt: movedTo,
      status: decision.action === "skip" && !repeats ? "skipped" : "pending",
      lastDayOff: { at: now.toISOString(), action: decision.action, reason: decision.reason, movedTo },
    });
    this.runtime.notifyEvent("schedule.day_off", { scheduleId: record.id, action: decision.action, reason: decision.reason, movedTo });
    return true;
  }
  /** Runs a saved schedule now (webhook or local script) without moving its next due time. */
  async trigger(owner: string, id: string, payload: unknown, trigger: "webhook" | "local"): Promise<Run> {
    const record = this.store.get("schedules", owner, id);
    if (!record) throw new Error("Schedule not found");
    if (!["pending", "paused", "completed", "failed"].includes(String(record.data.status)))
      throw new Error("This schedule is running right now");
    const run = await this.execute(record, new Date(), trigger, payload, false);
    if (!run) throw new Error("The schedule did not produce a run");
    return run;
  }
  private async execute(record: SavedRecord, now: Date, trigger: string, payload: unknown, advance: boolean): Promise<Run | undefined> {
    const startedAt = now.toISOString(), data = record.data;
    const history = (Array.isArray(data.history) ? data.history as HistoryEntry[] : []).slice(-(historyLimit - 1));
    const entry: HistoryEntry = { runId: null, status: "running", startedAt, trigger };
    // mac3/never-break: a turn missed while Branch was not running runs once, and says so.
    const late = trigger === "schedule" ? lateNote(data.dueAt, now) : null;
    if (late) Object.assign(entry, { late });
    this.store.save("schedules", record.owner, record.id, { ...data, status: "running", history: [...history, entry] });
    try {
      const run = data.kind === "reminder" ? this.remind(record) : data.kind === "evaluation" ? await this.evaluateSuite(record) : await this.runtime.run({
        prompt: this.promptFor(data, payload), permissions: data.permissions as string[], source: "schedule",
        onStarted: (started) => { entry.runId = started.id; if (late) this.store.event(started.id, "schedule.caught_up", { scheduleId: record.id, note: late }); },
        onTextDelta: () => undefined, // stream so a silent model is noticed
      });
      Object.assign(entry, { runId: run.id, status: run.status, finishedAt: new Date().toISOString() });
      this.runtime.notifyEvent("schedule.fired", { scheduleId: record.id, runId: run.id, status: run.status, trigger });
      const delivery = await this.deliverResult(data, run);
      this.store.save("schedules", record.owner, record.id, {
        ...data, runId: run.id, runCount: Number(data.runCount ?? 0) + 1, history: [...history, entry],
        lastRunAt: startedAt, lastResult: run.status === "completed" ? run.output.slice(0, 4000) : data.lastResult ?? null,
        ...(delivery ? { delivery } : {}), ...this.afterTurn(data, now, run.status, advance),
      });
      return run;
    } catch (e) {
      Object.assign(entry, { status: "failed", finishedAt: new Date().toISOString() });
      this.store.save("schedules", record.owner, record.id, {
        ...data, history: [...history, entry], lastRunAt: startedAt,
        error: e instanceof Error ? e.message : String(e),
        ...this.afterTurn(data, now, "failed", advance),
      });
      return undefined;
    }
  }
  /**
   * Where a repeating job stands after one turn. A turn that failed used to stop the job for good:
   * its state became "failed" and its due moment was never moved on, so a daily job that failed
   * once never ran again and nothing said so. Now a failed turn moves on to the next one, the
   * failures in a row are counted, and after three the job is paused with the reason written down,
   * so one that is broken rather than unlucky does not fail quietly every day for ever.
   */
  private afterTurn(data: Record<string, unknown>, now: Date, status: string, advance: boolean): Record<string, unknown> {
    if (!advance) return { status: String(data.status) === "running" ? "pending" : data.status };
    if (!repeating(data)) return { status, consecutiveFailures: 0 };
    const failures = status === "completed" ? 0 : Number(data.consecutiveFailures ?? 0) + 1;
    const paused = failures >= failuresBeforePausing;
    return {
      status: paused ? "paused" : "pending", dueAt: nextTurn(data, now), consecutiveFailures: failures,
      ...(paused ? { pausedBecause: `This repeating job did not finish ${failures} turns in a row, so it has been paused. Start it again once whatever it needs is working.` } : {}),
      ...(status === "completed" ? { pausedBecause: null } : {}),
    };
  }
  /** Runs the test suite a schedule is attached to; anything that has stopped working is announced. */
  private async evaluateSuite(record: SavedRecord): Promise<Run> {
    if (!this.evaluations) throw new Error("Evaluations are not available in this launch");
    const preset = typeof record.data.preset === "string" ? record.data.preset : undefined;
    const { run } = await this.evaluations.runScheduled(String(record.data.suite), preset);
    return run;
  }
  private promptFor(data: Record<string, unknown>, payload: unknown): string {
    let prompt = String(data.prompt);
    if (data.kind === "check" && typeof data.lastResult === "string" && data.lastResult)
      prompt += `\n\nYour previous check at ${String(data.lastRunAt ?? "an earlier time")} concluded: ${data.lastResult}\nCompare against it and report what changed.`;
    if (payload !== undefined) prompt += `\n\nTriggering event payload (JSON): ${JSON.stringify(payload).slice(0, 16000)}`;
    return prompt;
  }
  private async deliverResult(data: Record<string, unknown>, run: Run): Promise<Record<string, unknown> | undefined> {
    const target = data.deliverTo as { channel: string; chatId: string } | undefined;
    if (!target) return undefined;
    const at = new Date().toISOString();
    if (!this.deliver) return { ...target, at, error: "No channel delivery is available in this launch" };
    try {
      const text = run.status === "completed" ? run.output : `The scheduled task did not finish (${run.status}).`;
      const { messageId, queued } = await this.deliver(target.channel, target.chatId, text, `schedule:${run.id}`);
      this.store.event(run.id, queued ? "delivery.queued" : "delivery.sent", { ...target, messageId: messageId ?? null, queued: queued ?? 0 });
      return { ...target, at, messageId: messageId ?? null, ...(queued ? { queued } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(run.id, "delivery.failed", { ...target, error: message });
      return { ...target, at, error: message };
    }
  }
  /**
   * Batch 20 (wave 8): takes a schedule off the list for good. Without this the only way to be rid
   * of one was to pause it for ever, which is not the same thing and does not read the same way.
   */
  remove(context: ToolContext, id: string): { id: string; removed: boolean } {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    if (!this.store.get("schedules", context.owner, id)) return { id, removed: false };
    return { id, removed: this.store.delete("schedules", context.owner, id) };
  }
  setPaused(context: ToolContext, id: string, paused: boolean): SavedRecord {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    const record = this.store.get("schedules", context.owner, id);
    if (!record || !["pending", "paused"].includes(String(record.data.status)))
      throw new Error(
        "Only pending or paused schedules may be paused or resumed",
      );
    return this.store.save("schedules", context.owner, id, {
      ...record.data,
      status: paused ? "paused" : "pending",
    });
  }
  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const pending = this.tick();
      this.active.add(pending);
      void pending.catch(() => {}).finally(() => this.active.delete(pending));
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled(this.active);
  }
  private remind(record: SavedRecord): Run {
    const run = this.store.createRun(record.owner, String(record.data.prompt));
    const output = `Reminder: ${String(record.data.prompt)}`;
    this.store.message(run.sessionId, { role: "assistant", content: output });
    this.store.event(run.id, "reminder.due", {
      scheduleId: record.id,
      prompt: record.data.prompt,
    });
    return this.store.finish(run.id, "completed", output);
  }
}
export function registerSchedules(
  registry: ToolRegistry,
  scheduler: Scheduler,
): void {
  registry.register({
    name: "schedules.create",
    description:
      "Persist a reminder, task or monitoring check with an optional interval or a daily time in a timezone, optional delivery to a channel chat, and optional webhook triggering. Runs when online; missed periods coalesce into one execution. Failed tasks do not auto-retry.",
    permission: "schedules.manage",
    parameters: ScheduleSchema,
    execute: async (a, c) => scheduler.create(c, a),
  });
  registry.register({
    name: "schedules.pause",
    description: "Pause or resume a pending recurring or one-time schedule.",
    permission: "schedules.manage",
    parameters: z
      .object({ id: z.string().uuid(), paused: z.boolean() })
      .strict(),
    execute: async (a, c) => scheduler.setPaused(c, a.id, a.paused),
  });
  registry.register({
    name: "schedules.remove",
    description: "Delete a schedule for good, so it never runs again.",
    permission: "schedules.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (a, c) => scheduler.remove(c, a.id),
  });
  registry.register({
    name: "schedules.list",
    description: "List owner schedules and their durable execution status.",
    permission: "schedules.read",
    parameters: z.object({}).strict(),
    execute: async (_a, c) => scheduler.store.list("schedules", c.owner),
  });
}

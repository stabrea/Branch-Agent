import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ToolRegistry } from "./registry.js";

export const ScheduleSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    dueAt: z.iso.datetime(),
    kind: z.enum(["reminder", "task"]),
    intervalMs: z.number().int().min(60000).max(31536000000).optional(),
    permissions: z.array(z.string().max(100)).max(50).optional(),
  })
  .strict();
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly active = new Set<Promise<Run[]>>();
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
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
    return this.store.save("schedules", context.owner, randomUUID(), {
      ...definition,
      dueAt: new Date(definition.dueAt).toISOString(),
      permissions,
      status: "pending",
    });
  }
  async tick(now = new Date()): Promise<Run[]> {
    const results: Run[] = [];
    for (const candidate of this.store.dueSchedules(
      this.runtime.owner,
      now.toISOString(),
    )) {
      const claimed = this.store.claimSchedule(
        this.runtime.owner,
        candidate.id,
        now.toISOString(),
      );
      if (!claimed) continue;
      try {
        const run =
          claimed.data.kind === "reminder"
            ? this.remind(claimed)
            : await this.runtime.run({
                prompt: String(claimed.data.prompt),
                permissions: claimed.data.permissions as string[],
              });
        const repeats =
          run.status === "completed" &&
          typeof claimed.data.intervalMs === "number";
        this.store.save("schedules", claimed.owner, claimed.id, {
          ...claimed.data,
          status: repeats ? "pending" : run.status,
          runId: run.id,
          runCount: Number(claimed.data.runCount ?? 0) + 1,
          ...(repeats
            ? {
                dueAt: new Date(
                  now.getTime() + Number(claimed.data.intervalMs),
                ).toISOString(),
              }
            : {}),
        });
        results.push(run);
      } catch (e) {
        this.store.save("schedules", claimed.owner, claimed.id, {
          ...claimed.data,
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
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
      "Persist a reminder or task with optional repeat interval. Runs when online; missed periods coalesce into one execution. Failed tasks do not auto-retry.",
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
    name: "schedules.list",
    description: "List owner schedules and their durable execution status.",
    permission: "schedules.read",
    parameters: z.object({}).strict(),
    execute: async (_a, c) => scheduler.store.list("schedules", c.owner),
  });
}

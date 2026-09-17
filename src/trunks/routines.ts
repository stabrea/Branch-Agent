import { z } from "zod";
import type { Run } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import { nextTurn, type Scheduler } from "../scheduler.js";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";
import { requireTrunkPart } from "./settings.js";

/**
 * R17-008 (T-08): routines a Trunk owns. A routine is an ordinary schedule (src/scheduler.ts), so it
 * shows in Automations with the rest and keeps every rule schedules have; what makes it the Trunk's
 * is a link kept here. It runs as the Trunk, and its result is written into the Trunk's own
 * conversation — at once when that conversation is quiet, or as soon as it is.
 *
 * Hermes names such jobs `[bot:<name>] <routine>` (hermes-agent `bot-mode.md`, MIT); the schedule's
 * words start with `[Trunk @name]` the same way, so the list in Automations says whose it is.
 */
export const RoutineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(7000),
  dueAt: z.iso.datetime().optional(),
  intervalMs: z.number().int().min(60000).max(31536000000).optional(),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
}).strict();

const linksKey = "trunk-routines";

/**
 * Integrator (R17-A): when a routine without a date first runs — at the time of day it was given, or
 * one interval from now — so saving one (or teaching one) never sets it going straight away.
 */
function firstTurn(value: z.infer<typeof RoutineSchema>, now = new Date()): string {
  if (value.dailyAt) return nextTurn({ dailyAt: value.dailyAt, timezone: value.timezone ?? "UTC" }, now);
  return new Date(now.getTime() + (value.intervalMs ?? 60000)).toISOString();
}
interface Link { trunkId: string; name: string }

export class TrunkRoutines {
  private readonly busy = new Set<string>();
  private readonly waiting = new Map<string, string[]>();
  private readonly stopListening: () => void;

  constructor(private readonly store: Store, private readonly owner: string, private readonly records: TrunkRecords,
    private readonly scheduler: Scheduler, private readonly runtime: Pick<Runtime, "context">) {
    this.stopListening = store.onEvent((runId, kind) => this.observe(runId, kind));
  }
  close(): void { this.stopListening(); }

  private links(): Record<string, Link> {
    return ((this.store.get("settings", this.owner, linksKey)?.data ?? {}) as { links?: Record<string, Link> }).links ?? {};
  }
  private saveLinks(links: Record<string, Link>): void {
    this.store.save("settings", this.owner, linksKey, { links });
  }

  /**
   * `extra` names permissions a schedule would otherwise leave out (it drops every "manage" one); a
   * taught routine needs `workflows.manage` to start the workflow it was taught.
   */
  create(trunkId: string, input: unknown, extra: readonly string[] = []): { id: string; name: string } {
    requireTrunkPart(this.store, this.owner, "routines");
    const trunk = this.records.get(trunkId);
    const value = RoutineSchema.parse(input);
    const context = this.runtime.context();
    const ordinary = [...context.permissions].filter((p) => !p.startsWith("schedules.") && !p.endsWith(".manage"));
    const saved = this.scheduler.create(context, {
      ...(extra.length ? { permissions: [...ordinary, ...extra.filter((p) => context.permissions.has(p))] } : {}),
      prompt: `[Trunk @${trunk.handle}] ${value.name}\n${value.prompt}`, kind: "task",
      dueAt: value.dueAt ?? firstTurn(value),
      ...(value.intervalMs ? { intervalMs: value.intervalMs } : {}),
      ...(value.dailyAt ? { dailyAt: value.dailyAt, timezone: value.timezone ?? "UTC" } : {}),
    });
    this.saveLinks({ ...this.links(), [saved.id]: { trunkId, name: value.name } });
    return { id: saved.id, name: value.name };
  }
  list(trunkId?: string) {
    const links = this.links();
    return this.store.list("schedules", this.owner).flatMap((record) => {
      const link = links[record.id];
      if (!link || (trunkId && link.trunkId !== trunkId)) return [];
      const data = record.data;
      return [{ id: record.id, trunkId: link.trunkId, name: link.name, status: String(data.status ?? ""), dueAt: String(data.dueAt ?? ""),
        dailyAt: data.dailyAt ?? null, intervalMs: data.intervalMs ?? null, lastResult: data.lastResult ?? null }];
    });
  }
  remove(scheduleId: string): { removed: boolean } {
    const links = this.links();
    if (!links[scheduleId]) return { removed: false };
    const { [scheduleId]: _gone, ...rest } = links;
    this.saveLinks(rest);
    return this.scheduler.remove(this.runtime.context(), scheduleId);
  }
  /** Every routine of a Trunk that is being removed goes with it. */
  removeFor(trunkId: string): void {
    for (const routine of this.list(trunkId)) this.remove(routine.id);
  }

  /**
   * The scheduler's hook: a linked schedule runs as its Trunk and reports back. One that cannot run
   * as its Trunk (the part is switched off, or the Trunk is gone) is refused rather than run as the
   * owner, whose saved set is wider than the Trunk's.
   */
  route(scheduleId: string, switchedOn = true): { options: { trunkId: string }; finished: (run: Run) => void } | { refuse: string } | null {
    const link = this.links()[scheduleId];
    if (!link) return null;
    const trunk = this.records.find(link.trunkId);
    if (!trunk) return { refuse: "The Trunk this routine belonged to is gone, so the routine did not run." };
    if (!switchedOn) return { refuse: "Routines a Trunk owns are switched off, so this routine did not run." };
    return { options: { trunkId: trunk.id }, finished: (run) => this.report(trunk.chatSessionId, `Routine "${link.name}": ${run.status === "completed" ? run.output : `it did not finish (${run.status}). ${run.output}`}`) };
  }
  private report(sessionId: string, text: string): void {
    const content = text.slice(0, 8000);
    if (!this.busy.has(sessionId)) { this.store.message(sessionId, { role: "assistant", content }); return; }
    this.waiting.set(sessionId, [...(this.waiting.get(sessionId) ?? []), content]);
  }
  /** Notes are only written while the Trunk's conversation is quiet, so a turn in progress is never split. */
  private observe(runId: string, kind: string): void {
    if (kind !== "run.started" && kind !== "run.finished") return;
    const run = this.store.run(runId);
    if (!run) return;
    if (kind === "run.started") { this.busy.add(run.sessionId); return; }
    this.busy.delete(run.sessionId);
    const notes = this.waiting.get(run.sessionId);
    if (!notes) return;
    this.waiting.delete(run.sessionId);
    for (const note of notes) this.store.message(run.sessionId, { role: "assistant", content: note });
  }
}

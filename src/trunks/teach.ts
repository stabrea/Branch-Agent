import { z } from "zod";
import { recordingFlowDraft } from "../recording-to-flow.js";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";
import type { TrunkRoutines } from "./routines.js";
import { requireTrunkPart } from "./settings.js";

/**
 * R17-012 (T-13): teaching a Trunk by showing it once, after Grok Bot's "watch me once".
 *
 * The owner presses "Watch me", then does the job once in any conversation. "Save what I did" takes
 * the actions of the task finished since then (or the one the owner points at), turns them into a
 * saved workflow with the same draft Inbox → History uses (src/recording-to-flow.ts, secrets taken
 * out), and gives it to the Trunk. With a time, it also becomes one of the Trunk's routines.
 */
export const TeachSchema = z.object({
  name: z.string().trim().max(80).default(""),
  /** The task to learn from; the latest one finished since "Watch me" when left out. */
  runId: z.string().uuid().optional(),
  /** Repeat it: every day at this time, or every so many minutes. */
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
  everyMinutes: z.number().int().min(1).max(525600).optional(),
}).strict();

export interface TeachDeps {
  store: Store;
  owner: string;
  records: TrunkRecords;
  routines: TrunkRoutines;
  workflows: { forOwner(owner: string): string; create(owner: string, input: unknown): { id: string; name: string } };
  scrub: <T>(value: T) => T;
}

const watchKey = (trunkId: string): string => `trunk-watch:${trunkId}`;

export class TrunkTeaching {
  constructor(private readonly deps: TeachDeps) {}

  /** Starts watching: the next task the owner finishes is the one to learn from. */
  watch(trunkId: string): { watching: true; since: string } {
    const { store, owner, records } = this.deps;
    requireTrunkPart(store, owner, "teach");
    records.get(trunkId);
    const since = new Date().toISOString();
    store.save("settings", owner, watchKey(trunkId), { since });
    return { watching: true, since };
  }
  watching(trunkId: string): string | null {
    return ((this.deps.store.get("settings", this.deps.owner, watchKey(trunkId))?.data ?? {}) as { since?: string }).since ?? null;
  }
  /** The task to learn from: the one named, or the latest finished since watching started. */
  private lesson(trunkId: string, runId: string | undefined): string {
    if (runId) return runId;
    const since = this.watching(trunkId);
    if (!since) throw new Error('Press "Watch me" first, then do the job once.');
    const done = this.deps.store.runs(this.deps.owner).find((run) => run.status === "completed" && run.createdAt >= since);
    if (!done) throw new Error("Nothing has finished since you pressed Watch me. Do the job once, then save it.");
    return done.id;
  }

  save(trunkId: string, input: unknown) {
    const { store, owner, records, routines, workflows, scrub } = this.deps;
    requireTrunkPart(store, owner, "teach");
    const trunk = records.get(trunkId);
    const value = TeachSchema.parse(input ?? {});
    const runId = this.lesson(trunkId, value.runId);
    const draft = recordingFlowDraft(store, runId, value.name || `${trunk.name}: learned`, scrub);
    const saved = workflows.create(workflows.forOwner(owner), draft.definition);
    store.event(runId, "trunk.taught", { trunkId, workflowId: saved.id, steps: draft.definition.steps.length });
    records.put({ ...trunk, taught: [...trunk.taught, { workflowId: saved.id, name: saved.name, runId }].slice(-50), updatedAt: new Date().toISOString() });
    store.delete("settings", owner, watchKey(trunkId));
    const routine = value.dailyAt || value.everyMinutes
      ? routines.create(trunkId, {
        name: saved.name, prompt: `Run the saved workflow "${saved.name}" (id ${saved.id}) with workflows.run, then say in one line how it went.`,
        ...(value.dailyAt ? { dailyAt: value.dailyAt, timezone: value.timezone ?? "UTC" } : { intervalMs: value.everyMinutes! * 60000 }),
      }, ["workflows.manage"])
      : null;
    return { workflow: saved, steps: draft.definition.steps.length, leftOut: draft.leftOut, routine };
  }
}

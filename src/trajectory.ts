/**
 * A task's trajectory: one JSON file that holds everything the task actually did, in a shape that
 * is written down and stays put, so it can be read back by an evaluation tool months later.
 *
 * It is the "Look inside" answer (rounds, tool calls with what went in and what came back clipped,
 * the plan, the reviewer's verdicts, the timeline, the usage and the cost) plus the two things that
 * screen does not need: the messages of the conversation, and the spans recorded while it ran.
 * Nothing new is worked out here; the shape is the contract.
 */
import { z } from "zod";
import { inspectRun, type PriceRound } from "./inspect.js";
import { classifyToolEvent } from "./receipts.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";

/** The name and number of the shape. A reader checks these before anything else. */
export const trajectoryFormat = "branch-agent-trajectory";
export const trajectoryVersion = 1;

export interface TrajectoryOptions {
  receipts: { items: { id: unknown; outcome: string }[]; counts: Record<string, number> };
  timeline: unknown;
  cost: unknown;
  version: string;
  price?: PriceRound;
  /** Most spans written out; a long task can record thousands and the file stays readable. */
  maxSpans?: number;
}

/**
 * One task as a trajectory document. `run` is null when the task has been cleared away, and the
 * caller has already checked that the task belongs to whoever is asking.
 */
export function buildTrajectory(store: Store, runId: string, options: TrajectoryOptions) {
  const inspected = inspectRun(store, runId, options);
  const sessionId = inspected.run?.sessionId;
  const spans = store.spans.forRun(runId).slice(0, options.maxSpans ?? 500);
  return {
    /* `version` inside the record is the version of Branch that ran the task, so the shape's own
       number is named separately rather than fighting it. */
    format: trajectoryFormat,
    formatVersion: trajectoryVersion,
    ...inspected,
    /** The conversation as the model saw it, tool requests and results included. */
    messages: sessionId ? store.messages(sessionId) : [],
    spans,
  };
}

/**
 * Many tasks as JSON Lines: one trajectory per line, newest first, for feeding an evaluation run.
 * Lines are written one at a time so a thousand tasks never become one enormous string in memory
 * before anything is sent.
 */
export function* trajectoryLines(
  store: Store, runIds: readonly string[], options: (runId: string) => TrajectoryOptions,
  /**
   * Takes any saved password or key back out of a trajectory before it is written. It is given the
   * document itself rather than the finished line, because a secret inside a JSON string is escaped
   * and would no longer match what it is being looked for by.
   */
  scrub: <T>(value: T) => T = (value) => value,
): Generator<string> {
  for (const runId of runIds) {
    try {
      yield JSON.stringify(scrub(buildTrajectory(store, runId, options(runId))));
    } catch {
      /* One task that cannot be read must not stop the rest of the export. */
    }
  }
}

/** Whether each tool call in a task was proven, worked out the same way the receipts view does. */
export async function receiptOutcomes(store: Store, runId: string): Promise<TrajectoryOptions["receipts"]> {
  const items: { id: unknown; outcome: string }[] = [];
  const counts: Record<string, number> = {};
  for (const event of store.events(runId).filter((event) => event.kind.startsWith("tool."))) {
    const outcome = await classifyToolEvent(store.receipts, runId, event.kind, event.data);
    if (!outcome) continue;
    items.push({ id: event.data.id ?? null, outcome });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return { items, counts };
}

const ExportSchema = z.object({
  /** The task to write out. Leave it out for the task this is happening in. */
  runId: z.string().uuid().optional(),
}).strict();

/**
 * `runs.export`: hands back one task's trajectory in the documented shape, so a model asked to
 * look over its own work — or an evaluation being written — has the whole record. It reads and
 * writes nothing, and it is refused a task that belongs to somebody else.
 */
export function registerRunExport(registry: ToolRegistry, store: Store, version: string): void {
  registry.register({
    name: "runs.export",
    description: "Hand back one finished task's full record as JSON: its rounds, tool calls, plan, verdicts, messages and spans.",
    permission: "history.read",
    parameters: ExportSchema,
    execute: async (input, context) => {
      const runId = input.runId ?? context.runId;
      const run = store.run(runId);
      if (!run || run.owner !== context.owner) throw new Error("There is no task of yours with that number");
      return buildTrajectory(store, runId, {
        receipts: await receiptOutcomes(store, runId),
        timeline: store.usageStore().getRunTimeline(runId),
        cost: null, version,
      });
    },
  });
}

/** Checks a document really is a trajectory of a shape this version understands. */
export function isTrajectory(value: unknown): boolean {
  const document = value as { format?: unknown; formatVersion?: unknown; calls?: unknown; messages?: unknown };
  return document?.format === trajectoryFormat && document.formatVersion === trajectoryVersion
    && Array.isArray(document.calls) && Array.isArray(document.messages);
}

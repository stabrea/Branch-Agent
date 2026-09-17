import type { Event, RunStatus } from "../contracts.js";
import type { ActionUse } from "./circuit.js";

/**
 * Reading a finished task for the two things the learning core needs: which actions were taken,
 * in what order (the eligible synapses), and how it went (the dopamine signal).
 *
 * The signal is in [-1, 1]. A task that finished is a reward and one that failed a punishment;
 * checks that passed or failed, an owner correction and what the task cost adjust it. Each reason
 * is kept in plain words so the owner can see why something was learned.
 */
export interface TaskOutcome { uses: ActionUse[]; signal: number; reasons: string[] }

const statusSignal: Partial<Record<RunStatus, number>> = {
  completed: 1, failed: -1, budget_exceeded: -0.7, cancelled: -0.3,
};
/** Tokens at which the cost adjustment reaches its largest size. */
export const costlyTokens = 400_000;
const maximumCostPenalty = 0.3;
const maximumMemoriesPerTask = 10;
/**
 * Openings that mark a person putting the assistant right. The same idea as the pattern in
 * src/memory-learning.ts (not exported there), kept in step by hand.
 */
const correctionOpenings =
  /^(?:no[,.!\s]|not quite|actually[,\s]|that(?:'s| is) (?:wrong|not right|incorrect)|i meant|i said|wrong[,.!\s]|correction[:,\s])/i;
export const correctionSignal = -0.8;

export function isCorrection(prompt: string): boolean {
  return correctionOpenings.test(prompt.trim());
}

const clamp = (value: number): number => Math.min(1, Math.max(-1, value));
const ids = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).flatMap((item) => {
    const id = (item as { id?: unknown } | null)?.id;
    return typeof id === "string" && id ? [id.slice(0, 200)] : [];
  });

/** Every action a task took, the last use of each one winning. */
export function usesOf(events: readonly Event[]): ActionUse[] {
  const found = new Map<string, ActionUse>();
  let step = 0, memories = 0;
  const use = (kind: ActionUse["kind"], action: string, failed = false): void => {
    found.delete(`${kind}:${action}`);
    found.set(`${kind}:${action}`, { action, kind, step, ...(failed ? { failed } : {}) });
  };
  for (const event of events) {
    const name = String(event.data.name ?? "");
    if (event.kind === "tool.started" && name) { step += 1; use("tool", name); }
    if ((event.kind === "tool.failed" || event.kind === "tool.stalled") && name) use("tool", name, true);
    if (event.kind === "skills.pinned" && event.data.id) use("skill", String(event.data.id));
    if (event.kind !== "tool.completed") continue;
    const result = event.data.result as { id?: unknown } | undefined;
    if (name === "skills.read" && typeof result?.id === "string") use("skill", result.id);
    if (name.startsWith("memory.") && memories < maximumMemoriesPerTask)
      for (const id of ids(Array.isArray(result) ? result : [result]).slice(0, maximumMemoriesPerTask - memories)) {
        memories += 1;
        use("memory", id);
      }
  }
  return [...found.values()];
}

/** The dopamine signal for a finished task, with its reasons. */
export function outcomeOf(status: RunStatus, events: readonly Event[], tokens: number): TaskOutcome {
  const reasons: string[] = [];
  let signal = statusSignal[status] ?? 0;
  if (signal) reasons.push(`the task ${status === "completed" ? "finished" : `ended as ${status.replace("_", " ")}`}`);
  const passed = events.filter((event) => event.kind === "run.check_passed").length;
  const failed = events.filter((event) => event.kind === "run.check_failed").length;
  if (passed) { signal += 0.3; reasons.push("its check passed"); }
  if (failed) { signal -= Math.min(0.6, 0.3 * failed); reasons.push(`its check failed ${failed} time(s)`); }
  if (signal && tokens > 0) {
    const penalty = Math.min(maximumCostPenalty, (tokens / costlyTokens) * maximumCostPenalty);
    if (penalty >= 0.01) { signal -= penalty; reasons.push(`it used ${tokens} tokens`); }
  }
  return { uses: usesOf(events), signal: clamp(signal), reasons };
}

/**
 * Marking the path rather than the answer: did the task take the steps it was supposed to take.
 *
 * Two runs can reach the same answer by very different routes, and for a lot of work the route is
 * the thing being judged — a task that was meant to read the file and edit it, but instead guessed,
 * is wrong even when the answer happens to be right. This compares the tool calls a task made
 * against the ones a reference run made, in order, and says how far apart they are in plain words.
 *
 * The measure is the longest run of calls the two have in common, allowing gaps on both sides, so
 * one extra call in the middle costs one call rather than everything after it. No model is asked.
 */

/** One step of a reference path: a tool, and optionally the arguments it must have been given. */
export interface ReferenceStep {
  name: string;
  /** Only these keys are checked. A step with no arguments matches any call to that tool. */
  arguments?: Record<string, unknown> | undefined;
}
/** One step that really happened, in the shape a scored trajectory already holds. */
export interface ActualStep { name: string; arguments: Record<string, unknown> }

export interface TrajectoryComparison {
  /** From 0 to 1: how much of the two paths line up, counting both what is missing and what is extra. */
  score: number;
  /** How many reference steps were found, in order. */
  matched: number;
  /** Reference steps that never happened, in the order they were expected. */
  missing: string[];
  /** Calls the task made that the reference path does not have, by name, each once with a count. */
  extra: string[];
  /** Whether every reference step happened, in the reference's own order. */
  inOrder: boolean;
  /** What went wrong, in sentences, ready to be shown as a scorer's reasons. */
  notes: string[];
}

/** Whether one real call satisfies one reference step. Only the named arguments are looked at. */
export function stepMatches(step: ReferenceStep, call: ActualStep): boolean {
  if (step.name !== call.name) return false;
  return Object.entries(step.arguments ?? {})
    .every(([key, value]) => JSON.stringify(call.arguments[key]) === JSON.stringify(value));
}

/** The longest run of reference steps that appear, in order, among the calls actually made. */
function longestInOrder(reference: readonly ReferenceStep[], actual: readonly ActualStep[]): boolean[] {
  const table: number[][] = Array.from({ length: reference.length + 1 }, () => new Array<number>(actual.length + 1).fill(0));
  for (let i = reference.length - 1; i >= 0; i -= 1)
    for (let j = actual.length - 1; j >= 0; j -= 1)
      table[i]![j] = stepMatches(reference[i]!, actual[j]!)
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const found = new Array<boolean>(reference.length).fill(false);
  let i = 0, j = 0;
  while (i < reference.length && j < actual.length) {
    if (stepMatches(reference[i]!, actual[j]!)) { found[i] = true; i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return found;
}

/** A reference step written out the way a person would say it. */
const describe = (step: ReferenceStep): string =>
  step.arguments && Object.keys(step.arguments).length
    ? `${step.name} with ${JSON.stringify(step.arguments).slice(0, 120)}` : step.name;

/**
 * Compares one path against a reference path. An empty reference means nothing was asked for, so
 * anything passes: a check nobody wrote is never a check that fails.
 */
export function compareTrajectories(
  reference: readonly ReferenceStep[], actual: readonly ActualStep[],
): TrajectoryComparison {
  if (!reference.length)
    return { score: 1, matched: 0, missing: [], extra: [], inOrder: true, notes: [] };
  const found = longestInOrder(reference, actual);
  const matched = found.filter(Boolean).length;
  const missing = reference.filter((_, index) => !found[index]).map(describe);
  const wanted = new Set(reference.map((step) => step.name));
  const extra = tally(actual.filter((call) => !wanted.has(call.name)).map((call) => call.name));
  const score = Math.round(((2 * matched) / (reference.length + actual.length || 1)) * 1000) / 1000;
  const notes: string[] = [];
  if (missing.length) notes.push(`These steps did not happen, in this order: ${missing.join(", ")}`);
  if (extra.length) notes.push(`These were used and were not part of the path: ${extra.join(", ")}`);
  return { score, matched, missing, extra, inOrder: matched === reference.length, notes };
}

/** Names with how many times each one turned up, for example `files.read x3`. */
function tally(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} x${count}` : name));
}

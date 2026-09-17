import type { PreloadedTool } from "../tool-loading.js";
import type { Suggestions } from "./hook.js";

/**
 * When the switch is "on", the core's advice changes what the task starts with, through mechanisms
 * Branch already has, and nothing else:
 *
 * - tools: the top ones join the tool loader's pre-load list (src/tool-loading.ts), which still
 *   applies its hard budget, so advice can never make the tool section heavier than its ceiling.
 *   A tool the core says to avoid is only left out of that pre-load; it is never hidden.
 * - skills: the top ones move to the front of the skill list the model is shown.
 * - memories: the top ones move to the front of the facts the conversation's snapshot is taken from.
 *
 * Each piece that was actually applied is written on the task as a `fly.applied` event, which the
 * "Look inside" screen shows as one plain line. "When needed" and "off" never post advice here, so
 * those modes behave exactly as before.
 *
 * Advice lives only while its task runs: it is posted as the task starts and taken down when it
 * settles. The board is bounded in case a task never settles.
 */
export type AppliedKind = "tools" | "skills" | "memories" | "left-out";
export interface Advice {
  runId: string;
  sessionId: string;
  suggestions: Suggestions;
  /** Writes one `fly.applied` event for the task. */
  note: (what: AppliedKind, names: string[]) => void;
}
export const preloadReason = "Worked before in similar tasks (learning core)";
const boardLimit = 200;
const board = new Map<string, Advice>();

export function postAdvice(advice: Advice): void {
  board.delete(advice.runId);
  board.set(advice.runId, advice);
  while (board.size > boardLimit) board.delete(board.keys().next().value!);
}
export function takeDownAdvice(runId: string): void { board.delete(runId); }
export function adviceFor(runId: string): Advice | undefined { return board.get(runId); }
function adviceForSession(sessionId: string): Advice | undefined {
  return [...board.values()].reverse().find((advice) => advice.sessionId === sessionId);
}
function safely(advice: Advice, what: AppliedKind, names: string[]): void {
  if (!names.length) return;
  try { advice.note(what, names); } catch { /* a note is never worth failing a task */ }
}

/**
 * The tool loader's pre-load list with the core's top tools first. Only tools this task can use
 * are added, and never one the owner switched off; a tool the core says to avoid is dropped from
 * the pre-load, and only from there.
 */
export function advisedPreload(runId: string, base: readonly PreloadedTool[], tools: readonly { name: string }[], switchedOff: readonly string[] = []): PreloadedTool[] {
  const advice = board.get(runId);
  if (!advice) return [...base];
  // A tool the owner switched off is never pre-loaded on the core's say-so: that would bring it back.
  const off = new Set(switchedOff);
  const known = new Set(tools.map((tool) => tool.name).filter((name) => !off.has(name)));
  const avoided = new Set(advice.suggestions.avoid.filter((s) => s.name.startsWith("tool:")).map((s) => s.name.slice(5)));
  const chosen = advice.suggestions.tools.map((s) => s.name).filter((name) => known.has(name) && !avoided.has(name));
  const leftOut = base.filter((entry) => avoided.has(entry.name)).map((entry) => entry.name);
  const rest = base.filter((entry) => !avoided.has(entry.name) && !chosen.includes(entry.name));
  safely(advice, "tools", chosen);
  safely(advice, "left-out", leftOut);
  return [...chosen.map((name) => ({ name, reason: preloadReason })), ...rest];
}

/** Moves the named entries to the front, in the order given, keeping everything else in place. */
function toFront<T>(entries: readonly T[], idOf: (entry: T) => string, wanted: readonly string[]): { list: T[]; moved: T[] } {
  const rank = new Map(wanted.map((id, at) => [id, at]));
  const moved = entries.filter((entry) => rank.has(idOf(entry))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
  return { list: [...moved, ...entries.filter((entry) => !rank.has(idOf(entry)))], moved };
}

/** The task's skill list with the core's top skills first. */
export function advisedSkills<T extends { id: string; name: string }>(runId: string | undefined, entries: readonly T[]): T[] {
  const advice = runId ? board.get(runId) : undefined;
  if (!advice) return [...entries];
  const { list, moved } = toFront(entries, (entry) => entry.id, advice.suggestions.skills.map((s) => s.name));
  safely(advice, "skills", moved.map((entry) => entry.name));
  return list;
}

/** The facts a conversation's snapshot is taken from, with the core's top memories first. */
export function advisedFacts<T extends { id: string }>(sessionId: string | undefined, records: readonly T[]): T[] {
  const advice = sessionId ? adviceForSession(sessionId) : undefined;
  if (!advice) return [...records];
  const { list, moved } = toFront(records, (record) => record.id, advice.suggestions.memories.map((s) => s.name));
  safely(advice, "memories", moved.map((record) => record.id));
  return list;
}

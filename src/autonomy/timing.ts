import { z } from "zod";
import { nextDailyOccurrence } from "../scheduler.js";

/**
 * R17-B: when a standing order or a procedure starts. A clock (every so often, or at a time each
 * day), a task of the owner's finishing (optionally one whose request has certain words), or only
 * when asked. The shortest repeat is five minutes.
 */
const zone = z.string().min(1).max(64).refine((name) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}, "Unknown timezone");

export const StartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("every"), minutes: z.number().int().min(5).max(10080) }).strict(),
  z.object({ kind: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: zone }).strict(),
  z.object({ kind: z.literal("after-task"), words: z.string().trim().max(80).default("") }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);
export type Start = z.infer<typeof StartSchema>;

/** The next moment a clock start is due after `now`; null for the others. */
export function nextDue(start: Start, now: Date): string | null {
  if (start.kind === "every") return new Date(now.getTime() + start.minutes * 60_000).toISOString();
  if (start.kind === "daily") return nextDailyOccurrence(now, start.time, start.timezone).toISOString();
  return null;
}

/** Whether a finished task of the owner's starts this. */
export function startsAfter(start: Start, prompt: string): boolean {
  if (start.kind !== "after-task") return false;
  return !start.words || prompt.toLowerCase().includes(start.words.toLowerCase());
}

/** The start in plain words, for the card. */
export function startWords(start: Start): string {
  if (start.kind === "every") return `every ${start.minutes} minutes`;
  if (start.kind === "daily") return `each day at ${start.time} (${start.timezone})`;
  if (start.kind === "after-task") return start.words ? `after a task about "${start.words}" finishes` : "after any task of yours finishes";
  return "only when you start it";
}

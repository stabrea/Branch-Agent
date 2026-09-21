import { z } from "zod";
import { nextDailyOccurrence } from "../scheduler.js";
import { nextWallOccurrence } from "../recurrence.js";
import { quoteLine } from "./settings.js";

/**
 * R17-014: the catalogue of automations, each a blueprint with blanks ("slots") the owner fills in.
 *
 * A filled blueprint is only a draft of a schedule (the shape `schedules.create` takes). It becomes a
 * real one only when the owner says yes. What the owner typed goes into the prompt as quoted data on
 * one line, filled in one pass, so a value can neither add instructions on a new line nor fill
 * another blank.
 *
 * The idea of blueprints with typed slots, and several of the entries, follow Hermes Agent's
 * `cron/blueprint_catalog.py` (MIT); the catalogue and its wording are written for Branch.
 */
export const slotKinds = ["time", "days", "weekday", "minutes", "text", "url"] as const;
export type SlotKind = (typeof slotKinds)[number];

export interface Slot {
  name: string;
  kind: SlotKind;
  label: string;
  optional?: boolean;
  default?: string;
  /** For "minutes": the least and most. */
  min?: number;
  max?: number;
}

export interface Blueprint {
  id: string;
  title: string;
  description: string;
  /** reminder: a note; task: the assistant does it; check: runs and speaks up only with news. */
  kind: "reminder" | "task" | "check";
  /** daily: at a time on the chosen days; weekly: one day a week; every: every so many minutes. */
  timing: "daily" | "weekly" | "every";
  prompt: string;
  slots: Slot[];
  /** What the task may use, when narrower than what the owner allows. */
  permissions?: string[];
}

const time = (name = "time", fallback = "08:00", label = "At what time (24-hour, HH:MM)"): Slot => ({ name, kind: "time", label, default: fallback });
const days: Slot = { name: "days", kind: "days", label: "Which days (every day or weekdays)", default: "every day" };
const weekday = (fallback: string): Slot => ({ name: "day", kind: "weekday", label: "Which day of the week", default: fallback });
const every = (fallback: number, min: number, max = 1440): Slot => ({ name: "minutes", kind: "minutes", label: "How often, in minutes", default: String(fallback), min, max });
const text = (name: string, label: string, fallback?: string): Slot => ({ name, kind: "text", label, ...(fallback === undefined ? {} : { default: fallback, optional: true }) });

export const BLUEPRINTS: readonly Blueprint[] = [
  { id: "morning-brief", title: "Morning briefing", kind: "task", timing: "daily",
    description: "A short summary each morning of what the day holds.",
    prompt: "Give me a short morning briefing about {topics}. Keep it to a few lines.",
    slots: [time(), days, text("topics", "What to cover", "my calendar, important mail and the weather")] },
  { id: "important-mail", title: "Important-mail watch", kind: "check", timing: "every",
    description: "Looks through new mail every so often and speaks up only when something matters.",
    prompt: "Look through my new mail for {what}. If nothing qualifies, reply with exactly NOTHING_NEW.",
    slots: [every(30, 15), text("what", "What counts as important", "messages from a person that need a reply today")] },
  { id: "weekly-review", title: "Weekly review", kind: "task", timing: "weekly",
    description: "Once a week, what got done and what is still open.",
    prompt: "Write my weekly review: what got done this week, what is still open, and what to start with next week.",
    slots: [weekday("sunday"), time("time", "18:00")] },
  { id: "workday-start", title: "Workday start reminder", kind: "reminder", timing: "daily",
    description: "A note at the start of each workday.",
    prompt: "Workday starts: {note}",
    slots: [time("time", "09:00"), { ...days, default: "weekdays" }, text("note", "What the note says", "look at today's plan")] },
  { id: "custom-reminder", title: "Reminder", kind: "reminder", timing: "daily",
    description: "A note of your own at a time of your choosing.",
    prompt: "Reminder: {note}",
    slots: [text("note", "What to be reminded of"), time(), days] },
  { id: "evening-winddown", title: "Evening wind-down", kind: "task", timing: "daily",
    description: "In the evening, what is left for tomorrow.",
    prompt: "Help me wind down: list what is still open for tomorrow in three lines or fewer.",
    slots: [time("time", "21:00"), days] },
  { id: "news-digest", title: "Topic news digest", kind: "task", timing: "daily",
    description: "The main news about a subject you follow, with sources.",
    prompt: "Find the main news of the last day about {topic} and summarise it in a few lines with sources.",
    slots: [text("topic", "Which subject"), time(), days], permissions: ["web.read"] },
  { id: "bill-renewal-watch", title: "Bills and renewals reminder", kind: "task", timing: "weekly",
    description: "Once a week, bills and subscriptions coming up.",
    prompt: "List the bills, renewals and subscriptions I should know about for the coming week: {what}.",
    slots: [weekday("monday"), time("time", "09:00"), text("what", "Which ones", "anything I have mentioned")] },
  { id: "price-watch", title: "Price and availability watch", kind: "check", timing: "every",
    description: "Checks a page every so often and speaks up when the price or stock changes as you asked.",
    prompt: "Open {url} and check whether {condition}. If not, reply with exactly NOTHING_NEW.",
    slots: [{ name: "url", kind: "url", label: "Which page (https)" }, text("condition", "What to look for", "the price has dropped"), every(360, 60)],
    permissions: ["web.read"] },
  { id: "competitor-watch", title: "Competitor news watch", kind: "task", timing: "weekly",
    description: "Once a week, what a company you follow has announced.",
    prompt: "Find what {company} announced or launched in the last week, with sources, in a few lines.",
    slots: [text("company", "Which company"), weekday("friday"), time("time", "10:00")], permissions: ["web.read"] },
  { id: "habit-checkin", title: "Habit check-in", kind: "reminder", timing: "daily",
    description: "A daily nudge about a habit you are building.",
    prompt: "Habit check-in: did you {habit} today?",
    slots: [text("habit", "Which habit"), time("time", "19:00"), days] },
  { id: "hydration-move", title: "Water and movement nudge", kind: "reminder", timing: "every",
    description: "A nudge every so often to drink water and stand up.",
    prompt: "Time to drink some water and move for a minute.",
    slots: [every(120, 60)] },
  { id: "learn-daily", title: "Learn something each day", kind: "task", timing: "daily",
    description: "One short lesson a day about a subject you are learning.",
    prompt: "Teach me one short, new thing about {subject}, with one question to check I understood.",
    slots: [text("subject", "Which subject"), time(), days] },
];

export function blueprint(id: string): Blueprint {
  const found = BLUEPRINTS.find((entry) => entry.id === id);
  if (!found) throw new Error(`There is no automation called "${quoteLine(id, 60)}" in the catalogue.`);
  return found;
}

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const zone = z.string().min(1).max(64).refine((name) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; } catch { return false; }
}, "Unknown timezone");

function checkSlot(slot: Slot, raw: string): string {
  const value = raw.trim();
  const fail = (why: string): never => { throw new Error(`${slot.label}: ${why}`); };
  if (slot.kind === "time" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail("use 24-hour time, like 08:30.");
  if (slot.kind === "days" && !["every day", "weekdays"].includes(value.toLowerCase())) fail("choose every day or weekdays.");
  if (slot.kind === "weekday" && !weekdays.includes(value.toLowerCase())) fail("name a day of the week in English, like monday.");
  if (slot.kind === "minutes") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < (slot.min ?? 1) || n > (slot.max ?? 1440)) fail(`a whole number from ${slot.min ?? 1} to ${slot.max ?? 1440}.`);
  }
  if (slot.kind === "url") {
    const parsed = URL.canParse(value) ? new URL(value) : null;
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) fail("an https address without a name or password in it.");
  }
  if (slot.kind === "text" && !quoteLine(value, 200)) fail("it cannot be empty.");
  if (slot.kind === "text") return quoteLine(value, 200);
  return slot.kind === "url" ? value : value.toLowerCase();
}

/** Every blank checked: unknown names refused, required ones present, each value of its kind. */
export function fillSlots(entry: Blueprint, values: Record<string, string>): Record<string, string> {
  const unknown = Object.keys(values).filter((name) => !entry.slots.some((slot) => slot.name === name));
  if (unknown.length) throw new Error(`"${entry.title}" has no blank called ${unknown.map((n) => quoteLine(n, 40)).join(", ")}.`);
  const filled: Record<string, string> = {};
  for (const slot of entry.slots) {
    const given = values[slot.name];
    const raw = given !== undefined && given.trim() !== "" ? given : slot.default;
    if (raw === undefined) throw new Error(`"${entry.title}" needs: ${slot.label}.`);
    filled[slot.name] = checkSlot(slot, raw);
  }
  return filled;
}

/** The prompt with its blanks filled once, each value quoted on one line. */
export function renderPrompt(template: string, filled: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) => (name in filled ? `"${filled[name]}"` : whole));
}

const weekdayNumber = (name: string): number =>
  ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(name.toLowerCase());

export interface ScheduleDraft extends Record<string, unknown> {
  prompt: string; dueAt: string; kind: Blueprint["kind"]; daysOff: "run" | "skip";
}

/** A filled blueprint as the input `schedules.create` takes. Nothing is saved here. */
export function draftSchedule(entry: Blueprint, values: Record<string, string>, timezone: string, now: Date,
  deliverTo?: { channel: string; chatId: string }): ScheduleDraft {
  const tz = zone.parse(timezone);
  const filled = fillSlots(entry, values);
  const draft: ScheduleDraft = { prompt: renderPrompt(entry.prompt, filled), kind: entry.kind, dueAt: now.toISOString(), daysOff: "run" };
  if (entry.timing === "every") {
    const ms = Number(filled.minutes) * 60_000;
    Object.assign(draft, { intervalMs: ms, dueAt: new Date(now.getTime() + ms).toISOString() });
  } else if (entry.timing === "daily") {
    Object.assign(draft, { dailyAt: filled.time, timezone: tz, dueAt: nextDailyOccurrence(now, filled.time!, tz).toISOString() });
    if (filled.days === "weekdays") Object.assign(draft, { weekdays: [1, 2, 3, 4, 5], daysOff: "skip" });
  } else {
    const weekday = weekdayNumber(filled.day!);
    const due = nextWallOccurrence(now, filled.time!, tz, (day) => day.weekday === weekday);
    Object.assign(draft, { dailyAt: filled.time, timezone: tz, weekdays: [weekday], dueAt: due.toISOString() });
  }
  if (entry.kind === "check") draft.notify = "changes";
  if (entry.permissions) draft.permissions = [...entry.permissions];
  if (deliverTo) draft.deliverTo = deliverTo;
  return draft;
}

/** The catalogue as a form: each blueprint with its blanks, for the window and for the assistant. */
export function catalogue() {
  return BLUEPRINTS.map(({ id, title, description, kind, timing, slots }) => ({ id, title, description, kind, timing, slots }));
}

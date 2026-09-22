type WallParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };
type CronField = { values: number[]; wildcard: boolean };
type CronParts = { minute: CronField; hour: CronField; monthDay: CronField; month: CronField; weekday: CronField };

function wallParts(at: Date, timezone: string): WallParts {
  const found: Record<string, number> = {};
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  for (const part of format.formatToParts(at)) if (part.type !== "literal") found[part.type] = Number(part.value);
  const year = found.year!, month = found.month!, day = found.day!;
  return { year, month, day, hour: found.hour!, minute: found.minute!, second: found.second!, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/** Converts one wall-clock minute in a named timezone to its UTC instant. */
function wallToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const seen = wallParts(new Date(guess), timezone);
    const actual = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    if (actual === wanted) break;
    guess += wanted - actual;
  }
  return guess;
}

function calendarDay(start: WallParts, offset: number): Pick<WallParts, "year" | "month" | "day" | "weekday"> {
  const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

/** The next chosen wall-clock time on a local day accepted by `dayMatches`. */
export function nextWallOccurrence(after: Date, hhmm: string, timezone: string, dayMatches: (day: Pick<WallParts, "year" | "month" | "day" | "weekday">) => boolean): Date {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const start = wallParts(after, timezone);
  for (let offset = 0; offset <= 370; offset++) {
    const day = calendarDay(start, offset);
    if (!dayMatches(day)) continue;
    const candidate = wallToUtc(day.year, day.month, day.day, hour, minute, timezone);
    if (candidate <= after.getTime()) continue;
    const seen = wallParts(new Date(candidate), timezone);
    /* A spring-forward gap has no such wall time. Skip that local day instead of silently
       moving the job by an hour, so a weekly schedule remains the time the person chose. */
    if (seen.year === day.year && seen.month === day.month && seen.day === day.day && seen.hour === hour && seen.minute === minute)
      return new Date(candidate);
  }
  throw new Error("No matching recurrence was found in the next year");
}

function cronField(source: string, min: number, max: number, sunday = false): CronField {
  if (!source) throw new Error("empty field");
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const [span, stepText, ...extra] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (extra.length || !Number.isInteger(step) || step < 1) throw new Error("invalid step");
    const edges = span === "*" ? [min, max] : span!.split("-").map(Number);
    if (edges.length > 2 || edges.some((value) => !Number.isInteger(value))) throw new Error("invalid range");
    const [from, explicitTo] = edges as [number, number | undefined];
    const to = explicitTo ?? (stepText === undefined ? from : max);
    if (from < min || to > max || from > to) throw new Error("out of range");
    for (let value = from; value <= to; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard: source === "*" };
}

function parseCron(expression: string): CronParts {
  const words = expression.trim().split(/\s+/);
  if (words.length !== 5) throw new Error("five fields required");
  return {
    minute: cronField(words[0]!, 0, 59), hour: cronField(words[1]!, 0, 23),
    monthDay: cronField(words[2]!, 1, 31), month: cronField(words[3]!, 1, 12),
    weekday: cronField(words[4]!, 0, 7, true),
  };
}

export function validCron(expression: string): boolean {
  try { return cronHasCalendarDay(parseCron(expression)); } catch { return false; }
}

function cronDayMatches(cron: CronParts, day: Pick<WallParts, "month" | "day" | "weekday">): boolean {
  if (!cron.month.values.includes(day.month)) return false;
  const date = cron.monthDay.values.includes(day.day), week = cron.weekday.values.includes(day.weekday);
  if (cron.monthDay.wildcard) return week;
  if (cron.weekday.wildcard) return date;
  return date || week;
}

/** A full Gregorian cycle proves that a syntactically valid cron can actually select a day. */
function cronHasCalendarDay(cron: CronParts): boolean {
  for (let year = 2000; year < 2400; year++) {
    for (const month of cron.month.values) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= lastDay; day++) {
        const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        if (cronDayMatches(cron, { month, day, weekday })) return true;
      }
    }
  }
  return false;
}

/** The next instant selected by a numeric five-field cron expression in a named timezone. */
export function nextCronOccurrence(after: Date, expression: string, timezone: string): Date {
  const cron = parseCron(expression), start = wallParts(after, timezone);
  for (let offset = 0; offset <= 366 * 5; offset++) {
    const day = calendarDay(start, offset);
    if (!cronDayMatches(cron, day)) continue;
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const instant = wallToUtc(day.year, day.month, day.day, hour, minute, timezone);
      if (instant <= after.getTime()) continue;
      const seen = wallParts(new Date(instant), timezone);
      if (seen.year === day.year && seen.month === day.month && seen.day === day.day && seen.hour === hour && seen.minute === minute)
        return new Date(instant);
    }
  }
  throw new Error("No cron occurrence was found in the next five years");
}

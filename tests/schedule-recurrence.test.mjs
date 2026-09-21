import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleSchema, nextTurn } from "../dist/scheduler.js";

const base = { prompt: "Send the report", dueAt: "2026-03-06T14:30:00.000Z", kind: "task", timezone: "America/New_York" };

test("weekday repeats keep their local time across daylight-saving changes", () => {
  const schedule = { ...base, dailyAt: "09:30", weekdays: [1] };
  assert.equal(nextTurn(schedule, new Date("2026-03-02T14:30:00.000Z")), "2026-03-09T13:30:00.000Z");
  assert.equal(nextTurn({ ...schedule, weekdays: [1, 2, 3, 4, 5] }, new Date("2026-03-06T14:30:00.000Z")), "2026-03-09T13:30:00.000Z");
});

test("a weekly time missing in the spring-forward gap waits for the next real occurrence", () => {
  const schedule = { ...base, dailyAt: "02:30", weekdays: [0] };
  assert.equal(nextTurn(schedule, new Date("2026-03-01T07:30:00.000Z")), "2026-03-15T06:30:00.000Z");
});

test("monthly repeats skip months without the chosen day and keep wall-clock time", () => {
  const schedule = { ...base, dailyAt: "09:30", monthDay: 31 };
  assert.equal(nextTurn(schedule, new Date("2026-01-31T14:30:00.000Z")), "2026-03-31T13:30:00.000Z");
});

test("five-field cron supports ranges, lists and steps in the chosen timezone", () => {
  assert.equal(nextTurn({ ...base, cron: "30 9 * * 1-5" }, new Date("2026-03-06T14:30:00.000Z")), "2026-03-09T13:30:00.000Z");
  assert.equal(nextTurn({ ...base, cron: "*/15 9,10 * * *" }, new Date("2026-03-09T13:31:00.000Z")), "2026-03-09T13:45:00.000Z");
  assert.equal(nextTurn({ ...base, cron: "10/20 9 * * *" }, new Date("2026-03-09T13:11:00.000Z")), "2026-03-09T13:30:00.000Z");
});

test("the schedule shape rejects ambiguous or incomplete recurrence", () => {
  assert.throws(() => ScheduleSchema.parse({ ...base, weekdays: [1] }), /weekday.*daily time/i);
  assert.throws(() => ScheduleSchema.parse({ ...base, dailyAt: "09:30", weekdays: [1], monthDay: 1 }), /either weekdays or a day of the month/i);
  assert.throws(() => ScheduleSchema.parse({ ...base, dailyAt: "09:30", cron: "30 9 * * 1" }), /one recurrence/i);
  assert.throws(() => ScheduleSchema.parse({ ...base, timezone: undefined, cron: "30 9 * * 1" }), /timezone/i);
  assert.throws(() => ScheduleSchema.parse({ ...base, cron: "99 9 * * 1" }), /cron/i);
  assert.doesNotThrow(() => ScheduleSchema.parse({ ...base, dailyAt: "09:30", weekdays: [1, 3, 5] }));
  assert.doesNotThrow(() => ScheduleSchema.parse({ ...base, cron: "0 8 1 * *" }));
});

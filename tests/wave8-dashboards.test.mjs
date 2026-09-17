/**
 * Wave 8, the parts that are not drawn: the to-do list and the reminder it hands to the schedules,
 * reports in three forms with the same redaction a shared conversation gets, one task's whole
 * trajectory as a page, and the three readings the dashboards were missing — the record with its
 * filters and its saved copy, how busy each connection is, and what asking twice saved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  RequestCounter, Todos, buildReport, cachedAnswers, createBranch, episodeReport, logJsonl,
  readLog, remindAbout, requestAllowances,
} from "../dist/index.js";
import { usageLine } from "../dist/terminal-tui.js";

async function workspace(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-wave8-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("T1 a to-do goes on the list, is ticked off, and comes back off it", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  const made = app.todos.add(owner, { text: "Ring the plumber" });
  assert.equal(made.done, false);
  assert.equal(made.source, "owner");
  assert.deepEqual(app.todos.list(owner).map((one) => one.text), ["Ring the plumber"]);

  const ticked = app.todos.done(owner, made.id);
  assert.equal(ticked.done, true);
  assert.ok(ticked.doneAt, "nothing said when it was finished");
  assert.deepEqual(app.todos.list(owner), [], "a finished item is still open");
  assert.equal(app.todos.list(owner, { includeDone: true }).length, 1);

  app.todos.remove(owner, made.id);
  assert.deepEqual(app.todos.list(owner, { includeDone: true }), []);
  assert.throws(() => app.todos.done(owner, made.id), /nothing on the list/i);
});

test("T1 a to-do with a day on it becomes a reminder in the schedules", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  const dueAt = new Date(Date.now() + 3_600_000).toISOString();
  const item = app.todos.add(owner, { text: "Send the meter reading", dueAt });
  const { scheduleId } = remindAbout(app.scheduler, app.runtime.context({}), item);

  const saved = app.store.list("schedules", owner).find((one) => one.id === scheduleId)?.data;
  assert.ok(saved, "the reminder never reached the schedules");
  assert.equal(saved.kind, "reminder");
  assert.equal(saved.prompt, "Send the meter reading", "the words changed on the way");
  assert.equal(saved.dueAt, dueAt, "the day changed on the way");

  /* An item with no day cannot become a reminder, and says so rather than inventing one. */
  const undated = app.todos.add(owner, { text: "Think about the garden" });
  assert.throws(() => remindAbout(app.scheduler, app.runtime.context({}), undated), /no day on it/i);
});

test("T1 the assistant's plan for a task replaces its own earlier plan, never the owner's items", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  const runId = randomUUID();
  const mine = app.todos.add(owner, { text: "My own line", runId });
  app.todos.setPlan(owner, runId, ["Read the file", "Write the summary"]);
  app.todos.setPlan(owner, runId, ["Read the file", "Write the summary", "Send it"]);

  const open = app.todos.list(owner);
  assert.equal(open.filter((one) => one.source === "assistant").length, 3, "the old plan was left behind");
  assert.ok(open.some((one) => one.id === mine.id), "the owner's own line was thrown away");
});

const REPORT = {
  title: "The quarter so far",
  subtitle: "What the assistant did",
  sections: [
    { heading: "What happened", body: "It read the file. The key was OPENAI_API_KEY=sk-abcdefghijklmnop1234." },
    { heading: "What is left", body: "Nothing." },
  ],
};

test("T2 a report comes out as notes, as a page and laid out for printing", async (t) => {
  const notes = buildReport({ ...REPORT, format: "markdown" });
  assert.equal(notes.contentType, "text/markdown; charset=utf-8");
  assert.match(notes.filename, /\.md$/);
  assert.match(notes.body, /^# The quarter so far/);
  assert.match(notes.body, /## What happened/);

  const page = buildReport({ ...REPORT, format: "html" });
  assert.equal(page.contentType, "text/html; charset=utf-8");
  assert.match(page.body, /<!doctype html>/i);
  assert.match(page.body, /<style>/, "the page does not carry its own colours");
  assert.equal(/<script/i.test(page.body), false, "a report carries a script");

  const print = buildReport({ ...REPORT, format: "print" });
  assert.match(print.body, /@media print/, "the print view has no print rules");
  assert.match(print.body, /Save as PDF/, "the print view never says how to make a PDF");
  assert.match(print.filename, /\.print\.html$/);
});

test("T2 every form of a report has its keys blanked out first", async (t) => {
  for (const format of ["markdown", "html", "print"]) {
    const report = buildReport({ ...REPORT, format });
    assert.equal(/sk-abcdefghijklmnop1234/.test(report.body), false, `the ${format} report carried a key out`);
    assert.ok(report.secretsRemoved >= 1, `the ${format} report blanked nothing out`);
  }
});

test("T2 one task's whole trajectory comes out as a page", async (t) => {
  const app = await workspace(t, { name: "scripted", async complete() { return { content: "All done.", toolCalls: [] }; } });
  const run = await app.runtime.run({ prompt: "tidy the desk" });
  const episode = episodeReport(app.store, app.runtime.owner, run.id);
  assert.match(episode.body, /tidy the desk/);
  assert.match(episode.body, /All done\./);
  assert.match(episode.body, /Step 1 —/, "no step of the task reached the page");
  assert.throws(() => episodeReport(app.store, app.runtime.owner, "00000000-0000-4000-8000-000000000000"),
    /no task with that number/i);
});

test("T3 the record can be narrowed down and saved as one line each", async (t) => {
  const app = await workspace(t, { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });
  const owner = app.runtime.owner;
  const run = await app.runtime.run({ prompt: "count the beans" });

  const all = readLog(app.store, owner, {});
  assert.ok(all.lines.length > 1, "the record is empty after a task");
  assert.ok(all.kinds.includes("model.completed"), "the kinds of step on file were not listed");
  assert.ok(all.lines.every((line) => line.runId === run.id));

  const oneKind = readLog(app.store, owner, { kind: "model.completed" });
  assert.ok(oneKind.lines.length >= 1);
  assert.ok(oneKind.lines.every((line) => line.kind === "model.completed"), "the filter let another kind through");

  const future = readLog(app.store, owner, { since: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual(future.lines, [], "steps from before the cut-off came back");

  const file = logJsonl(oneKind.lines);
  const parsed = file.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(parsed.length, oneKind.lines.length, "the saved file is not one line per step");
  assert.equal(parsed[0].kind, "model.completed");
});

test("T3 the terminal view says what a finished task used", async (t) => {
  const app = await workspace(t, { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });
  const run = await app.runtime.run({ prompt: "count the beans" });
  const line = usageLine(app.store, run);
  assert.ok(line, "the terminal has no token figures to show after a task");
  assert.match(line, /^\[tokens: /);
  assert.match(line, /in,.*out/, "the line says nothing about what went in or came back");
  /* The scripted model reports nothing, so the figures must be named as estimates, not passed off. */
  assert.match(line, /an estimate/);

  /* A task nothing was ever counted for says nothing at all, rather than a row of zeroes. */
  const empty = { ...run, id: "00000000-0000-4000-8000-000000000000" };
  assert.equal(usageLine(app.store, empty), null);
});

test("T3 how busy a connection is sits beside the allowance the service reports", async (t) => {
  let clock = 1_000_000;
  const counter = new RequestCounter(() => clock);
  counter.record("main");
  counter.record("main");
  clock += 120_000;
  counter.record("main");
  const [rate] = counter.rates();
  assert.equal(rate.lastMinute, 1, "calls from two minutes ago still count as this minute");
  assert.equal(rate.lastHour, 3);

  /* The allowance is whatever the service put in its own answer's headers. */
  const health = {
    list: () => [{ id: "main", rateLimit: { limit: 60, remaining: 41, resetSeconds: 12 } }],
  };
  const [row] = requestAllowances(counter, health);
  assert.equal(row.limit, 60);
  assert.equal(row.remaining, 41);
  assert.match(row.summary, /1 in the last minute/);
  assert.match(row.summary, /allows 60, 41 left/);
});

test("T3 an answer that was kept is listed with what it would have cost", async (t) => {
  let asked = 0;
  const app = await workspace(t, {
    name: "scripted",
    async complete() { asked += 1; return { content: "Forty-two.", toolCalls: [] }; },
  });
  const owner = app.runtime.owner;
  app.runtime.requestCache.save?.({ enabled: true });
  app.store.save("settings", owner, "request-cache", { enabled: true, ttlMinutes: 60, maxEntries: 500 });

  await app.runtime.run({ prompt: "what is six times seven" });
  await app.runtime.run({ prompt: "what is six times seven" });
  assert.equal(asked, 1, "the second ask went out to the model anyway, so there is nothing to price");

  const kept = cachedAnswers(app.store, owner);
  assert.ok(kept.lines.length >= 1, "no kept answer was listed");
  assert.ok(kept.lines[0].savedInput > 0, "the kept answer says nothing about what it would have sent");
  assert.ok(kept.lines[0].savedOutput > 0, "the kept answer says nothing about what would have come back");
  assert.match(kept.lines[0].reason, /answered before/i);
});

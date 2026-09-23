/* Q51: a task says what it is really doing, from its own recorded events and nothing else: working, waiting for
   the owner, waiting for a service or blocked, with the event's own words as the reason and the time it last
   recorded anything. It goes quiet ("no update for N min") when a working task records nothing for longer than a
   model or a tool may take. A task that stopped to ask stays in view until answered; the count of busy tasks does
   not grow. No percentage anywhere. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { runActivity, staleAfterMs, taskState } from "../dist/activity.js";
import { createBranch, saveKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const T0 = Date.parse("2026-09-23T12:00:00.000Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const run = (status = "running") => ({ id: "r1", sessionId: "s1", prompt: "Tidy the folder", status, createdAt: at(0), updatedAt: at(0) });
let next = 0;
const ev = (seconds, kind, data = {}) => ({ id: `e${next++}`, runId: "r1", kind, data, createdAt: at(seconds) });
const state = (status, events, now = 10) => {
  const { state: name, why, reason, stale, until } = taskState(run(status), events, { now: T0 + now * 1000, staleMs: 90_000 });
  return { state: name, why, reason, stale, ...(until ? { until } : {}) };
};

test("Q51 working, from the model and tool events, with no reason made up", () => {
  assert.deepEqual(state("running", [ev(0, "run.started"), ev(1, "model.started"), ev(2, "tool.started", { name: "files.read", id: "t1", label: "Reading a.txt" })]),
    { state: "working", why: "tool.started", reason: "", stale: false });
});

test("Q51 a task that stopped to ask waits for the owner, with the question it asked", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "files.delete", id: "t1" }), ev(2, "policy.ask", { name: "files.delete", id: "t1", question: "Delete old.txt?" })];
  assert.deepEqual(state("needs_input", events), { state: "waiting-owner", why: "policy.ask", reason: "Delete old.txt?", stale: false });
  /* A plan waiting for an OK while the task still runs waits for the owner too. */
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "plan.awaiting_approval", { steps: ["a", "b"] })]).state, "waiting-owner");
  /* Branch closed on it and it can go on: still the owner's to answer. */
  assert.deepEqual(state("needs_input", [ev(0, "run.started"), ev(1, "run.can_continue", { note: "Branch closed during step 2" })]),
    { state: "waiting-owner", why: "run.can_continue", reason: "Branch closed during step 2", stale: false });
  /* However long the owner takes, a question is never "stale". */
  assert.equal(state("needs_input", events, 3600).stale, false);
});

test("Q51 a service wait says what it waits for and until when, and ends when work goes on", () => {
  const paused = [ev(0, "run.started"), ev(1, "rate.paused", { kind: "round", waitMs: 30_000, message: "Waiting for the next minute of requests" })];
  assert.deepEqual(state("running", paused),
    { state: "waiting-service", why: "rate.paused", reason: "Waiting for the next minute of requests", stale: false, until: at(31) });
  assert.equal(state("running", [...paused, ev(31, "rate.resumed", {})]).state, "working", "resumed is working again");
  const retry = state("running", [ev(0, "run.started"), ev(2, "model.retry_scheduled", { attempt: 1, maxRetries: 3, delayMs: 4000, status: 529, provider: "anthropic" })]);
  assert.deepEqual(retry, { state: "waiting-service", why: "model.retry_scheduled", reason: "anthropic", stale: false, until: at(6) });
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "model.loading", { waitSeconds: 20, message: "Loading the model" })]).why, "model.loading");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "context.compacting", {})]).state, "waiting-service");
});

test("Q51 a refusal blocks the task until anything moves on, and a failed tool is not a block", () => {
  const denied = [ev(0, "run.started"), ev(1, "policy.denied", { name: "shell.execute", id: "t1", reason: "Lockdown is on" })];
  assert.deepEqual(state("running", denied), { state: "blocked", why: "policy.denied", reason: "Lockdown is on", stale: false });
  assert.equal(state("running", [...denied, ev(2, "model.started")]).state, "working", "the model took the refusal and went on");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "provider.refused", { error: "Credit exhausted" })]).reason, "Credit exhausted");
  /* A tool that failed is a result the model works with, not a wall. */
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "tool.started", { name: "web.fetch", id: "t1" }), ev(2, "tool.failed", { name: "web.fetch", id: "t1", error: "404" })]).state, "working");
});

test("Q51 a working task that records nothing for longer than a model or a tool may take has gone quiet", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "shell.execute", id: "t1" })];
  assert.equal(state("running", events, 60).stale, false, "a minute in is not quiet");
  assert.equal(state("running", events, 300).stale, true, "four minutes with nothing is");
  assert.equal(state("running", [ev(0, "run.started"), ev(1, "policy.denied", { reason: "no" })], 3600).stale, false, "a block is not quiet, it is blocked");
  assert.equal(taskState(run(), events, { now: T0 + 300_000, staleMs: 90_000 }).lastUpdate, at(1), "the last update is the last event's time");
});

test("Q51 the same step reported twice is one step, and a finished task is finished", () => {
  const events = [ev(0, "run.started"), ev(1, "tool.started", { name: "files.read", id: "t1", label: "Reading a.txt" }),
    ev(2, "tool.completed", { name: "files.read", id: "t1" }), ev(3, "tool.completed", { name: "files.read", id: "t1" })];
  const activity = runActivity(run(), events, { now: T0 + 5000, staleMs: 90_000 });
  assert.deepEqual(activity.steps.map((step) => [step.label, step.status]), [["Reading a.txt", "done"]]);
  assert.equal(activity.task.state, "working");
  for (const status of ["completed", "failed", "cancelled", "budget_exceeded"])
    assert.equal(taskState(run(status), events).state, "finished", status);
  assert.equal(JSON.stringify(activity).includes("percent"), false, "nothing says how much is left");
});

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-states-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  const owner = app.runtime.owner;
  /* A conversation whose newest task stopped to ask; an older one of its tasks that asked too; and one that is working. */
  const older = app.store.createRun(owner, "Rename the photos");
  app.store.event(older.id, "policy.ask", { name: "files.move", id: "t0", question: "Move 40 photos?" });
  app.store.finish(older.id, "needs_input", "");
  const asking = app.store.createRun(owner, "Rename the photos again", older.sessionId);
  app.store.event(asking.id, "policy.ask", { name: "files.move", id: "t1", question: "Move 41 photos?" });
  app.store.finish(asking.id, "needs_input", "");
  const working = app.store.createRun(owner, "Summarise the notes");
  app.store.event(working.id, "tool.started", { name: "files.read", id: "t2", label: "Reading notes.md" });
  return { app, server, call, older, asking, working };
}

test("Q51 the task list shows the one that waits for you; the busy count and other screens do not grow", async (t) => {
  const { call, older, asking, working } = await branch(t);
  const busy = await call("/api/activity");
  assert.deepEqual(busy.map((one) => one.runId), [working.id], "by default, running tasks only, as the busy count reads them");
  assert.equal(busy[0].task.state, "working");
  const all = await call("/api/activity?waiting=1");
  assert.deepEqual(all.map((one) => one.runId).sort(), [asking.id, working.id].sort(), "the older question a later task moved past is not listed");
  const waiting = all.find((one) => one.runId === asking.id);
  assert.deepEqual([waiting.task.state, waiting.task.why, waiting.task.reason], ["waiting-owner", "policy.ask", "Move 41 photos?"]);
  assert.equal(all.some((one) => one.runId === older.id), false);
});

test("Q51 the Activity pane reads the state in words, with no moving bar for a task that waits", async (t) => {
  const { server, asking } = await branch(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  /* The pane's own task list, as drawn: open the pane and read its rows. */
  await page.evaluate(async () => {
    const { applyAppearance, currentAppearance } = await import("/appearance.js");
    applyAppearance({ ...currentAppearance(), showEverything: true });
  });
  await page.locator("#aside-toggle").click();
  await page.waitForFunction(() => document.body.classList.contains("lx-aside"));
  await page.locator('#context-tasks [data-task-state="waiting-owner"]').waitFor({ state: "attached", timeout: 15000 });
  const rows = await page.evaluate(() => [...document.querySelectorAll("#context-tasks [data-task-state]")].map((row) => ({
    state: row.dataset.taskState, text: row.textContent, bar: !!row.querySelector(".progress"), when: row.querySelector(".task-when")?.textContent ?? "" })));
  const waiting = rows.find((row) => row.state === "waiting-owner"), busy = rows.find((row) => row.state === "working");
  assert.ok(waiting.text.includes("Waiting for your answer: Move 41 photos?"), waiting.text);
  assert.match(waiting.when, /^Updated \d+ (s|min) ago$/);
  assert.equal(waiting.bar, false, "no moving bar for a task that waits");
  assert.ok(busy.text.includes("Reading notes.md") && busy.bar, "a working task keeps its step and its bar");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const french = await page.evaluate(async (id) => {
    const { taskWords } = await import("/task-state.js");
    const response = await fetch("/api/activity?waiting=1", { headers: { authorization: `Bearer ${sessionStorage.getItem("branch-token")}` } });
    return taskWords((await response.json()).find((item) => item.runId === id).task);
  }, asking.id);
  assert.equal(french, "En attente de votre réponse : Move 41 photos?", "French puts a space before the colon");
  assert.deepEqual(errors, []);
});

/** A model that answers from a script, so a real task runs through the real runtime. */
function scripted(steps) {
  return { name: "scripted", async complete() { return steps.shift() ?? { content: "Done.", toolCalls: [] }; } };
}
async function realBranch(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-states-real-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  return { app, call };
}

test("Q51 a real task that asks the owner a question is listed as waiting for you, with that question", async (t) => {
  const { app, call } = await realBranch(t, [
    { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which folder should I clean, Downloads or Desktop?" }) }] },
  ]);
  const run = await app.runtime.run({ prompt: "clean up my files" });
  assert.equal(run.status, "needs_input");
  const listed = (await call("/api/activity?waiting=1")).find((one) => one.runId === run.id);
  assert.deepEqual([listed.task.state, listed.task.why, listed.task.reason],
    ["waiting-owner", "attention.needed", "Which folder should I clean, Downloads or Desktop?"]);
  /* The same set "Needs you" lists. */
  assert.deepEqual((await call("/api/state")).attention.map((one) => one.runId), [run.id]);
  /* Answered, it is no longer waiting. */
  await app.runtime.run({ prompt: "Downloads", sessionId: run.sessionId });
  assert.equal((await call("/api/activity?waiting=1")).some((one) => one.sessionId === run.sessionId), false);
});

test("Q51 a real refusal reads as blocked only until the model takes it and goes on", async (t) => {
  const { app, call } = await realBranch(t, [
    { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "hello" }) }] },
    { content: "I may not write files here, so I stopped.", toolCalls: [] },
  ]);
  await call("/api/policy", { preset: "read-only" });
  const run = await app.runtime.run({ prompt: "write a note" });
  const events = app.store.events(run.id);
  const denied = events.findIndex((event) => event.kind === "policy.denied");
  assert.ok(denied >= 0, `the write was refused (${events.map((event) => event.kind).join(", ")})`);
  /* At the moment of the refusal the task is blocked, with the refusal's own words... */
  const then = taskState({ ...run, status: "running" }, events.slice(0, denied + 1));
  assert.equal(then.state, "blocked");
  assert.equal(then.why, "policy.denied");
  /* ...and the next thing it records is the model taking it: from there it works again. */
  const after = events.slice(denied + 1).find((event) => ["model.started", "tool.started"].includes(event.kind));
  assert.ok(after, "the model went on after the refusal");
  assert.equal(taskState({ ...run, status: "running" }, events.slice(0, events.indexOf(after) + 1)).state, "working");
  t.diagnostic(`blocked for ${Date.parse(after.createdAt) - Date.parse(events[denied].createdAt)} ms before the model went on`);
});

test("Q51 a question still unanswered stays listed however much other work finishes after it", async (t) => {
  const { app, call, asking } = await branch(t);
  const owner = app.runtime.owner;
  for (let i = 0; i < 105; i++) app.store.finish(app.store.createRun(owner, `Other task ${i}`).id, "completed", "done");
  assert.equal(app.store.runs(owner).some((run) => run.id === asking.id), false, "it is past the recent-history window");
  assert.ok((await call("/api/activity?waiting=1")).some((one) => one.runId === asking.id), "and still waiting for you");
});

test("Q51 a task Branch closed on, which can be continued, is listed as waiting for you to continue", async (t) => {
  const { app, call } = await branch(t);
  const closed = app.store.createRun(app.runtime.owner, "Sort the invoices");
  app.store.event(closed.id, "run.can_continue", { note: "Branch closed during step 2" });
  app.store.finish(closed.id, "interrupted", "");
  const listed = (await call("/api/activity?waiting=1")).find((one) => one.runId === closed.id);
  assert.deepEqual([listed?.task.state, listed?.task.why, listed?.task.reason], ["waiting-owner", "run.can_continue", "Branch closed during step 2"]);
  assert.equal((await call("/api/activity")).some((one) => one.runId === closed.id), false, "not counted as busy");
});

test("Q51 'no update' waits as long as the owner's own limits allow a silence", async (t) => {
  const { app, call, working } = await branch(t);
  /* A tool eight minutes into the ten minutes the owner allows has not gone quiet, on screen either. The store stamps
     events with the time they happen, so the test moves this one back (a disposable store). */
  app.store.db.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(new Date(Date.now() - 8 * 60_000).toISOString(), working.id);
  const quiet = async () => (await call("/api/activity")).find((one) => one.runId === working.id).task.stale;
  assert.equal(await quiet(), true, "past the built-in limits, it has gone quiet");
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: 600 });
  assert.equal(await quiet(), false, "inside the limit the owner set, it has not");
  saveKnobs(app.store, app.runtime.owner, "commands", { toolTimeoutSeconds: null });
  const owner = app.runtime.owner, limits = app.runtime.reliability;
  const base = staleAfterMs(app.store, owner, limits);
  assert.ok(base >= limits.modelStallMs && base >= limits.toolTimeoutMs && base >= limits.localFirstReplyMs, `${base} covers every built-in limit`);
  saveKnobs(app.store, owner, "commands", { toolTimeoutSeconds: 600 });
  assert.equal(staleAfterMs(app.store, owner, limits) >= 600_000, true, "a longer tool limit the owner set");
  saveKnobs(app.store, owner, "limits", { localFirstReplySeconds: 1800 });
  assert.equal(staleAfterMs(app.store, owner, limits), 1_800_000 + 30_000, "a model on this computer starting its reply, with its grace");
});

test("Q58 a queued task shows it is waiting its turn, with position and what it waits behind", async (t) => {
  const { app, call, working } = await branch(t);
  const owner = app.runtime.owner;
  const sessionId = working.sessionId;
  // Prevent drain by marking the session as active
  app.runtime.activeSessions.add(sessionId);
  // Queue two messages while the conversation is busy (it has a working task)
  const q1 = app.runtime.followUp(sessionId, "First queued message");
  const q2 = app.runtime.followUp(sessionId, "Second queued message");
  assert.equal(q1.position, 1, "first queued message is at position 1");
  assert.equal(q2.position, 2, "second queued message is at position 2");
  // Remove active marker for clean state
  app.runtime.activeSessions.delete(sessionId);
  // Check the activity list with waiting=1 includes queued tasks
  const activity = await call("/api/activity?waiting=1");
  const queued = activity.filter((one) => one.task?.state === "queued");
  assert.equal(queued.length, 2, "both queued messages are listed");
  const first = queued[0];
  assert.equal(first.prompt, "First queued message");
  assert.equal(first.task.position, 1);
  assert.ok(first.task.waitingBehind, "shows what it waits behind");
  const second = queued[1];
  assert.equal(second.prompt, "Second queued message");
  assert.equal(second.task.position, 2);
  assert.ok(second.task.waitingBehind.includes("First queued"), "waits behind the first queued message");
});

test("Q58 when a queued task is cancelled, others move up in the queue", async (t) => {
  const { app, call, working } = await branch(t);
  const owner = app.runtime.owner;
  const sessionId = working.sessionId;
  // Prevent drain by marking the session as active
  app.runtime.activeSessions.add(sessionId);
  // Queue three messages
  const q1 = app.runtime.followUp(sessionId, "Message 1");
  const q2 = app.runtime.followUp(sessionId, "Message 2");
  const q3 = app.runtime.followUp(sessionId, "Message 3");
  assert.equal(q1.position, 1);
  assert.equal(q2.position, 2);
  assert.equal(q3.position, 3);
  // Simulate cancelling the first queued message by removing it from storage
  const queued = app.runtime.queued(sessionId);
  assert.equal(queued.length, 3);
  app.store.save("settings", owner, `followups:${sessionId}`, { items: queued.slice(1) });
  // Remove active marker for clean state
  app.runtime.activeSessions.delete(sessionId);
  // Check positions updated
  const activity = await call("/api/activity?waiting=1");
  const remaining = activity.filter((one) => one.task?.state === "queued");
  assert.equal(remaining.length, 2, "one was cancelled");
  assert.equal(remaining[0].task.position, 1, "second became first");
  assert.equal(remaining[1].task.position, 2, "third became second");
});

test("Q58 a queued task shows when it was queued in lastUpdate", async (t) => {
  const { app, call, working } = await branch(t);
  const owner = app.runtime.owner;
  const sessionId = working.sessionId;
  // Prevent drain by marking the session as active
  app.runtime.activeSessions.add(sessionId);
  const before = new Date().toISOString();
  const q = app.runtime.followUp(sessionId, "Queued now");
  const after = new Date().toISOString();
  // Remove active marker for clean state
  app.runtime.activeSessions.delete(sessionId);
  const activity = await call("/api/activity?waiting=1");
  const queued = activity.find((one) => one.task?.state === "queued");
  assert.ok(queued?.task?.lastUpdate, "has a lastUpdate");
  assert.ok(Date.parse(queued.task.lastUpdate) >= Date.parse(before), "lastUpdate is after queue time");
  assert.ok(Date.parse(queued.task.lastUpdate) <= Date.parse(after), "lastUpdate is before now");
});

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
import { runActivity, taskState } from "../dist/activity.js";
import { createBranch } from "../dist/index.js";
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
  assert.equal(french, "En attente de votre réponse: Move 41 photos?");
  assert.deepEqual(errors, []);
});

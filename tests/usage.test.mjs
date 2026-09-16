import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UsageStore } from "../dist/usage.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-usage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, "test.db");
  return { root, dbPath };
}

function setupDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'web');
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE usage(run_id TEXT PRIMARY KEY REFERENCES tasks(id), estimated_input INTEGER NOT NULL DEFAULT 0, estimated_output INTEGER NOT NULL DEFAULT 0, reported_input INTEGER NOT NULL DEFAULT 0, reported_output INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, unreported_calls INTEGER NOT NULL DEFAULT 0, incomplete_calls INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

test("aggregateUsage: calculates daily totals from runs and events", async (t) => {
  const { dbPath } = await fixture(t);
  const db = setupDatabase(dbPath);

  const sessionId = "11111111-1111-1111-1111-111111111111";
  const runId = "22222222-2222-2222-2222-222222222222";
  const now = new Date().toISOString();

  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sessionId, "owner1", now);
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run(runId, sessionId, "owner1", "test", "completed", "result", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run(runId, 100, 50, 100, 50, 1, 1, 0, 0);
  db.prepare("INSERT INTO events VALUES(NULL,?,?,?,?)").run(runId, "tool.completed", JSON.stringify({ id: "tool1", name: "test" }), now);
  db.prepare("INSERT INTO events VALUES(NULL,?,?,?,?)").run(runId, "model.completed", JSON.stringify({ preset: "test-preset", provider: "demo", model: "test" }), now);

  const usage = new UsageStore(db);
  const result = usage.aggregateUsage("30d", "day");

  assert.equal(result.length, 1);
  assert.equal(result[0].runs, 1);
  assert.equal(result[0].toolCalls, 1);
  assert.equal(result[0].tokens.input, 100);
  assert.equal(result[0].tokens.output, 50);

  db.close();
});

test("getRunTimeline: builds ordered timeline from events", async (t) => {
  const { dbPath } = await fixture(t);
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  `);

  const runId = "test-run-id";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(runId, "session", "owner", "test", "completed", "", now, now);

  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(runId, "model.started", JSON.stringify({ preset: "test", provider: "demo", model: "gpt" }), now);
  const nextTime = new Date(new Date(now).getTime() + 1000).toISOString();
  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(runId, "model.completed", JSON.stringify({ preset: "test", provider: "demo", model: "gpt" }), nextTime);

  const usage = new UsageStore(db);
  const timeline = usage.getRunTimeline("test-run-id");

  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].type, "model.completed");
  assert.equal(timeline[0].duration, 1); // 1 second

  db.close();
});

test("timeline includes tool calls, retries, and stalls", async (t) => {
  const { dbPath } = await fixture(t);
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  `);

  const runId = "test-run";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)").run(runId, "session", "owner", "test", "completed", "", now, now);

  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(runId, "tool.started", JSON.stringify({ id: "tool1", name: "file.read" }), now);
  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(
    runId,
    "tool.completed",
    JSON.stringify({ id: "tool1", name: "file.read" }),
    new Date(new Date(now).getTime() + 500).toISOString()
  );
  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(runId, "model.retry_scheduled", JSON.stringify({ attempt: 1, afterMs: 250 }), new Date(new Date(now).getTime() + 1000).toISOString());
  db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)").run(
    runId,
    "model.stall_recovery",
    JSON.stringify({ action: "retry", stalls: 1, afterMs: 300 }),
    new Date(new Date(now).getTime() + 2000).toISOString()
  );

  const usage = new UsageStore(db);
  const timeline = usage.getRunTimeline("test-run");

  const kinds = timeline.map((e) => e.type);
  assert(kinds.includes("tool.completed"));
  assert(kinds.includes("retry"));
  assert(kinds.includes("stall"));

  // Find tool call and check duration
  const toolEvent = timeline.find((e) => e.type === "tool.completed" && e.title.includes("file.read"));
  assert(toolEvent);
  assert.equal(toolEvent.duration, 1); // 500ms = 0.5s rounds to 1

  db.close();
});

test("aggregateUsage only includes terminal runs", async (t) => {
  const { dbPath } = await fixture(t);
  const db = setupDatabase(dbPath);

  const sessionId = "sess1";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sessionId, "owner", now);

  // Add a running run (should be excluded)
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run-running", sessionId, "owner", "test", "running", "", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run-running", 100, 50, 0, 0, 0, 1, 0, 0);

  // Add a completed run (should be included)
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run-complete", sessionId, "owner", "test", "completed", "result", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run-complete", 100, 50, 100, 50, 1, 1, 0, 0);

  const usage = new UsageStore(db);
  const result = usage.aggregateUsage("30d", "day");

  // Should only aggregate the completed run
  assert.equal(result.length, 1);
  assert.equal(result[0].runs, 1);
  assert.equal(result[0].tokens.input, 100);

  db.close();
});

test("aggregateUsage uses reported tokens when available", async (t) => {
  const { dbPath } = await fixture(t);
  const db = setupDatabase(dbPath);

  const sessionId = "sess1";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sessionId, "owner", now);

  // Run with both estimated and reported (should use reported)
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run1", sessionId, "owner", "test", "completed", "", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run1", 1000, 500, 950, 480, 1, 1, 0, 0);

  // Run with only estimated (should use estimated)
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run2", sessionId, "owner", "test", "completed", "", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run2", 1000, 500, 0, 0, 0, 1, 0, 0);

  const usage = new UsageStore(db);
  const result = usage.aggregateUsage("30d", "day");

  // Total should be reported from run1 + estimated from run2
  assert.equal(result[0].tokens.input, 950 + 1000);
  assert.equal(result[0].tokens.output, 480 + 500);

  db.close();
});

test("aggregateUsage tracks by source", async (t) => {
  const { dbPath } = await fixture(t);
  const db = setupDatabase(dbPath);

  const sessionId = "sess1";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sessionId, "owner", now);

  // Web run
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run1", sessionId, "owner", "test", "completed", "", now, now, "web");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run1", 100, 50, 100, 50, 1, 1, 0, 0);

  // Telegram run
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run("run2", sessionId, "owner", "test", "completed", "", now, now, "telegram");
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run("run2", 100, 50, 100, 50, 1, 1, 0, 0);

  const usage = new UsageStore(db);
  const result = usage.aggregateUsage("30d", "day");

  assert.equal(result[0].byChannel.length, 2);
  const webSource = result[0].byChannel.find((s) => s.source === "web");
  const tgSource = result[0].byChannel.find((s) => s.source === "telegram");
  assert(webSource);
  assert(tgSource);
  assert.equal(webSource.runs, 1);
  assert.equal(tgSource.runs, 1);

  db.close();
});

test("getMonthlyStats: calculates usage with budget warning", async (t) => {
  const { dbPath } = await fixture(t);
  const db = setupDatabase(dbPath);

  const sessionId = "sess1";
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(sessionId, "owner", now);

  // Add runs that total 800 tokens
  for (let i = 0; i < 8; i++) {
    const runId = `run${i}`;
    db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run(runId, sessionId, "owner", "test", "completed", "", now, now, "web");
    db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run(runId, 100, 0, 100, 0, 1, 1, 0, 0);
  }

  const usage = new UsageStore(db);
  const stats = usage.getMonthlyStats(1000);

  assert.equal(stats.currentMonthlyTokens, 800);
  assert.equal(stats.budgetAlert80Percent, true); // 800 >= 1000 * 0.8

  const statsNoBudget = usage.getMonthlyStats();
  assert.equal(statsNoBudget.budgetAlert80Percent, false);

  db.close();
});

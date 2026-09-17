/**
 * Never breaks, threats 3, 4 and 5: the task journal, carrying interrupted work on after a restart,
 * chat messages and timed jobs missed while Branch was down, and data formats with a way back.
 * Temporary folders and processes this file starts itself only; fake chat service, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter, Scheduler } from "../dist/index.js";
import { effectsOf, idempotencyKey, evidenceFor, checkEvidence, gitHead, TaskJournal } from "../dist/never-break/journal.js";
import { migrate, migrateDown, formatOf, DataTooNewError } from "../dist/never-break/migrations.js";
import { recoverAfterRestart, lateNote, releaseInterruptedSchedules } from "../dist/never-break/resume.js";
import { channelPosition } from "../dist/never-break/channel-position.js";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-journal-"));
  t.after(() => discardTemp(root));
  return root;
}
const say = (content) => ({ content, toolCalls: [] });
function scripted(replies) {
  let index = 0;
  return { name: "scripted", async complete() { return replies[Math.min(index++, replies.length - 1)]; } };
}

/* ---------- pure pieces ---------- */

test("each call is classed by what it can do, and keyed so a repeat is recognised", async (t) => {
  assert.equal(effectsOf("files.read", "files.read"), "none");
  assert.equal(effectsOf("git.status", "git.read"), "none");
  assert.equal(effectsOf("files.write", "files.write"), "idempotent");
  assert.equal(effectsOf("email.send", "email.send"), "external");
  assert.equal(effectsOf("mcp.someone.tool", "mcp.call"), "external", "anything unknown is treated as reaching outside");
  const call = { id: "c1", name: "files.write", arguments: "{\"path\":\"a\"}" };
  assert.equal(idempotencyKey("r1", call), idempotencyKey("r1", { ...call }));
  assert.notEqual(idempotencyKey("r1", call), idempotencyKey("r2", call));

  const root = await temp(t);
  const written = await evidenceFor("files.write", { path: "a.txt", content: "hello" }, root);
  assert.deepEqual(written, { kind: "file", path: join(root, "a.txt"), before: null, intended: sha("hello") });
  assert.equal(await checkEvidence(written), "not-done");
  await writeFile(join(root, "a.txt"), "hello");
  assert.equal(await checkEvidence(written), "done");
  const edited = await evidenceFor("files.edit", { path: "a.txt" }, root);
  assert.equal(await checkEvidence(edited), "not-done", "unchanged since just before the edit");
  await writeFile(join(root, "a.txt"), "hello there");
  assert.equal(await checkEvidence(edited), "done");
  assert.equal(await evidenceFor("files.write", { path: "../outside.txt", content: "x" }, root), null);
  assert.equal(await checkEvidence(null), "unknown");

  await mkdir(join(root, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, ".git", "packed-refs"), "# pack\naaaa refs/heads/main\n");
  assert.equal(await gitHead(root), "aaaa");
  const commit = await evidenceFor("git.commit", {}, root);
  await writeFile(join(root, ".git", "refs", "heads", "main"), "bbbb\n");
  assert.equal(await checkEvidence(commit), "done", "the branch moved on: the commit happened");
});

test("a missed timed job says why it is late", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  assert.equal(lateNote("2026-09-17T11:59:30Z", now), null);
  assert.match(lateNote("2026-09-17T11:30:00Z", now), /due 30 minutes ago, while Branch was not running, so it ran once now/);
  assert.match(lateNote("2026-09-17T07:00:00Z", now), /due 5 hours ago/);
});

/* ---------- data formats ---------- */

test("formats move forward on a copy, have a way back, and newer data is refused untouched", async (t) => {
  const root = await temp(t);
  const db = new DatabaseSync(join(root, "a.sqlite"));
  t.after(() => db.close());
  const steps = [
    { version: 1, readableBy: 1, up: (d) => d.exec("CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT)"), down: (d) => d.exec("DROP TABLE notes") },
    { version: 2, readableBy: 1, up: (d) => d.exec("ALTER TABLE notes ADD COLUMN tag TEXT"), down: (d) => d.exec("ALTER TABLE notes DROP COLUMN tag") },
  ];
  assert.deepEqual(migrate(db, steps.slice(0, 1), { backupTo: join(root, "b1.sqlite") }), { from: 0, to: 1, backup: null });
  db.exec("INSERT INTO notes(text) VALUES('kept')");
  const up = migrate(db, steps, { backupTo: join(root, "b2.sqlite") });
  assert.deepEqual(up, { from: 1, to: 2, backup: join(root, "b2.sqlite") });
  const copy = new DatabaseSync(join(root, "b2.sqlite"));
  assert.equal(formatOf(copy).version, 1, "the copy is the data as it was before the change");
  copy.close();
  assert.deepEqual(formatOf(db), { version: 2, readableBy: 1 });
  // The previous release (format 1) can still open format 2: it only added a column.
  assert.equal(migrate(db, steps.slice(0, 1), { backupTo: null }).to, 2);
  migrateDown(db, steps, 1);
  assert.equal(formatOf(db).version, 1);
  assert.deepEqual(db.prepare("SELECT * FROM notes").all().map((r) => ({ ...r })), [{ id: 1, text: "kept" }], "the way back keeps the work");
  const failing = [...steps, { version: 3, readableBy: 3, up: (d) => { d.exec("CREATE TABLE half(x)"); throw new Error("boom"); }, down: () => undefined }];
  assert.throws(() => migrate(db, failing, { backupTo: null }), /boom/);
  assert.equal(formatOf(db).version, 1, "a change that fails part-way leaves nothing behind");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='half'").get(), undefined);
  db.exec("PRAGMA user_version=3; UPDATE branch_format SET version=3, readable_by=3");
  assert.throws(() => migrate(db, steps, { backupTo: null }), (error) => error instanceof DataTooNewError && /newer version of Branch/.test(error.message));
});

test("Branch refuses to open saved work from a version it cannot read, and stamps its own", async (t) => {
  const root = await temp(t);
  const options = { workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("hi")]) };
  const first = await createBranch(options);
  assert.deepEqual(formatOf(first.store.sqlite), { version: 1, readableBy: 1 });
  first.store.sqlite.exec("PRAGMA user_version=7; UPDATE branch_format SET version=7, readable_by=1");
  await first.close();
  const tolerant = await createBranch(options);
  await tolerant.close();
  const db = new DatabaseSync(join(root, "d", "branch.sqlite"));
  db.exec("UPDATE branch_format SET readable_by=7");
  db.close();
  await assert.rejects(createBranch(options), /last opened by a newer version of Branch/);
  const again = new DatabaseSync(join(root, "d", "branch.sqlite"));
  assert.equal(formatOf(again).version, 7, "nothing was changed");
  again.close();
});

/* ---------- the journal in a running task ---------- */

test("every turn and tool call is written down, flushed, before it runs", async (t) => {
  const root = await temp(t);
  const call = { id: "w1", name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "one" }) };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([{ content: "", toolCalls: [call] }, say("done")]) });
  t.after(() => app.close());
  const run = await app.runtime.run({ prompt: "write it", onTextDelta: () => undefined });
  assert.equal(run.status, "completed");
  assert.deepEqual(app.neverBreak.journal.steps(run.id), [
    { kind: "turn", tool: "round 1", state: "finished", effects: null },
    { kind: "tool", tool: "files.write", state: "finished", effects: "idempotent" },
    { kind: "turn", tool: "round 2", state: "finished", effects: null },
  ]);
});

test("a step that cannot be written down is not done, and the task says why", async (t) => {
  const root = await temp(t);
  let sent = 0;
  const call = { id: "s1", name: "chaos.send", arguments: "{}" };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([{ content: "", toolCalls: [call] }, say("done")]) });
  t.after(() => app.close());
  app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "send", parameters: z.object({}).strict(), execute: async () => { sent++; return {}; } });
  app.neverBreak.journal.failWrites = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  const run = await app.runtime.run({ prompt: "send it", onTextDelta: () => undefined });
  assert.equal(sent, 0, "nothing was sent that could not be recorded");
  assert.equal(run.status, "failed");
  assert.match(run.output, /could not write this step down.*ENOSPC.*disk may be full/);
  app.neverBreak.journal.failWrites = null;
  assert.equal((await app.runtime.run({ prompt: "and now", onTextDelta: () => undefined })).status, "completed", "the next task works once there is room");
});

/* ---------- killed mid-step, started again ---------- */

async function killedMidStep(t, plan, { mode = "on", waitFor }) {
  const root = await temp(t);
  await mkdir(join(root, "data"), { recursive: true });
  await saveGatewayConfig(join(root, "data"), GatewayConfigSchema.parse({ mode }));
  const env = { ...cleanEnv(), CHAOS_PLAN: JSON.stringify(plan), CHAOS_DELAY: "60000" };
  const script = resolve("tests/fixtures/never-break-task.mjs");
  const worker = spawn(process.execPath, [script, root, "work"], { env, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
  for (let i = 0; i < 1200; i++) {
    const calls = await readFile(join(root, "calls.log"), "utf8").catch(() => "");
    if (calls.includes(waitFor)) break;
    await delay(50);
  }
  worker.kill("SIGKILL");
  await new Promise((done) => worker.once("exit", done));
  const recover = spawn(process.execPath, [script, root, "recover"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  recover.stdout.on("data", (c) => { out += c; });
  await new Promise((done) => recover.once("exit", done));
  const result = JSON.parse(out.trim().split("\n").pop());
  return { root, result, outbox: await readFile(join(root, "outbox.log"), "utf8").catch(() => ""),
    calls: await readFile(join(root, "calls.log"), "utf8") };
}

test("killed while only looking: the look is done again and the task finishes by itself", async (t) => {
  const { result, calls } = await killedMidStep(t, [{ id: "a", tool: "chaos.look", args: { n: 1 } }, { id: "b", tool: "chaos.look", args: { n: 2 } }], { waitFor: "look 1" });
  assert.equal(result.report[0].outcome, "resumed");
  assert.deepEqual(result.report[0].steps, [{ tool: "chaos.look", decision: "redo" }]);
  assert.ok(result.runs.some((run) => run.status === "completed" && run.output === "all done"), JSON.stringify(result.runs));
  assert.match(calls, /look 1[\s\S]*look 1[\s\S]*look 2/, "the look was repeated once and the next step followed");
  assert.equal((calls.match(/look 2/g) ?? []).length, 1);
});

test("killed while sending: nothing is sent twice, and the owner is asked", async (t) => {
  const { result, outbox } = await killedMidStep(t, [{ id: "a", tool: "chaos.send", args: { n: 1 } }], { waitFor: "send 1" });
  assert.equal(result.report[0].outcome, "asked");
  const asked = result.runs.find((run) => run.status === "needs_input");
  assert.match(asked.output, /stopped while it was .*may already have happened.*check first and carry on, or do it again/);
  assert.equal(outbox, "", "the send never finished, and it was not tried again by itself");
  assert.equal(result.steps[result.report[0].runId].find((s) => s.kind === "tool").state, "asked");
});

test("killed while writing a file: the file is checked, not guessed", async (t) => {
  const { result, root } = await killedMidStep(t, [
    { id: "a", tool: "files.write", args: { path: "note.txt", content: "hello" } },
    { id: "b", tool: "chaos.look", args: { n: 7 } },
  ], { waitFor: "look 7" });
  // The write finished before the kill; the look was cut off. Only the look is repeated.
  assert.deepEqual(result.report[0].steps, [{ tool: "chaos.look", decision: "redo" }]);
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "hello");
});

test("with the switch at when needed, interrupted work waits for the owner", async (t) => {
  const { result, calls } = await killedMidStep(t, [{ id: "a", tool: "chaos.look", args: { n: 1 } }], { mode: "when-needed", waitFor: "look 1" });
  assert.equal(result.report[0].outcome, "offered");
  assert.equal((calls.match(/look 1/g) ?? []).length, 1, "nothing was done again without the owner");
  assert.ok(result.runs.every((run) => run.status === "interrupted"));
});

test("a file step checked after the fact: done is kept, not done is done", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("carried on")]) });
  t.after(() => app.close());
  const make = async (callId, path, content, landed) => {
    const run = app.store.createRun("local", `write ${path}`);
    app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [{ id: callId, name: "files.write", arguments: JSON.stringify({ path, content }) }] });
    const evidence = await evidenceFor("files.write", { path, content }, app.runtime.workspace);
    app.neverBreak.journal.begin({ runId: run.id, sessionId: run.sessionId, callId, tool: "files.write", arguments: JSON.stringify({ path, content }), key: "k", effects: "idempotent", evidence });
    if (landed) await writeFile(join(app.runtime.workspace, path), content);
    app.store.finish(run.id, "interrupted", "cut off");
    return run;
  };
  const landed = await make("c1", "landed.txt", "yes", true);
  const missing = await make("c2", "missing.txt", "later", false);
  const report = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await Promise.all(report.map((r) => r.resumed));
  const byRun = Object.fromEntries(report.map((r) => [r.runId, r.steps[0].decision]));
  assert.equal(byRun[landed.id], "done");
  assert.equal(byRun[missing.id], "not-done");
  assert.equal(await readFile(join(app.runtime.workspace, "missing.txt"), "utf8"), "later", "the missing write was done");
  const said = (run) => app.store.messages(run.sessionId).find((m) => m.role === "tool").content;
  assert.match(said(landed), /already taken effect \(checked\)/);
  assert.match(said(missing), /"status":"redone"/);
  const again = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.deepEqual(again, [], "a task is settled once");
});

test("a task a chat app started is left for the chat app to send again", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
  t.after(() => app.close());
  const run = app.store.createRun("local", "from telegram");
  app.store.event(run.id, "channel.inbound", { channel: "tg", chatId: "1", messageId: "9" });
  app.store.finish(run.id, "interrupted", "cut off");
  const [only] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.equal(only.outcome, "left-for-chat");
  assert.deepEqual(await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "off" }), []);
});

/* ---------- chat messages and timed jobs missed while down ---------- */

function fakeTelegram(updates) {
  const offsets = [];
  const fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "branch_bot" } });
    if (method === "getUpdates") {
      offsets.push(body.offset);
      await delay(20);
      return Response.json({ ok: true, result: updates.filter((u) => u.update_id >= body.offset) });
    }
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  return { fetch, offsets };
}
const update = (id, text) => ({ update_id: id, message: { message_id: id, text, from: { id: 5, username: "owner" }, chat: { id: 5, type: "private" } } });

test("Telegram picks up where it had read to, so messages sent during a restart are answered once", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("x")]) });
  t.after(() => app.close());
  const position = channelPosition(app.store, "tg");
  const first = fakeTelegram([update(10, "one"), update(11, "two")]);
  const seen = [];
  const before = new TelegramAdapter({ id: "tg", token: "fake", fetch: first.fetch, position, pollTimeoutSeconds: 0 });
  await before.start(async (m) => { seen.push(m.text); });
  for (let i = 0; i < 100 && seen.length < 2; i++) await delay(10);
  await before.stop();
  assert.equal(position.load(), 12, "the position is saved after each handled message");

  // Branch was down; a third message arrived. The new adapter asks only for what came after.
  const second = fakeTelegram([update(10, "one"), update(11, "two"), update(12, "three")]);
  const after = new TelegramAdapter({ id: "tg", token: "fake", fetch: second.fetch, position: channelPosition(app.store, "tg"), pollTimeoutSeconds: 0 });
  await after.start(async (m) => { seen.push(m.text); });
  for (let i = 0; i < 100 && seen.length < 3; i++) await delay(10);
  await after.stop();
  assert.equal(second.offsets[0], 12);
  assert.deepEqual(seen, ["one", "two", "three"], "nothing answered twice, nothing lost");
});

test("a repeating job cut off by a restart goes back on the list, and a missed turn runs once with a note", async (t) => {
  const root = await temp(t);
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: scripted([say("ran")]) });
  t.after(() => app.close());
  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 3 * 3600_000).toISOString();
  app.store.save("schedules", "local", "11111111-1111-4111-8111-111111111111", { kind: "task", prompt: "hourly", dueAt: threeHoursAgo,
    intervalMs: 3600_000, status: "interrupted", permissions: [], history: [] });
  const next = (data, when) => new Date(when.getTime() + Number(data.intervalMs)).toISOString();
  assert.equal(releaseInterruptedSchedules(app.store, next, now), 1);
  const released = app.store.get("schedules", "local", "11111111-1111-4111-8111-111111111111").data;
  assert.equal(released.status, "pending");
  assert.match(released.lastInterruption.note, /carries on at its next turn/);

  app.store.save("schedules", "local", "22222222-2222-4222-8222-222222222222", { kind: "task", prompt: "missed", dueAt: threeHoursAgo,
    intervalMs: 3600_000, status: "pending", permissions: [], history: [] });
  const runs = await new Scheduler(app.store, app.runtime).tick(now);
  assert.equal(runs.length, 1, "three missed turns run once");
  const caught = app.store.events(runs[0].id).find((e) => e.kind === "schedule.caught_up");
  assert.match(caught.data.note, /due 3 hours ago/);
  const after = app.store.get("schedules", "local", "22222222-2222-4222-8222-222222222222").data;
  assert.ok(Date.parse(after.dueAt) > now.getTime(), "the next turn is in the future, not the missed ones");
});

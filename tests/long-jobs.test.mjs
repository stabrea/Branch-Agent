/**
 * Bucket 8: long jobs that survive being interrupted.
 *
 * A conversation that comes back with everything it was carrying after the app is closed and opened
 * again, a command line kept open between tasks, the whole assistant with no window at all, a task
 * that cannot be placed saying why, and a repeating job that fails a turn without stopping for good.
 *
 * Fakes only: no network, no window, no real model. The only real programs started are the stdin
 * fixture beside this file, and every one of them is proved dead before the test ends.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createBranch, evaluatePolicy, PolicySchema, presetRules, rememberSessionCarry, restoreSessionCarry,
  readSessionCarry, carrySentences, placeTask, placementLine, Scheduler, failuresBeforePausing,
} from "../dist/index.js";
import { ShellSessions, registerShellSessions } from "../dist/shell-session.js";
import { runHeadless, jobExitCode, promptsFromScript, parseHeadlessArgs } from "../dist/headless.js";
import { parseRunArgs, exitCodes } from "../dist/cli-run.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { writeFile } from "node:fs/promises";

const scriptFixture = resolve("tests/fixtures/kept-shell.mjs");
const fakeEnv = { ...process.env, NODE_OPTIONS: "" };

function scripted() {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return { content: `Result ${provider.requests.length}`, toolCalls: [] };
  } };
  return provider;
}
const presetsFor = (provider) => [
  { id: "default", name: "Everyday", provider, model: "demo" },
  { id: "careful", name: "Careful thinking", provider, model: "demo" },
];
/**
 * A private folder for one test, and one tidy-up that closes everything still open before the
 * folder goes. Order matters: taking the database out from under an app that is still open leaves
 * its close waiting for ever, which is a hang rather than a failure and hides the real result.
 */
async function scratch(t) {
  const base = await mkdtemp(join(tmpdir(), "branch-longjobs-"));
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
  });
  return { base, keep: (close) => closers.push(close) };
}
const open = (base, presets) => createBranch({
  workspace: join(base, "workspace"), dataDir: join(base, "data"),
  ...(presets ? { presets } : { provider: scripted() }),
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function gone(pid, what) {
  for (let attempt = 0; attempt < 300 && alive(pid); attempt++) await delay(10);
  assert.equal(alive(pid), false, `${what} (pid ${pid}) survived`);
}

/* ---- A0390: a conversation that survives a restart ---- */

test("a conversation comes back from a restart with its model, its permissions and its project", async (t) => {
  const { base, keep } = await scratch(t);
  const first = await open(base, presetsFor(scripted()));
  const sessionId = first.store.createSession("local");
  first.store.projects.save("local", { id: "research", name: "Research", instructions: "", modelPreset: null,
    repository: "", folder: "", profile: null, knowledgeBases: [], branch: "" });
  first.store.projects.setActive("local", { active: "research" });
  first.runtime.models.configureSession("local", sessionId, { preset: "careful", reasoning: "high" });
  first.runtime.approvals.remember(sessionId, "files.write", "notes.txt", "allow", { label: "Writing notes.txt" });
  await first.runtime.run({ prompt: "carry this", sessionId, onTextDelta: () => undefined });
  const written = readSessionCarry(first.store, "local", sessionId);
  assert.equal(written.preset, "careful", "the end of a task writes down what the conversation carries");
  assert.equal(written.projectId, "research");
  assert.equal(written.grants.length, 1);
  const grantedUntil = written.grants[0].expiresAt;
  await first.close();

  // The app is closed and opened again on the same data folder: this is the restart.
  const second = await open(base, presetsFor(scripted()));
  keep(() => second.close());
  const back = second.runtime.carriedBySession(sessionId);
  assert.equal(back.found, true);
  assert.equal(back.preset, "careful", "the model choice came back");
  assert.equal(back.reasoning, "high");
  assert.equal(back.projectId, "research", "the project came back");
  assert.equal(back.notRestored.length, 0, "nothing was lost, so nothing is claimed lost");
  assert.equal(second.runtime.models.session("local", sessionId).preset, "careful");
  assert.equal(second.runtime.approvals.answer(sessionId, "files.write", "notes.txt"), "allow",
    "the standing yes is in force again");
  assert.equal(second.runtime.approvals.grants(sessionId)[0].expiresAt, grantedUntil,
    "a restart must not quietly lengthen a permission");
  assert.match(carrySentences(back)[0], /came back with the model "careful"/);

  // The task itself, not only the report: a task joining the conversation after the restart is what
  // puts it back in the product, and it says on its own record what came back.
  const carried = await second.runtime.run({ prompt: "carry on", sessionId, onTextDelta: () => undefined });
  const restored = second.store.events(carried.id).find((event) => event.kind === "session.restored");
  assert.ok(restored, "the first task after a restart records what the conversation came back with");
  assert.equal(restored.data.preset, "careful");
  assert.equal(restored.data.permissions, 1);
  assert.deepEqual(restored.data.notRestored, []);
});

test("a toolbox a conversation had open is open again in its next task after a restart", async (t) => {
  const { base, keep } = await scratch(t);
  const first = await open(base, presetsFor(scripted()));
  const sessionId = first.store.createSession("local");
  rememberSessionCarry({ store: first.store, models: first.runtime.models, approvals: first.runtime.approvals,
    toolboxes: () => ["git"] }, "local", sessionId, ["git"]);
  await first.close();
  const second = await open(base, presetsFor(scripted()));
  keep(() => second.close());
  const run = await second.runtime.run({ prompt: "carry on", sessionId, onTextDelta: () => undefined });
  const chosen = second.store.events(run.id).find((event) => event.kind === "catalog.preselected");
  assert.ok(chosen.data.style?.includes("git"), "the toolbox it had open is open again from the first round");
});

test("what a restart cannot bring back is named rather than quietly swapped", async (t) => {
  const { base, keep } = await scratch(t);
  const first = await open(base, presetsFor(scripted()));
  const sessionId = first.store.createSession("local");
  first.store.projects.save("local", { id: "doomed", name: "Doomed", instructions: "", modelPreset: null,
    repository: "", folder: "", profile: null, knowledgeBases: [], branch: "" });
  first.store.projects.setActive("local", { active: "doomed" });
  first.runtime.models.configureSession("local", sessionId, { preset: "careful", reasoning: null });
  rememberSessionCarry({ store: first.store, models: first.runtime.models, approvals: first.runtime.approvals,
    toolboxes: () => ["code", "teleport"] }, "local", sessionId, ["code", "teleport"]);
  // A permission that ran out while the app was closed, written as it would have been saved.
  const saved = readSessionCarry(first.store, "local", sessionId);
  first.store.save("settings", "local", `session-carry:${sessionId}`, { ...saved, grants: [{
    tool: "shell.execute", target: "node build", decision: "allow", fingerprint: null,
    grantedAt: new Date(Date.now() - 7200000).toISOString(), expiresAt: new Date(Date.now() - 3600000).toISOString(),
    label: "Running node build" }] });
  first.store.projects.remove("local", "doomed");
  await first.close();

  // Opened again with only the everyday model set up, so "careful" is gone as well.
  const second = await open(base, [{ id: "default", name: "Everyday", provider: scripted(), model: "demo" }]);
  keep(() => second.close());
  const back = second.runtime.carriedBySession(sessionId);
  const said = back.notRestored.map((loss) => `${loss.what}: ${loss.why}`).join("\n");
  assert.match(said, /the model "careful".*no longer set up.*[Uu]sing "Everyday" instead/s);
  assert.match(said, /the project "doomed".*has been removed/s);
  assert.match(said, /"teleport" toolbox.*nothing in this launch offers it/s);
  assert.match(said, /permission for Running node build.*already run out.*asked for again/s);
  assert.equal(back.preset, null, "a model that is gone is not pretended to be there");
  assert.equal(second.runtime.approvals.answer(sessionId, "shell.execute", "node build"), undefined,
    "a permission that ran out is not quietly renewed");
  assert.deepEqual(back.toolboxes, ["code"], "the toolbox that still exists came back");
  assert.match(carrySentences(back).join("\n"), /I could not bring back/);
});

/* ---- A2243: a command line that stays open between tasks ---- */

async function keptShell(t) {
  const { base, keep } = await scratch(t);
  const app = await open(base);
  const shells = new ShellSessions({ executables: { keeper: { path: process.execPath, args: [scriptFixture] } } },
    app.store, "local", fakeEnv);
  registerShellSessions(app.registry, shells);
  keep(() => app.close());
  keep(() => shells.closeAll());
  const sessionId = app.store.createSession("local");
  const context = (prompt) => app.runtime.context({ runId: app.store.createRun("local", prompt, sessionId).id });
  return { app, shells, sessionId, context };
}

test("one kept-open command line serves two separate tasks, and is listed, read and stopped", async (t) => {
  const { shells, sessionId, context } = await keptShell(t);
  const firstTask = context("first task");
  const opened = await shells.start({ program: "keeper", args: [], cwd: ".", name: "kept open" }, firstTask);
  assert.equal(opened.status, "open");
  assert.ok(opened.pid, "it really started a program");
  const one = await shells.send({ id: opened.id, input: "one", waitMs: 8000 }, firstTask);
  assert.match(one.output, /^1 one pid=/m, "the first command answered");

  // A different task, in the same conversation: the same program is still there.
  const secondTask = context("second task");
  const two = await shells.send({ id: opened.id, input: "two", waitMs: 8000 }, secondTask);
  assert.match(two.output, /^2 two pid=/m, "the count carried over, so this is the same program");
  assert.equal(two.pid, opened.pid, "and the same program is proved by its number");
  assert.equal(two.commands, 2);

  const listed = shells.list({ sessionId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, opened.id);
  assert.equal(shells.list({ sessionId: randomUUID() }).length, 0, "another conversation sees nothing of it");
  const read = shells.read(opened.id, 2000, sessionId);
  assert.match(read.output, /1 one/, "what it printed can be read back");
  assert.match(read.output, /2 two/);

  const pid = opened.pid;
  const closed = await shells.close(opened.id, secondTask, sessionId);
  assert.equal(closed.status, "closed");
  await gone(pid, "the kept-open command line");
});

test("a kept-open command line asks permission for every command, like any other command", async (t) => {
  const { app } = await keptShell(t);
  const asks = PolicySchema.parse({ preset: "workspace", rules: presetRules("workspace") });
  const changes = PolicySchema.parse({ preset: "ask-before-changes", rules: presetRules("ask-before-changes") });
  for (const policy of [asks, changes]) {
    assert.equal(evaluatePolicy(policy, { tool: "shell.session.run", target: "rm -rf work", readOnly: false }).decision,
      "ask", "sending a command to a kept-open line waits for a yes");
    assert.equal(evaluatePolicy(policy, { tool: "shell.session.open", target: "keeper", readOnly: false }).decision, "ask");
  }
  const locked = PolicySchema.parse({ preset: "read-only", rules: presetRules("read-only") });
  assert.equal(evaluatePolicy(locked, { tool: "shell.session.run", target: "anything", readOnly: false }).decision, "deny");
  const tools = app.registry.descriptions(new Set(["shell.execute"])).map((tool) => tool.name);
  for (const name of ["shell.session.open", "shell.session.run", "shell.session.list", "shell.session.close"])
    assert.ok(tools.includes(name), `${name} is held to the shell.execute permission`);
});

test("nothing a kept-open command line started survives the app closing, and no window is ever opened", async (t) => {
  const { shells, context } = await keptShell(t);
  const task = context("a task");
  const first = await shells.start({ program: "keeper", args: [], cwd: ".", name: "one" }, task);
  const second = await shells.start({ program: "keeper", args: [], cwd: ".", name: "two" }, task);
  assert.equal(shells.list({ active: true }).length, 2);
  await shells.closeAll();
  assert.equal(shells.list().length, 0, "the app closing leaves nothing behind to find");
  await gone(first.pid, "the first kept-open command line");
  await gone(second.pid, "the second kept-open command line");
  await assert.rejects(() => shells.start({ program: "keeper", args: [], cwd: ".", name: "late" }, task),
    /not being run in this launch/);
  const source = await readFile("dist/shell-session.js", "utf8");
  assert.match(source, /windowsHide: true/, "a kept-open command line never puts a console on the screen");
});

test("a real launch registers the kept-open command line and closes it with everything else", async (t) => {
  const { base, keep } = await scratch(t);
  const app = await open(base);
  keep(() => app.close());
  const configPath = join(base, "integrations.json");
  const config = { executables: { keeper: { path: process.execPath, args: [scriptFixture] } } };
  await writeFile(configPath, JSON.stringify({ shell: config }));
  const registry = new (app.registry.constructor)();
  const live = await loadIntegrations(registry, configPath, fakeEnv, undefined, app.channelHost);
  for (const name of ["shell.session.open", "shell.session.run", "shell.session.list", "shell.session.close"])
    assert.ok(registry.names().includes(name), `${name} is missing from a real launch`);
  const sessionId = app.store.createSession("local");
  const context = app.runtime.context({ permissions: ["shell.execute"],
    runId: app.store.createRun("local", "a task", sessionId).id });
  const opened = await registry.execute("shell.session.open",
    { program: "keeper", args: [], cwd: ".", name: "kept" }, context);
  assert.ok(opened.pid);
  // Closing the app is what this proves: nothing it started is left behind.
  await live.close();
  await gone(opened.pid, "the kept-open command line from a real launch");
});

test("a program that is not one of the allowed ones says so and names the ones that are", async (t) => {
  const { shells, context } = await keptShell(t);
  await assert.rejects(() => shells.start({ program: "psql", args: [], cwd: ".", name: "no" }, context("a task")),
    /needs a program called "psql", which is not on this computer.*You could use keeper instead/s);
});

/* ---- A2315: the whole assistant with no window at all ---- */

/** A stand-in engine that answers with the statuses a test asks for, in order. */
function fakeEngine(statuses) {
  let at = 0;
  return {
    owner: "local",
    store: { events: () => [] },
    async run(options) {
      const status = statuses[Math.min(at, statuses.length - 1)];
      at += 1;
      const run = { id: `run-${at}`, sessionId: "one-conversation", status, output: `answer ${at}`, prompt: "" };
      options.onStarted?.(run);
      return run;
    },
  };
}
const quiet = () => { const lines = []; return { lines, line: (value) => lines.push(value), note: () => undefined }; };

test("a headless job answers with the exit code branch run already documents", async (t) => {
  const flags = parseRunArgs([]);
  const cases = [["completed", exitCodes.ok], ["needs_input", exitCodes.needsInput],
    ["failed", exitCodes.failed], ["budget_exceeded", exitCodes.budget]];
  for (const [status, code] of cases) {
    const writer = quiet();
    const report = await runHeadless(fakeEngine([status]), { prompts: ["do the thing"], flags, stopEarly: true }, writer);
    assert.equal(report.exitCode, code, `${status} must answer ${code}`);
    assert.equal(report.steps[0].status, status);
    assert.ok(writer.lines.some((entry) => entry.type === "headless.finished" && entry.exitCode === code));
  }
  assert.deepEqual([exitCodes.ok, exitCodes.needsInput, exitCodes.failed, exitCodes.budget], [0, 2, 3, 4],
    "no new codes were invented");
});

test("a headless job runs a script in one conversation and stops early when told to", async (t) => {
  const flags = parseRunArgs([]);
  const prompts = promptsFromScript("# a note\n\nwrite the report\ncheck the report\nsend it\n");
  assert.deepEqual(prompts, ["write the report", "check the report", "send it"]);
  const all = await runHeadless(fakeEngine(["completed"]), { prompts, flags, stopEarly: false }, quiet());
  assert.equal(all.steps.length, 3);
  assert.equal(all.exitCode, exitCodes.ok);
  assert.match(all.summary, /All 3 finished/);
  const stopped = await runHeadless(fakeEngine(["completed", "failed", "completed"]),
    { prompts, flags, stopEarly: true }, quiet());
  assert.equal(stopped.steps.length, 2, "it stopped at the one that did not finish");
  assert.equal(stopped.exitCode, exitCodes.failed);
  assert.match(stopped.summary, /1 of 2 finished/);
  assert.equal(jobExitCode([{ exitCode: 0 }, { exitCode: 4 }, { exitCode: 3 }]), 4, "the first thing to go wrong decides");
  assert.deepEqual(parseHeadlessArgs(["--script", "jobs.txt", "--stop-early", "--json"]),
    { script: "jobs.txt", stopEarly: true, rest: ["--json"] });
  assert.throws(() => promptsFromScript("\n# only notes\n"), /no requests/);
});

/* ---- A2377: a task that cannot be placed says why, and what to do instead ---- */

test("a task that cannot be placed says why and offers the alternative", async (t) => {
  const busy = placeTask({ atOnce: 3, running: 3, position: 4 });
  assert.equal(busy.placed, false);
  assert.equal(busy.outcome, "waiting");
  assert.match(busy.reason, /All 3 places are taken.*number 4 in the line/);
  assert.match(busy.alternative, /Stop something that is working|raise how many/);
  const mine = placeTask({ atOnce: 3, running: 1, sessionBusy: true });
  assert.match(mine.reason, /already working on something/);
  assert.match(mine.alternative, /new conversation/);
  const missing = placeTask({ atOnce: 3, running: 0, missing: { what: "Docker", instead: "the Windows Subsystem for Linux" } });
  assert.equal(missing.outcome, "refused");
  assert.match(placementLine(missing), /needs Docker, which is not on this computer.*Windows Subsystem for Linux/s);
  const nothingElse = placeTask({ atOnce: 3, running: 0, missing: { what: "a signing key", instead: null } });
  assert.match(nothingElse.alternative, /Settings.*nothing was started/);
  const swapped = placeTask({ atOnce: 3, running: 0, missingPreset: "fast", fallbackPreset: "Everyday" });
  assert.equal(swapped.outcome, "elsewhere");
  assert.equal(swapped.placed, true, "it still runs, but the swap is said out loud");
  assert.match(placementLine(swapped), /"fast" is no longer set up.*Using "Everyday" instead/s);
  const noModel = placeTask({ atOnce: 3, running: 0, missingPreset: "fast", fallbackPreset: null });
  assert.equal(noModel.outcome, "refused");
  const room = placeTask({ atOnce: 3, running: 0 });
  assert.equal(room.placed, true);
  assert.equal(room.alternative, null);
});

test("the waiting line tells a task that has to wait where it is and what would help", async (t) => {
  const { base, keep } = await scratch(t);
  const app = await open(base);
  keep(() => app.close());
  const held = [];
  for (let taken = app.executions.room; taken > 0; taken--) held.push(app.executions.take());
  t.after(() => { for (const give of held) give?.(); });
  const waiting = app.runQueue.submit("local", { prompt: "this has to wait", source: "owner" });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.placement.placed, false);
  assert.match(waiting.placement.reason, /places are taken/);
  assert.ok(waiting.placement.alternative, "it never says no without saying what to do instead");
  assert.equal(app.runQueue.placement("local", waiting.id).outcome, "waiting");
});

/* ---- A1657: a repeating job that fails a turn does not stop for good ---- */

/** A stand-in engine for the scheduler: every turn it is asked for fails. */
const brokenEngine = (store) => ({ owner: "local", store, notifyEvent: () => undefined,
  run: async () => { throw new Error("the thing it needs is not answering"); } });

test("a repeating job that fails keeps its place, and is paused once it is plainly broken", async (t) => {
  const { base, keep } = await scratch(t);
  const app = await open(base);
  keep(() => app.close());
  const scheduler = new Scheduler(app.store, brokenEngine(app.store));
  const id = randomUUID();
  const due = new Date(Date.now() - 1000);
  app.store.save("schedules", "local", id, { prompt: "check the feed", kind: "task", daysOff: "run",
    dueAt: due.toISOString(), intervalMs: 3600000, permissions: [], status: "pending", history: [] });
  for (let turn = 1; turn <= failuresBeforePausing; turn++) {
    const record = app.store.get("schedules", "local", id);
    await scheduler.tick(new Date(Date.parse(record.data.dueAt) + 1000));
    const after = app.store.get("schedules", "local", id).data;
    assert.equal(after.consecutiveFailures, turn, "each failed turn is counted");
    if (turn < failuresBeforePausing) {
      assert.equal(after.status, "pending", "a failed turn does not stop a repeating job for good");
      assert.ok(Date.parse(after.dueAt) > due.getTime(), "it moved on to its next turn");
    } else {
      assert.equal(after.status, "paused", "a job that is broken rather than unlucky is paused");
      assert.match(after.pausedBecause, /did not finish 3 turns in a row.*Start it again/s);
    }
  }
  // Once it works again the count is cleared and nothing is left saying it was paused.
  const working = new Scheduler(app.store, { owner: "local", store: app.store, notifyEvent: () => undefined,
    run: async () => app.store.finish(app.store.createRun("local", "check the feed").id, "completed", "all well") });
  const paused = app.store.get("schedules", "local", id).data;
  app.store.save("schedules", "local", id, { ...paused, status: "pending" });
  await working.tick(new Date(Date.parse(paused.dueAt) + 1000));
  const healthy = app.store.get("schedules", "local", id).data;
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(healthy.status, "pending");
  assert.equal(healthy.pausedBecause, null);
});

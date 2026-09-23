import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { TeamTasks } from "../dist/team-tasks.js";
import { turnEffects } from "../dist/team-reconcile.js";
import { recoverAfterRestart } from "../dist/never-break/resume.js";

// Q63: a team turn names its run before the run does anything, and an outcome nobody saw is
// settled from the runtime's own record, never by running the turn again. Real runtimes with
// scripted models; failures are injected before dispatch, after an effect and before the
// acknowledgement is written.
const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };
const say = (content) => ({ content, toolCalls: [] });
const write = (id, path, content) => ({ content: "", toolCalls: [{ id, name: "files.write", arguments: JSON.stringify({ path, content }) }] });
const isMember = (request) => JSON.stringify(request.messages).includes("Your role in team");

/** A model that answers the team's own turn and its members from separate scripts, keyed on what was asked. */
function scripted(parentSteps = [() => say("parent done")], memberSteps = [() => say("member done")]) {
  const provider = { name: "scripted", parentCalls: 0, memberCalls: 0, async complete(request) {
    if (isMember(request)) return memberSteps[Math.min(provider.memberCalls++, memberSteps.length - 1)](request);
    return parentSteps[Math.min(provider.parentCalls++, parentSteps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-lineage-"));
  const open = (p) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: p });
  const state = { app: await open(provider) };
  t.after(async () => { await state.app.close().catch(() => undefined); await discardTemp(root); });
  const owner = state.app.runtime.owner;
  const members = ["planner", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    state.app.store.save("specialists", owner, specialistId, { id: specialistId, name: role });
    return { specialistId, role, brief: "" };
  });
  const team = state.app.teams.save({ name: "Crew", members });
  const reopen = async (next) => { await state.app.close(); state.app = await open(next); return state.app; };
  return { state, owner, team, reopen, workspace: join(root, "workspace") };
}
/** The real runtime, with a count of team dispatches and an optional failure injected at the parent run's start. */
function counted(runtime, throwAtStart) {
  const wrapper = { dispatches: 0,
    run: (options) => { wrapper.dispatches++; return runtime.run(throwAtStart ? { ...options, onStarted: (run) => { options.onStarted(run); throw new Error(throwAtStart); } } : options); },
    context: (options) => runtime.context(options),
    fanout: (...args) => runtime.fanout(...args) };
  return wrapper;
}
const row = (app, requestId) => app.store.sqlite.prepare("SELECT * FROM team_tasks WHERE request_id=?").get(requestId);

test("the parent run id is written to the task before the parent run's first model call", async (t) => {
  const requestId = randomUUID();
  let seenAtFirstCall;
  const provider = scripted([() => { seenAtFirstCall ??= { ...row(state.app, requestId) }; return say("parent done"); }]);
  const { state, team } = await fixture(t, provider);
  const done = await state.app.teams.run(state.app.runtime, knowledge, team.id, "plan the week", { requestId });
  assert.equal(done.state, "completed");
  assert.equal(seenAtFirstCall.state, "claimed");
  assert.ok(seenAtFirstCall.parent_run_id, "the reference is persisted before the model is first asked anything");
  assert.equal(seenAtFirstCall.parent_run_id, done.parentRunId);
  assert.deepEqual(done.answers.map((a) => [a.role, a.status]), [["planner", "completed"], ["reviewer", "completed"]]);
});

test("a failure before dispatch leaves the task failed; the same id never runs again and a new id does", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider);
  const requestId = randomUUID();
  const broken = counted(state.app.runtime, "injected: the run stopped before its first model call");
  const seen = await state.app.teams.run(broken, knowledge, team.id, "tidy the docs", { requestId });
  assert.equal(seen.state, "failed");
  assert.equal(provider.parentCalls + provider.memberCalls, 0, "no model was asked anything");
  const task = row(state.app, requestId);
  assert.ok(task.parent_run_id, "the run that was created is still named");
  assert.equal(state.app.store.run(task.parent_run_id).status, "failed");
  // The runtime refusing before any run exists is failed too.
  const refusing = { dispatches: 0, async run() { refusing.dispatches++; throw new Error("monthly budget reached"); } };
  const refusedId = randomUUID();
  await assert.rejects(state.app.teams.run(refusing, knowledge, team.id, "tidy the docs", { requestId: refusedId }), /monthly budget/);
  assert.equal(row(state.app, refusedId).state, "failed");
  assert.equal(row(state.app, refusedId).parent_run_id, null);
  // The same request id is answered from the record; nothing is dispatched again.
  const healthy = counted(state.app.runtime);
  const again = await state.app.teams.run(healthy, knowledge, team.id, "tidy the docs", { requestId });
  assert.equal(again.state, "failed");
  assert.equal(healthy.dispatches, 0);
  // A new request id is new work and runs.
  const fresh = await state.app.teams.run(healthy, knowledge, team.id, "tidy the docs", { requestId: randomUUID() });
  assert.equal(fresh.state, "completed");
  assert.equal(healthy.dispatches, 1);
});

test("a failure after an effect needs reconciliation, lists the effect, and is never replayed across a restart", async (t) => {
  const provider = scripted([() => write("w1", "effect.txt", "written once"), () => { throw new Error("connection refused"); }]);
  const { state, team, reopen, workspace } = await fixture(t, provider);
  const requestId = randomUUID();
  const seen = await state.app.teams.run(state.app.runtime, knowledge, team.id, "write the note", { requestId });
  assert.equal(seen.state, "needs_reconciliation");
  assert.equal(provider.memberCalls, 0, "members are not started after the team's own turn failed");
  assert.equal(await readFile(join(workspace, "effect.txt"), "utf8"), "written once");
  const after = scripted();
  const app = await reopen(after);
  const retry = counted(app.runtime);
  const observed = await app.teams.run(retry, knowledge, team.id, "write the note", { requestId });
  assert.equal(observed.state, "needs_reconciliation");
  assert.equal(retry.dispatches, 0);
  const report = app.teams.reconcile(seen.taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.name, e.toolCallId, e.outcome]), [["files.write", "w1", "completed"]]);
  assert.equal(after.parentCalls + after.memberCalls, 0, "nothing was asked or run again");
  assert.match(new TeamTasks(app.store).get({ owner: app.runtime.owner, source: "window" }, seen.taskId).error, /1 tool call/);
});

test("a crash before the acknowledgement is finished by reconcile from the recorded result, with no second dispatch", async (t) => {
  const provider = scripted();
  const { state, team, reopen } = await fixture(t, provider);
  const requestId = randomUUID();
  // The process "dies" between the members finishing and the completion being written: that write never happens.
  const complete = TeamTasks.prototype.complete;
  TeamTasks.prototype.complete = function skipped() {};
  t.after(() => { TeamTasks.prototype.complete = complete; });
  const lost = await state.app.teams.run(state.app.runtime, knowledge, team.id, "summarise", { requestId });
  TeamTasks.prototype.complete = complete;
  assert.equal(row(state.app, requestId).state, "claimed");
  const roomBefore = state.app.teams.room(team.id).length;
  const after = scripted();
  const app = await reopen(after);
  const retry = counted(app.runtime);
  // The claim was made by the process that "died", so the same request id settles it from the record first.
  const finished = await app.teams.run(retry, knowledge, team.id, "summarise", { requestId });
  assert.equal(finished.state, "completed");
  assert.deepEqual(finished.answers.map((a) => [a.role, a.status, a.output]), lost.answers.map((a) => [a.role, a.status, a.output]));
  assert.equal(finished.parentRunId, lost.parentRunId);
  assert.equal(retry.dispatches, 0);
  assert.equal(after.parentCalls + after.memberCalls, 0, "no model was asked anything after the restart");
  assert.equal(app.teams.room(team.id).length, roomBefore + 2, "the members' answers land in the room exactly once");
  assert.equal(app.teams.reconcile(lost.taskId).state, "completed", "reconciling again changes nothing");
  assert.equal(app.teams.room(team.id).length, roomBefore + 2);
});

test("a crash while members worked, with no result recorded, is reconciled from every member run's effects", async (t) => {
  let written = 0;
  const provider = scripted(undefined, [(request) => (JSON.stringify(request.messages).includes('"tool"') ? say("member done") : write(`m${written++}`, `member-${written}.txt`, "once"))]);
  const { state, team, reopen } = await fixture(t, provider);
  const requestId = randomUUID();
  // The process "dies" after the members acted and before anything about their result was written.
  const { recordOutcome, complete } = TeamTasks.prototype;
  TeamTasks.prototype.recordOutcome = function skipped() {};
  TeamTasks.prototype.complete = function skipped() {};
  t.after(() => Object.assign(TeamTasks.prototype, { recordOutcome, complete }));
  const writers = { activeSpecialist: () => ({ permissions: ["files.write"], instructions: "" }) };
  const lost = await state.app.teams.run(state.app.runtime, writers, team.id, "file the notes", { requestId });
  Object.assign(TeamTasks.prototype, { recordOutcome, complete });
  assert.equal(row(state.app, requestId).state, "claimed");
  assert.equal(row(state.app, requestId).result, null);
  const after = scripted();
  const app = await reopen(after);
  const report = app.teams.reconcile(lost.taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.name, e.outcome]).sort(), [["files.write", "completed"], ["files.write", "completed"]]);
  assert.ok(report.effects.every((e) => e.runId !== lost.parentRunId), "the effects were found in the member runs under the parent");
  const retry = counted(app.runtime);
  assert.equal((await app.teams.run(retry, knowledge, team.id, "file the notes", { requestId })).state, "needs_reconciliation");
  assert.equal(retry.dispatches + after.parentCalls + after.memberCalls, 0);
});

test("a crash before the team's turn did anything is not failed while its interrupted run can still be carried on", async (t) => {
  const provider = scripted();
  const { state, team, reopen } = await fixture(t, provider);
  const requestId = randomUUID();
  // The parent run is created and named, then the process "dies": the run is left running and never settles.
  const stuck = { run: (options) => { const run = state.app.store.createRun(state.app.runtime.owner, "team parent"); options.onStarted(run); return new Promise(() => {}); } };
  void state.app.teams.run(stuck, knowledge, team.id, "clean up", { requestId });
  await new Promise((resolve) => setImmediate(resolve));
  const task = row(state.app, requestId);
  assert.equal(state.app.teams.reconcile(task.task_id).state, "claimed", "a task still running in this process is left alone");
  const after = scripted();
  const app = await reopen(after);
  assert.equal(app.store.run(task.parent_run_id).status, "interrupted");
  // A member run still going (another process, say) means the claimant may be alive: reconcile leaves the task alone.
  const member = app.store.createRun(app.runtime.owner, "member");
  app.store.event(member.id, "run.started", { parentRunId: task.parent_run_id });
  assert.equal(app.teams.reconcile(task.task_id).state, "claimed");
  assert.equal(row(app, requestId).state, "claimed");
  app.store.finish(member.id, "interrupted", "stopped");
  // Q63: an interrupted run can be carried on after a restart, so "nothing was done" is not yet true.
  const report = app.teams.reconcile(task.task_id);
  assert.equal(report.state, "needs_reconciliation");
  assert.match(row(app, requestId).error, /can still be carried on/);
  assert.deepEqual(report.effects, []);
  assert.equal(after.parentCalls + after.memberCalls, 0);
});

test("a turn that stops to ask the owner waits with its question, starts no member, and is not a reconciliation case", async (t) => {
  const provider = scripted([() => write("w1", "notes.txt", "one"), () => say("parent done")]);
  const { state, team } = await fixture(t, provider);
  savePolicy(state.app.store, state.app.runtime.owner, { preset: "ask-before-changes" });
  const requestId = randomUUID();
  const seen = await state.app.teams.run(state.app.runtime, knowledge, team.id, "write the notes", { requestId });
  assert.equal(seen.state, "waiting_owner");
  assert.match(seen.question, /Writing notes\.txt/);
  assert.ok(seen.parentRunId);
  assert.equal(state.app.store.run(seen.parentRunId).status, "needs_input");
  assert.equal(provider.memberCalls, 0, "no member is started while the owner is being asked");
  assert.deepEqual(seen.effects.map((e) => [e.name, e.toolCallId, e.outcome]), [["files.write", "w1", "asked_owner"]], "the step waits for approval; it never ran");
  const task = row(state.app, requestId);
  assert.equal(task.state, "waiting_owner");
  assert.equal(task.question, seen.question);
  // reconcile leaves it alone, and the same request id answers from the record without dispatching.
  assert.equal(state.app.teams.reconcile(seen.taskId).state, "waiting_owner");
  assert.equal(row(state.app, requestId).state, "waiting_owner");
  const retry = counted(state.app.runtime);
  const again = await state.app.teams.run(retry, knowledge, team.id, "write the notes", { requestId });
  assert.equal(again.state, "waiting_owner");
  assert.equal(again.question, seen.question);
  assert.equal(retry.dispatches, 0);
  // Once the owner has decided, a new request id is new work.
  savePolicy(state.app.store, state.app.runtime.owner, { preset: "off" });
  const fresh = await state.app.teams.run(retry, knowledge, team.id, "write the notes", { requestId: randomUUID() });
  assert.equal(retry.dispatches, 1);
  assert.notEqual(fresh.state, "waiting_owner");
});

test("a second Branch cannot open the same data folder while one has it, so no other process can hold a team claim", async (t) => {
  const { state } = await fixture(t, scripted());
  const dataDir = state.app.store.folder;
  await assert.rejects(createBranch({ workspace: join(dataDir, "..", "workspace"), dataDir, provider: scripted() }), /already open/);
  assert.equal(state.app.store.isOpen, true, "the first Branch keeps working");
});

/** A team turn whose parent run is created (in the conversation the task named) and linked, and then never ends. */
function hanging(app, { link = true } = {}) {
  return { dispatches: 0, run(options) {
    this.dispatches++;
    const run = app.store.createRun(app.runtime.owner, "team parent", options.sessionId);
    if (link) options.onStarted(run);
    return new Promise(() => {});
  } };
}
/** Starts a turn that never ends and "crashes": the store is reopened and the parent run is left interrupted. */
async function crashedTurn(t, options) {
  const provider = scripted();
  const fx = await fixture(t, provider);
  const requestId = randomUUID();
  void fx.state.app.teams.run(hanging(fx.state.app, options), knowledge, fx.team.id, "clean up", { requestId });
  await new Promise((resolve) => setImmediate(resolve));
  const before = row(fx.state.app, requestId);
  const app = await fx.reopen(scripted());
  return { ...fx, app, requestId, taskId: before.task_id, parentRunId: before.parent_run_id, sessionId: before.parent_session_id };
}
/** A run carried on from `from` after a restart, as the runtime records it. */
function carryOn(app, from, sessionId) {
  const next = app.store.createRun(app.runtime.owner, "team parent", sessionId);
  app.store.event(next.id, "run.resumed", { from, unknownToolOutcomes: 0 });
  return next;
}

test("a run that carried the team's turn on after a restart is part of its lineage: its effects mean reconciliation", async (t) => {
  const { app, taskId, parentRunId, sessionId } = await crashedTurn(t);
  assert.equal(app.store.run(parentRunId).status, "interrupted");
  const next = carryOn(app, parentRunId, sessionId);
  app.store.event(next.id, "tool.started", { name: "files.write", id: "w9" });
  app.store.finish(next.id, "completed", "done");
  const report = app.teams.reconcile(taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.runId, e.toolCallId, e.name, e.outcome]), [[next.id, "w9", "files.write", "unknown"]]);
});

test("a turn carried on after a restart that then did nothing is failed: the interrupted run it came from no longer counts", async (t) => {
  const { app, taskId, parentRunId, sessionId } = await crashedTurn(t);
  const next = carryOn(app, parentRunId, sessionId);
  app.store.finish(next.id, "completed", "nothing to do");
  assert.equal(app.store.run(parentRunId).status, "interrupted", "the runtime leaves the run it carried on as it was");
  assert.equal(app.teams.reconcile(taskId).state, "failed");
});

test("a carried-on run that is still going leaves the task alone", async (t) => {
  const { app, taskId, parentRunId, sessionId } = await crashedTurn(t);
  carryOn(app, parentRunId, sessionId);
  assert.equal(app.teams.reconcile(taskId).state, "claimed");
});

test("a team turn's run created but not yet linked when Branch stopped is never carried on by recovery, and the task fails honestly", async (t) => {
  const { app, requestId, taskId, sessionId } = await crashedTurn(t, { link: false });
  const task = row(app, requestId);
  assert.equal(task.parent_run_id, null, "the crash came before the run was named");
  assert.equal(task.parent_session_id, sessionId);
  const [orphan] = app.store.runs(app.runtime.owner).filter((run) => run.sessionId === sessionId);
  assert.equal(orphan.status, "interrupted");
  const resumed = [];
  const runtime = new Proxy(app.runtime, { get: (target, key) => (key === "resume" ? (id) => { resumed.push(id); return Promise.resolve(); } : Reflect.get(target, key)) });
  const report = await recoverAfterRestart({ store: app.store, runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.deepEqual(report.filter((r) => r.runId === orphan.id).map((r) => r.outcome), ["left-for-team"]);
  assert.deepEqual(resumed, [], "recovery did not carry the unlinked turn on");
  assert.equal(app.store.run(orphan.id).status, "cancelled");
  const settled = app.teams.reconcile(taskId);
  assert.equal(settled.state, "failed");
});

test("a turn cut off mid-step that recovery put to the owner needs reconciliation, not waiting_owner", async (t) => {
  const { app, taskId, parentRunId, sessionId } = await crashedTurn(t);
  // Recovery asked the owner about the cut-off step on the run that carried the turn on (askOwner, src/never-break/resume.ts).
  const next = carryOn(app, parentRunId, sessionId);
  app.store.event(next.id, "tool.started", { name: "files.write", id: "w1" });
  app.store.event(next.id, "tool.completed", { name: "files.write", id: "w1", result: {} });
  app.store.event(next.id, "tool.started", { name: "chaos.send", id: "s1" });
  app.store.finish(next.id, "needs_input", "Should I check first?");
  app.store.event(next.id, "attention.needed", { question: "Should I check first?", afterRestart: true });
  const report = app.teams.reconcile(taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.toolCallId, e.outcome]), [["w1", "completed"], ["s1", "unknown"]], "recovery's question says nothing about the cut-off step");
  assert.match(new TeamTasks(app.store).get({ owner: app.runtime.owner, source: "window" }, taskId).error, /Should I check first/);
});

test("a turn waiting on the owner with a step whose outcome is unknown needs reconciliation", async (t) => {
  const { app, taskId, parentRunId } = await crashedTurn(t);
  // A write that never reported back, then a question: the question's own call is known, the write is not.
  app.store.event(parentRunId, "tool.started", { name: "files.write", id: "w1" });
  app.store.event(parentRunId, "tool.started", { name: "user.ask", id: "q1" });
  app.store.finish(parentRunId, "needs_input", "Which folder?");
  app.store.event(parentRunId, "attention.needed", { question: "Which folder?" });
  const report = app.teams.reconcile(taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.toolCallId, e.outcome]), [["w1", "unknown"], ["q1", "asked_owner"]]);
});

test("reconcile leaves a task alone while its turn is held here, even before any run exists", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider);
  const requestId = randomUUID();
  const never = { run: () => new Promise(() => {}) };
  void state.app.teams.run(never, knowledge, team.id, "wait", { requestId });
  await new Promise((resolve) => setImmediate(resolve));
  const task = row(state.app, requestId);
  assert.equal(task.parent_run_id, null);
  assert.equal(state.app.teams.reconcile(task.task_id).state, "claimed");
  assert.equal(row(state.app, requestId).state, "claimed");
});

test("a throw after the result was recorded leaves the task for reconcile to finish, not for a person", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider);
  const requestId = randomUUID();
  const complete = TeamTasks.prototype.complete;
  TeamTasks.prototype.complete = function broken() { throw new Error("disk full while finishing"); };
  t.after(() => { TeamTasks.prototype.complete = complete; });
  await assert.rejects(state.app.teams.run(state.app.runtime, knowledge, team.id, "sum up", { requestId }), /disk full/);
  TeamTasks.prototype.complete = complete;
  const task = row(state.app, requestId);
  assert.equal(task.state, "claimed");
  assert.ok(JSON.parse(task.result).answers, "the result is kept on the task");
  assert.equal(state.app.teams.reconcile(task.task_id).state, "completed");
});

test("a reused tool call id is paired with the latest start still open", async (t) => {
  const { state } = await fixture(t, scripted());
  const run = state.app.store.createRun(state.app.runtime.owner, "calls");
  const ev = (kind, id) => state.app.store.event(run.id, kind, { name: "files.write", id });
  ev("tool.started", "x"); ev("tool.started", "x"); ev("tool.completed", "x");
  assert.deepEqual(turnEffects(state.app.store, run.id).map((e) => e.outcome), ["unknown", "completed"]);
  const other = state.app.store.createRun(state.app.runtime.owner, "calls again");
  const ev2 = (kind) => state.app.store.event(other.id, kind, { name: "files.write", id: "y" });
  ev2("tool.started"); ev2("tool.completed"); ev2("tool.started"); ev2("tool.failed");
  assert.deepEqual(turnEffects(state.app.store, other.id).map((e) => e.outcome), ["completed", "failed"]);
  // Two open starts and two endings: the second ending goes to the start still open, never the one already ended.
  const third = state.app.store.createRun(state.app.runtime.owner, "calls a third time");
  const ev3 = (kind) => state.app.store.event(third.id, kind, { name: "files.write", id: "z" });
  ev3("tool.started"); ev3("tool.started"); ev3("tool.completed"); ev3("tool.failed");
  assert.deepEqual(turnEffects(state.app.store, third.id).map((e) => e.outcome), ["failed", "completed"]);
});

test("a parent run the runtime never announces is refused before any member starts", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider);
  const silent = { run: (options) => state.app.runtime.run({ ...options, onStarted: undefined }), context: (o) => state.app.runtime.context(o), fanout: (...a) => state.app.runtime.fanout(...a) };
  await assert.rejects(state.app.teams.run(silent, knowledge, team.id, "go", { requestId: randomUUID() }), /could not be linked/);
  assert.equal(provider.memberCalls, 0);
});

test("effects are found however deep the runs under the turn go", async (t) => {
  const { app, taskId, parentRunId } = await crashedTurn(t);
  app.store.finish(parentRunId, "failed", "stopped for good");
  const child = app.store.createRun(app.runtime.owner, "child");
  app.store.event(child.id, "run.started", { parentRunId });
  app.store.finish(child.id, "failed", "stopped");
  const grandchild = app.store.createRun(app.runtime.owner, "grandchild");
  app.store.event(grandchild.id, "run.started", { parentRunId: child.id });
  app.store.event(grandchild.id, "tool.started", { name: "files.write", id: "deep" });
  app.store.finish(grandchild.id, "failed", "stopped");
  const report = app.teams.reconcile(taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.effects.map((e) => [e.runId, e.toolCallId]), [[grandchild.id, "deep"]]);
});

test("a live parent turn that ends interrupted is not settled as failed", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider);
  const requestId = randomUUID();
  const cut = { run: (options) => { const run = state.app.store.createRun(state.app.runtime.owner, "team parent", options.sessionId); options.onStarted(run);
    state.app.store.finish(run.id, "interrupted", "Branch is closing"); return Promise.resolve({ ...state.app.store.run(run.id) }); } };
  const seen = await state.app.teams.run(cut, knowledge, team.id, "go", { requestId });
  assert.equal(seen.state, "needs_reconciliation");
  assert.equal(provider.memberCalls, 0);
});

test("a parent turn that asks the owner through a tool of its own waits for the owner, with the asking call known", async (t) => {
  const ask = { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which folder?" }) }] };
  const provider = scripted([() => ask, () => say("parent done")]);
  const { state, team } = await fixture(t, provider);
  const seen = await state.app.teams.run(state.app.runtime, knowledge, team.id, "tidy", { requestId: randomUUID() });
  assert.equal(state.app.store.run(seen.parentRunId).status, "needs_input");
  assert.equal(seen.state, "waiting_owner");
  assert.match(seen.question, /Which folder/);
  assert.deepEqual(seen.effects.map((e) => [e.name, e.outcome]), [["user.ask", "asked_owner"]]);
  assert.equal(provider.memberCalls, 0);
});

test("recovery carries on a team turn the task did name", async (t) => {
  const { app, parentRunId } = await crashedTurn(t);
  const resumed = [];
  const runtime = new Proxy(app.runtime, { get: (target, key) => (key === "resume" ? (id) => { resumed.push(id); return Promise.resolve(); } : Reflect.get(target, key)) });
  const report = await recoverAfterRestart({ store: app.store, runtime, journal: app.neverBreak.journal, mode: "on" });
  assert.deepEqual(report.filter((r) => r.runId === parentRunId).map((r) => r.outcome), ["resumed"]);
  assert.deepEqual(resumed, [parentRunId]);
});

test("a crash after a too-large result was recorded is finished from that record: completed, never 'nothing was done'", async (t) => {
  const provider = scripted();
  const { state, team, reopen } = await fixture(t, provider);
  const owner = state.app.runtime.owner;
  // A model answer is at most 65,536 characters and the real fanout runs at most 4 members at once, so
  // the members' runs are written directly here with answers long enough to go over the 512,000 kept.
  const huge = "y".repeat(300_000);
  const writers = { run: (options) => state.app.runtime.run(options), context: (o) => state.app.runtime.context(o),
    async fanout(context, tasks) {
      return { tasks: Object.fromEntries(tasks.map((task) => {
        const member = state.app.store.createRun(owner, task.prompt);
        state.app.store.event(member.id, "run.started", { parentRunId: context.runId });
        state.app.store.finish(member.id, "completed", `${task.id} ${huge}`);
        return [task.id, { status: "completed", output: `${task.id} ${huge}`, runId: member.id }];
      })) };
    } };
  const requestId = randomUUID();
  // The process "dies" after the outcome was recorded (too large, so without the answers' text) and before completion.
  const complete = TeamTasks.prototype.complete;
  TeamTasks.prototype.complete = function skipped() {};
  t.after(() => { TeamTasks.prototype.complete = complete; });
  const lost = await state.app.teams.run(writers, knowledge, team.id, "write at length", { requestId });
  TeamTasks.prototype.complete = complete;
  assert.equal(lost.answers.length, 2);
  const stored = JSON.parse(row(state.app, requestId).result);
  assert.equal(stored.truncated, true);
  assert.deepEqual(stored.answers.map((a) => a.runId), lost.answers.map((a) => a.runId), "the record keeps each member's run");
  assert.equal(row(state.app, requestId).state, "claimed");
  const roomBefore = state.app.teams.room(team.id).length;
  const after = scripted();
  const app = await reopen(after);
  const retry = counted(app.runtime);
  const seen = await app.teams.run(retry, knowledge, team.id, "write at length", { requestId });
  assert.equal(seen.state, "completed");
  assert.equal(seen.truncated, true);
  assert.equal(seen.roomSessionId, team.roomSessionId);
  assert.match(seen.note, /too large to keep for a repeat.*Every answer is in the team's room/);
  assert.doesNotMatch(row(app, requestId).error ?? "", /Nothing was done/);
  const answers = app.teams.room(team.id).slice(roomBefore);
  assert.deepEqual(answers.map((m) => m.content.length > huge.length), [true, true], "each member's answer reached the room, read back from its own run");
  assert.equal(retry.dispatches + after.parentCalls + after.memberCalls, 0, "nothing was run again");
});

test("members that finished answering with no tool call, and no outcome recorded, need reconciliation, not failed", async (t) => {
  const provider = scripted();
  const { state, team, reopen } = await fixture(t, provider);
  const requestId = randomUUID();
  const { recordOutcome, complete } = TeamTasks.prototype;
  TeamTasks.prototype.recordOutcome = function skipped() {};
  TeamTasks.prototype.complete = function skipped() {};
  t.after(() => Object.assign(TeamTasks.prototype, { recordOutcome, complete }));
  const lost = await state.app.teams.run(state.app.runtime, knowledge, team.id, "just talk", { requestId });
  Object.assign(TeamTasks.prototype, { recordOutcome, complete });
  assert.equal(row(state.app, requestId).result, null);
  const app = await reopen(scripted());
  const report = app.teams.reconcile(lost.taskId);
  assert.deepEqual(report.effects, [], "no tool call was made");
  assert.equal(report.state, "needs_reconciliation");
  assert.match(row(app, requestId).error, /2 member\(s\) finished an answer/);
});

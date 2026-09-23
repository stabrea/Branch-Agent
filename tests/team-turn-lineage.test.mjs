import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { TeamTasks } from "../dist/team-tasks.js";

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
  assert.equal((await app.teams.run(retry, knowledge, team.id, "summarise", { requestId })).state, "claimed");
  const report = app.teams.reconcile(lost.taskId);
  assert.equal(report.state, "completed");
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

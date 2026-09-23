import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Teams } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { TeamTasks, StaleTeamTaskClaimError } from "../dist/team-tasks.js";

// Q61: one durable identity and one claimant per team request. Inert runtimes only: nothing here
// calls a model or does anything outside the disposable store.
const inertProvider = { name: "inert", async complete() { return { content: "ok", toolCalls: [] }; } };
const knowledge = { activeSpecialist: () => ({}) };

async function open(root) {
  return createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: inertProvider });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-claims-"));
  const state = { app: await open(root) };
  t.after(async () => { await state.app.close().catch(() => undefined); await discardTemp(root); });
  const owner = state.app.runtime.owner;
  const members = ["planner", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    state.app.store.save("specialists", owner, specialistId, { id: specialistId, name: role });
    return { specialistId, role, brief: "" };
  });
  const team = state.app.teams.save({ name: "Crew", members });
  const reopen = async () => { await state.app.close(); state.app = await open(root); return state.app; };
  return { state, owner, team, reopen, root };
}
/** A runtime that counts dispatches, can be held open, can throw after dispatch and can fail members. */
function inertRuntime(store, owner, options = {}) {
  const runtime = { dispatches: 0, async run() {
    runtime.dispatches++;
    const parent = store.createRun(owner, "team parent");
    if (options.hold) await options.hold;
    return { id: parent.id };
  }, context: ({ runId }) => ({ runId }), async fanout(_context, tasks) {
    if (options.throwAfterDispatch) throw new Error("the connection dropped after the members started");
    return { tasks: Object.fromEntries(tasks.map((task, index) => {
      const failed = options.failed?.includes(index);
      return [task.id, { status: failed ? "failed" : "completed", output: failed ? "" : `answer ${index}`, runId: `child-${index}` }];
    })) };
  } };
  return runtime;
}

test("two service instances racing on one request make one claim and one runtime dispatch", async (t) => {
  const { state, owner, team } = await fixture(t);
  let release; const hold = new Promise((resolve) => { release = resolve; });
  const runtime = inertRuntime(state.app.store, owner, { hold });
  const first = new Teams(state.app.store, owner), second = new Teams(state.app.store, owner);
  const requestId = randomUUID();
  const winner = first.run(runtime, knowledge, team.id, "ship it", { requestId });
  // If the second instance dispatched too, it would wait on the hold forever; give up after 3s and release it.
  const gaveUp = new Promise((resolve) => setTimeout(() => { release(); resolve({ state: "dispatched a second time" }); }, 3000).unref());
  const loser = await Promise.race([second.run(runtime, knowledge, team.id, "ship it", { requestId }), gaveUp]);
  assert.equal(loser.state, "claimed");
  assert.equal(loser.answers, undefined, "a caller that did not win sees only the state, never a result");
  release();
  const done = await winner;
  assert.equal(done.state, "completed");
  assert.equal(done.taskId, loser.taskId);
  const again = await second.run(runtime, knowledge, team.id, "ship it", { requestId });
  assert.deepEqual(again.answers, done.answers);
  assert.equal(runtime.dispatches, 1);
});

test("a finished request survives a restart, a new request id runs new work, and a changed request under a reused id is refused", async (t) => {
  const { state, owner, team, reopen } = await fixture(t);
  const requestId = randomUUID();
  const done = await state.app.teams.run(inertRuntime(state.app.store, owner), knowledge, team.id, "plan", { requestId });
  const app = await reopen();
  const runtime = inertRuntime(app.store, owner);
  const again = await app.teams.run(runtime, knowledge, team.id, "plan", { requestId });
  assert.equal(again.taskId, done.taskId);
  assert.deepEqual(again.answers, done.answers);
  assert.equal(runtime.dispatches, 0);
  await assert.rejects(app.teams.run(runtime, knowledge, team.id, "a different plan", { requestId }), /already used for a different request/);
  const changed = app.teams.save({ id: team.id, name: team.name, members: team.members.map((m) => ({ ...m, role: `${m.role} lead` })) });
  await assert.rejects(app.teams.run(runtime, knowledge, changed.id, "plan", { requestId }), /different team/);
  const fresh = await app.teams.run(runtime, knowledge, team.id, "plan", { requestId: randomUUID() });
  assert.notEqual(fresh.taskId, done.taskId);
  assert.equal(runtime.dispatches, 1);
});

test("another source cannot observe or finish a task, and the run route refuses owner or source in the body", async (t) => {
  const { state, owner, team, root } = await fixture(t);
  const requestId = randomUUID();
  const runtime = inertRuntime(state.app.store, owner);
  const mine = await state.app.teams.run(runtime, knowledge, team.id, "plan", { requestId, source: "window" });
  const theirs = await state.app.teams.run(runtime, knowledge, team.id, "plan", { requestId, source: "person:someone" });
  assert.notEqual(theirs.taskId, mine.taskId, "the same request id from another source is a different task");
  assert.equal(runtime.dispatches, 2);
  const tasks = new TeamTasks(state.app.store);
  assert.equal(tasks.get({ owner, source: "person:someone" }, mine.taskId), undefined);
  assert.equal(tasks.get({ owner: "someone-else", source: "window" }, mine.taskId), undefined);
  const scope = { owner, source: "profile:kid" };
  const pending = tasks.observe(scope, team.id, randomUUID(), "f");
  const claim = tasks.claim(scope, pending.taskId);
  assert.throws(() => tasks.complete({ ...claim, scope: { owner, source: "window" } }, { forged: true }, () => {}), StaleTeamTaskClaimError);
  assert.equal(tasks.get(scope, pending.taskId).state, "claimed");
  const server = await startServer(state.app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  for (const extra of [{ owner: "someone" }, { source: "window" }]) {
    const response = await fetch(`${server.url}/api/teams/${team.id}/run`, { method: "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ prompt: "plan", requestId, ...extra }) });
    assert.equal(response.ok, false, `a body carrying ${Object.keys(extra)[0]} is refused`);
  }
});

test("a wrong claimant or an old generation cannot finish a task, and the row is left unchanged", async (t) => {
  const { state, owner, team } = await fixture(t);
  const tasks = new TeamTasks(state.app.store);
  const scope = { owner, source: "window" };
  const task = tasks.observe(scope, team.id, randomUUID(), "f");
  const claim = tasks.claim(scope, task.taskId);
  assert.equal(tasks.claim(scope, task.taskId), null, "a claimed task cannot be claimed again");
  const before = tasks.get(scope, task.taskId);
  let wrote = false;
  assert.throws(() => tasks.complete({ ...claim, claimant: randomUUID() }, { answers: [] }, () => { wrote = true; }), StaleTeamTaskClaimError);
  assert.throws(() => tasks.complete({ ...claim, generation: claim.generation - 1 }, { answers: [] }, () => { wrote = true; }), StaleTeamTaskClaimError);
  assert.throws(() => tasks.linkParentRun({ ...claim, generation: claim.generation + 1 }, "run"), StaleTeamTaskClaimError);
  assert.equal(wrote, false);
  assert.deepEqual(tasks.get(scope, task.taskId), before);
  const room = state.app.teams.room(team.id).length;
  assert.throws(() => tasks.complete(claim, { answers: [] }, () => {
    state.app.store.message(team.roomSessionId, { role: "assistant", content: "half written" });
    throw new Error("room write failed");
  }), /room write failed/);
  assert.equal(tasks.get(scope, task.taskId).state, "claimed", "a failed room write rolls the completion back");
  assert.equal(state.app.teams.room(team.id).length, room);
});

test("a throw after dispatch leaves the task uncertain across a restart, and a retry never runs it again", async (t) => {
  const { state, owner, team, reopen } = await fixture(t);
  const requestId = randomUUID();
  const runtime = inertRuntime(state.app.store, owner, { throwAfterDispatch: true });
  await assert.rejects(state.app.teams.run(runtime, knowledge, team.id, "deploy", { requestId }), /connection dropped/);
  const app = await reopen();
  const retry = inertRuntime(app.store, owner);
  const seen = await app.teams.run(retry, knowledge, team.id, "deploy", { requestId });
  assert.equal(seen.state, "uncertain");
  assert.equal(seen.answers, undefined);
  assert.equal(retry.dispatches, 0);
  const task = new TeamTasks(app.store).get({ owner, source: "window" }, seen.taskId);
  assert.ok(task.parentRunId, "the parent run is linked so the uncertain task can be traced");
  assert.match(task.error, /connection dropped/);
});

test("team fanout and the ordered room history still work, and failed members keep their real outcome", async (t) => {
  const { state, owner, team } = await fixture(t);
  const runtime = inertRuntime(state.app.store, owner, { failed: [1] });
  const first = await state.app.teams.run(runtime, knowledge, team.id, "review the patch");
  await state.app.teams.run(runtime, knowledge, team.id, "review the patch");
  assert.equal(runtime.dispatches, 2, "without a request id every call is new work, as before");
  assert.deepEqual(first.answers.map((a) => [a.role, a.status]), [["planner", "completed"], ["reviewer", "failed"]]);
  assert.equal(first.state, "completed");
  assert.ok(first.parentRunId && first.roomSessionId);
  const room = state.app.teams.room(team.id).map((m) => `${m.role}: ${m.content}`);
  assert.deepEqual(room.slice(1, 4), ["user: review the patch", "assistant: [planner] answer 0", "assistant: [reviewer] (no answer: failed)"]);
  assert.equal(room.length, 7);
});

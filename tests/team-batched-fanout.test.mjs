import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";

// Q66: a team holds up to 8 members, but the runtime starts at most `parallelSubtasks` children of
// one run at once. The team's fan-out goes in batches of that size, in member order, each batch
// finishing before the next starts. Real runtimes with a scripted model; no fake fan-out.
const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };
const say = (content) => ({ content, toolCalls: [] });
const memberOf = (request) => {
  const found = /Your role in team \\?"Crew\\?": r(\d)\./.exec(JSON.stringify(request.messages));
  return found ? Number(found[1]) : null;
};

/** A model that answers the team's own turn at once and each member after a short wait, counting how many members are live. */
function scripted({ fail = [] } = {}) {
  const provider = { name: "scripted", parentCalls: 0, memberCalls: 0, live: 0, maxLive: 0, started: [],
    async complete(request) {
      const member = memberOf(request);
      if (member === null) { provider.parentCalls++; return say("parent done"); }
      provider.memberCalls++;
      provider.started.push(member);
      provider.live++;
      provider.maxLive = Math.max(provider.maxLive, provider.live);
      try {
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (fail.includes(member)) throw new Error(`member r${member} could not answer`);
        return say(`answer from r${member}`);
      } finally { provider.live--; }
    } };
  return provider;
}
async function fixture(t, provider, size) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-batches-"));
  const open = (p) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: p });
  const state = { app: await open(provider) };
  t.after(async () => { await state.app.close().catch(() => undefined); await discardTemp(root); });
  const owner = state.app.runtime.owner;
  const members = Array.from({ length: size }, (_, index) => {
    const specialistId = randomUUID();
    state.app.store.save("specialists", owner, specialistId, { id: specialistId, name: `r${index}` });
    return { specialistId, role: `r${index}`, brief: "" };
  });
  const team = state.app.teams.save({ name: "Crew", members });
  const reopen = async (next) => { await state.app.close(); state.app = await open(next); return state.app; };
  return { state, owner, team, reopen };
}
/** The real runtime, counting team dispatches and fan-out calls; `onFanout(n)` may throw or hang the n-th call (from 1). */
function counted(runtime, onFanout = () => undefined) {
  const wrapper = { dispatches: 0, fanouts: 0, batches: [],
    run: (options) => { wrapper.dispatches++; return runtime.run(options); },
    context: (options) => runtime.context(options),
    fanout: (context, tasks, resolve) => {
      wrapper.fanouts++;
      const stop = onFanout(wrapper.fanouts);
      if (stop) return stop;
      wrapper.batches.push(tasks.map((task) => Number(task.id.slice(1))));
      return runtime.fanout(context, tasks, resolve);
    } };
  return wrapper;
}
const row = (app, requestId) => app.store.sqlite.prepare("SELECT * FROM team_tasks WHERE request_id=?").get(requestId);
const answersInRoom = (app, team) => app.teams.room(team.id).filter((m) => m.role === "assistant").map((m) => m.content);

test("a team of 6 on the real runtime answers in full, in member order, with no concurrency error", async (t) => {
  const provider = scripted();
  const { state, team } = await fixture(t, provider, 6);
  const done = await state.app.teams.run(state.app.runtime, knowledge, team.id, "plan the launch", { requestId: randomUUID() });
  assert.equal(done.state, "completed");
  assert.deepEqual(done.answers.map((a) => [a.role, a.status, a.output]),
    [0, 1, 2, 3, 4, 5].map((i) => [`r${i}`, "completed", `answer from r${i}`]));
  assert.ok(done.answers.every((a) => !/concurrency limit/.test(a.output)));
  assert.deepEqual(answersInRoom(state.app, team), [0, 1, 2, 3, 4, 5].map((i) => `[r${i}] answer from r${i}`));
  assert.equal(provider.memberCalls, 6);
  assert.equal(provider.maxLive, 4, "the shipped limit of 4 is used in full, never exceeded");
});

test("with the owner's limit at 2, a team of 5 goes in batches of 2, 2 and 1, never more than 2 live", async (t) => {
  const provider = scripted();
  const { state, owner, team } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const runtime = counted(state.app.runtime);
  const done = await state.app.teams.run(runtime, knowledge, team.id, "review the plan", { requestId: randomUUID() });
  assert.equal(done.state, "completed");
  assert.deepEqual(runtime.batches, [[0, 1], [2, 3], [4]]);
  assert.equal(provider.maxLive, 2, "each batch runs its members together, and no more than the limit");
  assert.deepEqual([provider.started.slice(0, 2).sort(), provider.started.slice(2, 4).sort(), provider.started.slice(4)], [[0, 1], [2, 3], [4]],
    "a batch starts only after the one before it has finished");
  assert.deepEqual(answersInRoom(state.app, team), [0, 1, 2, 3, 4].map((i) => `[r${i}] answer from r${i}`));
});

test("a throw between batch 1 and batch 2 needs reconciliation, lists batch 1's member runs, and never runs the rest", async (t) => {
  const provider = scripted();
  const { state, owner, team, reopen } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  const broken = counted(state.app.runtime, (n) => (n === 2 ? Promise.reject(new Error("injected: stopped between batches")) : undefined));
  await assert.rejects(state.app.teams.run(broken, knowledge, team.id, "ship it", { requestId }), /stopped between batches/);
  assert.equal(provider.memberCalls, 2, "only batch 1 ran");
  const task = row(state.app, requestId);
  assert.equal(task.state, "needs_reconciliation");
  assert.match(task.error, /r0 \(completed, run [0-9a-f-]+\), r1 \(completed/);
  assert.match(task.error, /Not run: r2 \(not started\), r3 \(not started\), r4 \(not started\)/);
  const after = scripted();
  const app = await reopen(after);
  const retry = counted(app.runtime);
  const seen = await app.teams.run(retry, knowledge, team.id, "ship it", { requestId });
  assert.equal(seen.state, "needs_reconciliation");
  const report = app.teams.reconcile(task.task_id);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.members.map((m) => [m.role, m.status]),
    [["r0", "completed"], ["r1", "completed"], ["r2", "not_started"], ["r3", "not_started"], ["r4", "not_started"]]);
  assert.ok(report.members.slice(0, 2).every((m) => app.store.run(m.runId)?.status === "completed"));
  assert.equal(retry.dispatches + after.parentCalls + after.memberCalls, 0, "nothing is redispatched");
});

test("a process that dies after batch 2 of 3 is reconciled from both finished batches, with no redispatch", async (t) => {
  const provider = scripted();
  const { state, owner, team, reopen } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  let reachedThird;
  const third = new Promise((resolve) => { reachedThird = resolve; });
  // The third fan-out call never returns: the process "dies" between batch 2 and batch 3.
  const dying = counted(state.app.runtime, (n) => (n === 3 ? (reachedThird(), new Promise(() => {})) : undefined));
  void state.app.teams.run(dying, knowledge, team.id, "file the notes", { requestId });
  await third;
  assert.equal(provider.memberCalls, 4);
  const taskId = row(state.app, requestId).task_id;
  const after = scripted();
  const app = await reopen(after);
  const report = app.teams.reconcile(taskId);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.members.map((m) => [m.role, m.status]),
    [["r0", "completed"], ["r1", "completed"], ["r2", "completed"], ["r3", "completed"], ["r4", "not_started"]]);
  assert.equal(new Set(report.members.slice(0, 4).map((m) => m.runId)).size, 4, "every member run from both batches is found");
  const error = row(app, requestId).error;
  assert.match(error, /4 member\(s\) finished an answer/);
  assert.match(error, /r3 \(completed, run /);
  assert.match(error, /Not run: r4 \(not started\)/);
  const retry = counted(app.runtime);
  assert.equal((await app.teams.run(retry, knowledge, team.id, "file the notes", { requestId })).state, "needs_reconciliation");
  assert.equal(retry.dispatches + after.parentCalls + after.memberCalls, 0, "the unfinished rest is not redispatched");
});

test("a failed member in batch 1 keeps its real outcome and later batches still run", async (t) => {
  const provider = scripted({ fail: [1] });
  const { state, owner, team } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const runtime = counted(state.app.runtime);
  const done = await state.app.teams.run(runtime, knowledge, team.id, "check the numbers", { requestId: randomUUID() });
  assert.equal(done.state, "completed");
  assert.deepEqual(runtime.batches, [[0, 1], [2, 3], [4]]);
  assert.deepEqual(done.answers.map((a) => [a.role, a.status]),
    [["r0", "completed"], ["r1", "failed"], ["r2", "completed"], ["r3", "completed"], ["r4", "completed"]]);
  const room = answersInRoom(state.app, team);
  assert.equal(room.length, 5);
  assert.equal(room[0], "[r0] answer from r0");
  assert.match(room[1], /^\[r1\] /);
  assert.deepEqual(room.slice(2), [2, 3, 4].map((i) => `[r${i}] answer from r${i}`));
});

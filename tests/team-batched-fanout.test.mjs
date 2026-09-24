import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

/**
 * A model that answers the team's own turn at once and each member after a wait, counting how many
 * members are live. The wait is long enough that every member of a batch is live together even on a
 * busy machine, so the exact concurrency counts below hold.
 */
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
        await new Promise((resolve) => setTimeout(resolve, 300));
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
  return { state, owner, team, reopen, workspace: join(root, "workspace") };
}
/**
 * A runtime whose first fan-out call is the real one and whose next "dies": `later(context, tasks)`
 * writes what that batch got done, then the call never returns, as when the process is killed.
 */
function diesInBatch2(state, later) {
  let reached;
  const died = new Promise((resolve) => { reached = resolve; });
  const runtime = { run: (o) => state.app.runtime.run(o), context: (o) => state.app.runtime.context(o), fanouts: 0,
    async fanout(context, tasks, resolve) {
      if (++runtime.fanouts === 1) return state.app.runtime.fanout(context, tasks, resolve);
      await later(context, tasks);
      reached();
      return new Promise(() => {});
    } };
  return { runtime, died };
}
/** A member run started under the turn, as the runtime starts one, left with `status`. */
function memberRun(app, owner, context, task, status, output = "") {
  const run = app.store.createRun(owner, task.prompt);
  app.store.event(run.id, "run.started", { parentRunId: context.runId });
  app.store.finish(run.id, status, output);
  return run;
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

test("a limit the owner changes during a turn is followed from the next batch, with no concurrency error", async (t) => {
  /* NAS adversarial check of Q66: reading the limit once before the loop left every other test green. */
  const provider = scripted();
  const { state, owner, team } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 3 });
  // Once the first batch has finished, and before the next is cut, the owner lowers the limit to 1.
  const runtime = counted(state.app.runtime);
  const fanout = runtime.fanout;
  runtime.fanout = async (...args) => {
    const outcome = await fanout(...args);
    if (runtime.fanouts === 1) saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 1 });
    return outcome;
  };
  const result = await state.app.teams.run(runtime, knowledge, team.id, "ship it", { requestId: randomUUID() });
  assert.equal(result.state, "completed");
  assert.deepEqual(runtime.batches, [[0, 1, 2], [3], [4]]);
  assert.deepEqual(answersInRoom(state.app, team), [0, 1, 2, 3, 4].map((i) => `[r${i}] answer from r${i}`));
});

test("a long error never pushes the member list out of the stored reason", async (t) => {
  /* NAS review of Q66: the reason is cut at 2000 characters, and the member list used to come after the error. */
  const provider = scripted();
  const { state, owner, team } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  const broken = counted(state.app.runtime, (n) => (n === 2 ? Promise.reject(new Error(`injected ${"x".repeat(3000)}`)) : undefined));
  await assert.rejects(state.app.teams.run(broken, knowledge, team.id, "ship it", { requestId }), /injected/);
  const task = row(state.app, requestId);
  assert.equal(task.state, "needs_reconciliation");
  assert.match(task.error, /Not run: r2 \(not started\), r3 \(not started\), r4 \(not started\)/);
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
  // Batch 1's answers are kept in its member runs, which the listing names; the room gets them only when a person settles the task.
  assert.deepEqual(report.members.slice(0, 2).map((m) => app.store.run(m.runId)?.output), ["answer from r0", "answer from r1"]);
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
  assert.deepEqual(report.members.slice(0, 4).map((m) => app.store.run(m.runId)?.output), [0, 1, 2, 3].map((i) => `answer from r${i}`));
  const error = row(app, requestId).error;
  assert.match(error, /4 member\(s\) finished an answer/);
  assert.match(error, /r3 \(completed, run /);
  assert.match(error, /Not run: r4 \(not started\)/);
  const retry = counted(app.runtime);
  assert.equal((await app.teams.run(retry, knowledge, team.id, "file the notes", { requestId })).state, "needs_reconciliation");
  assert.equal(retry.dispatches + after.parentCalls + after.memberCalls, 0, "the unfinished rest is not redispatched");
});

test("members of the first batch whose conversations are deleted after a crash are never read as 'nothing was done'", async (t) => {
  /* Team stack review: a member deleted after a crash must not settle "failed". The delete marks the task
     itself, so this holds whichever batch the member was in. */
  const provider = scripted();
  const { state, owner, team, reopen } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  const members = [];
  let reachedFirst;
  const first = new Promise((resolve) => { reachedFirst = resolve; });
  // The first batch's members start and write, then the process "dies" before that batch's record is written.
  const dying = { run: (options) => state.app.runtime.run(options), context: (o) => state.app.runtime.context(o),
    fanout(context, tasks) {
      for (const task of tasks) {
        const member = state.app.store.createRun(owner, task.prompt);
        state.app.store.event(member.id, "run.started", { parentRunId: context.runId });
        state.app.store.finish(member.id, "completed", `${task.id} wrote a file`);
        members.push(member.id);
      }
      reachedFirst();
      return new Promise(() => {});
    } };
  void state.app.teams.run(dying, knowledge, team.id, "file the notes", { requestId });
  await first;
  assert.equal(members.length, 2, "the first batch of 2 was sent");
  const after = scripted();
  const app = await reopen(after);
  for (const runId of members) app.store.forgetSession(owner, app.store.run(runId).sessionId);
  const report = app.teams.reconcile(row(app, requestId).task_id);
  assert.equal(report.state, "needs_reconciliation", "a member's conversation was deleted, so what it did cannot be known");
  assert.match(row(app, requestId).error ?? "", /conversation was deleted/);
  assert.equal(after.parentCalls + after.memberCalls, 0, "nothing was run again");
});

test("a crash in the first batch with nothing deleted is not read as a deleted conversation, and its unrecorded runs are listed once", async (t) => {
  /* Nothing was deleted, so the task carries no mark. The two runs no record names are both batch 1's, and which is
     whose cannot be told, so they are listed once under that batch (Legion, Q66 finding 3), never also as "unnamed". */
  const provider = scripted();
  const { state, owner, team, reopen } = await fixture(t, provider, 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  let reachedFirst;
  const first = new Promise((resolve) => { reachedFirst = resolve; });
  const dying = { run: (options) => state.app.runtime.run(options), context: (o) => state.app.runtime.context(o),
    fanout(context, tasks) {
      for (const task of tasks) {
        const member = state.app.store.createRun(owner, task.prompt);
        state.app.store.event(member.id, "run.started", { parentRunId: context.runId });
        state.app.store.finish(member.id, "completed", `${task.id} answered`);
      }
      reachedFirst();
      return new Promise(() => {});
    } };
  void state.app.teams.run(dying, knowledge, team.id, "file the notes", { requestId });
  await first;
  const app = await reopen(scripted());
  const report = app.teams.reconcile(row(app, requestId).task_id);
  assert.equal(report.state, "needs_reconciliation");
  assert.doesNotMatch(row(app, requestId).error ?? "", /conversation was deleted/, "nothing was deleted");
  assert.match(row(app, requestId).error ?? "", /2 member\(s\) finished an answer/);
  assert.match(row(app, requestId).error, /Members that ran: none\. Members of batch 1 whose runs were not recorded: r0, r1 \(runs [0-9a-f-]+ \(completed\), [0-9a-f-]+ \(completed\)\)\. Not run: r2 \(not started\), r3 \(not started\), r4 \(not started\)\./);
  assert.doesNotMatch(row(app, requestId).error, /unnamed member|run not recorded\)|not matched/);
  assert.deepEqual(report.members.map((m) => [m.role, m.status, m.batch, !!m.runId]),
    [["r0", "started", 1, false], ["r1", "started", 1, false], ["r2", "not_started", null, false], ["r3", "not_started", null, false], ["r4", "not_started", null, false],
      [null, "completed", 1, true], [null, "completed", 1, true]]);
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

test("a crash between batches whose later member's conversation is then deleted is never 'nothing was done'", async (t) => {
  /* Legion review of Q66 (finding 1): with parallelSubtasks=1, batch 1's member failed with no tool call and its
     fan-out was recorded; batch 2's member wrote reviewer.txt and the process was killed. Deleting that member's
     conversation then settled "failed", because the count stopped at the first batch with a fan-out record. */
  const { state, owner, team, reopen, workspace } = await fixture(t, scripted({ fail: [0] }), 2);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 1 });
  const requestId = randomUUID();
  let reviewer;
  const { runtime, died } = diesInBatch2(state, async (context, tasks) => {
    reviewer = state.app.store.createRun(owner, tasks[0].prompt);
    state.app.store.event(reviewer.id, "run.started", { parentRunId: context.runId });
    state.app.store.event(reviewer.id, "tool.started", { name: "files.write", id: "w1" });
    await writeFile(join(workspace, "reviewer.txt"), "reviewed");
    state.app.store.event(reviewer.id, "tool.completed", { name: "files.write", id: "w1", result: {} });
    state.app.store.finish(reviewer.id, "interrupted", "Branch is closing");
  });
  void state.app.teams.run(runtime, knowledge, team.id, "review it", { requestId });
  await died;
  const parentRunId = row(state.app, requestId).parent_run_id;
  const fanouts = state.app.store.events(parentRunId).filter((e) => e.kind === "delegation.fanout");
  assert.deepEqual(fanouts.map((e) => e.data.tasks.m0.status), ["failed"], "batch 1 is on record: its member failed");
  assert.deepEqual(state.app.store.events(fanouts[0].data.tasks.m0.runId).filter((e) => e.kind === "tool.started"), [], "with no tool call");
  const after = scripted();
  const app = await reopen(after);
  app.store.forgetSession(owner, reviewer.sessionId);
  const report = app.teams.reconcile(row(app, requestId).task_id);
  assert.equal(report.state, "needs_reconciliation");
  assert.doesNotMatch(row(app, requestId).error, /Nothing was done/);
  assert.match(row(app, requestId).error, /a member's conversation was deleted, so what it did cannot be known/);
  assert.equal(await readFile(join(workspace, "reviewer.txt"), "utf8"), "reviewed", "the reviewer's write is on disk");
  assert.equal(after.parentCalls + after.memberCalls, 0, "nothing was run again");
});

test("a crash after the members were sent and before any member started is 'nothing was done', never a deleted conversation", async (t) => {
  /* Legion review (finding 2): the batch count read this window as "a member's conversation was deleted". */
  const { state, owner, team, reopen } = await fixture(t, scripted(), 5);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const requestId = randomUUID();
  let reached;
  const sent = new Promise((resolve) => { reached = resolve; });
  const dying = { run: (o) => state.app.runtime.run(o), context: (o) => state.app.runtime.context(o), fanout() { reached(); return new Promise(() => {}); } };
  void state.app.teams.run(dying, knowledge, team.id, "file the notes", { requestId });
  await sent;
  const parentRunId = row(state.app, requestId).parent_run_id;
  assert.deepEqual(state.app.store.events(parentRunId).filter((e) => e.kind === "team.batch.started").map((e) => e.data.members), [["m0", "m1"]]);
  const app = await reopen(scripted());
  const report = app.teams.reconcile(row(app, requestId).task_id);
  assert.equal(report.state, "failed");
  assert.match(row(app, requestId).error, /Nothing was done/);
  assert.doesNotMatch(row(app, requestId).error, /deleted/);
});

test("a member whose run started and finished before a crash is listed once, with its run", async (t) => {
  /* Legion review (finding 3): it was listed as "Not run: r1 (started, run not recorded)" and again as "an unnamed member". */
  const { state, owner, team, reopen } = await fixture(t, scripted(), 2);
  saveKnobs(state.app.store, owner, "subtasks", { parallelSubtasks: 1 });
  const requestId = randomUUID();
  let reviewer;
  const { runtime, died } = diesInBatch2(state, (context, tasks) => { reviewer = memberRun(state.app, owner, context, tasks[0], "completed", "r1 wrote a file"); });
  void state.app.teams.run(runtime, knowledge, team.id, "review it", { requestId });
  await died;
  const app = await reopen(scripted());
  const report = app.teams.reconcile(row(app, requestId).task_id);
  assert.equal(report.state, "needs_reconciliation");
  assert.deepEqual(report.members.map((m) => [m.role, m.status, m.batch]), [["r0", "completed", 1], ["r1", "completed", 2]]);
  assert.equal(report.members[1].runId, reviewer.id, "batch 2 had one member and one run, so the run is that member's");
  const error = row(app, requestId).error;
  assert.match(error, new RegExp(`r1 \\(completed, run ${reviewer.id}\\)`));
  assert.equal(error.split(reviewer.id).length - 1, 1, "the run is named once");
  assert.doesNotMatch(error, /unnamed member|run not recorded|not matched/);
  assert.match(error, /Not run: none\./);
});

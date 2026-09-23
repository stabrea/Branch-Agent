import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Teams } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { TeamTasks, StaleTeamTaskClaimError, storeBoot } from "../dist/team-tasks.js";
import { TeamHandoffs, beginTeamTurn } from "../dist/team-handoff.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

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
  const runtime = { dispatches: 0, async run(runOptions) {
    runtime.dispatches++;
    const parent = store.createRun(owner, "team parent");
    // Q63: like the real runtime, the run is announced before it does anything, and settles as completed.
    runOptions.onStarted?.(parent);
    if (options.hold) await options.hold;
    return { id: parent.id, status: "completed", output: "" };
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

test("a throw after dispatch leaves the task needing reconciliation across a restart, and a retry never runs it again", async (t) => {
  const { state, owner, team, reopen } = await fixture(t);
  const requestId = randomUUID();
  const runtime = inertRuntime(state.app.store, owner, { throwAfterDispatch: true });
  await assert.rejects(state.app.teams.run(runtime, knowledge, team.id, "deploy", { requestId }), /connection dropped/);
  const app = await reopen();
  const retry = inertRuntime(app.store, owner);
  const seen = await app.teams.run(retry, knowledge, team.id, "deploy", { requestId });
  assert.equal(seen.state, "needs_reconciliation");
  assert.equal(seen.answers, undefined);
  assert.equal(retry.dispatches, 0);
  const task = new TeamTasks(app.store).get({ owner, source: "window" }, seen.taskId);
  assert.ok(task.parentRunId, "the parent run is linked so the unsettled task can be traced");
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

/** A served app whose team members are evaluated specialists, with a model that counts its calls. */
async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-route-"));
  const provider = { name: "scripted", requests: [], async complete(request) { provider.requests.push(request); return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const members = ["planner", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    const definition = { instructions: `You are the ${role}.`, permissions: ["files.read"] };
    app.store.save("specialists", owner, specialistId, { id: specialistId, name: role, version: 1, activeVersion: 1, evaluationPassed: true, definition, history: [] });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Crew", members });
  const post = async (body, key = server.token) => {
    const response = await fetch(`${server.url}/api/teams/${team.id}/run`, { method: "POST", headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const rows = () => app.store.sqlite.prepare("SELECT source, request_id, state FROM team_tasks ORDER BY created_at").all().map((r) => ({ ...r }));
  return { app, server, provider, team, post, rows, owner };
}

test("over HTTP, the owner window sending one request id twice runs the team once and gets the recorded result back", async (t) => {
  const { provider, post } = await served(t);
  const requestId = randomUUID();
  const first = await post({ prompt: "plan the release", requestId });
  assert.equal(first.status, 200);
  assert.equal(first.body.state, "completed");
  assert.equal(first.body.requestId, requestId);
  assert.equal(first.body.answers.length, 2);
  const calls = provider.requests.length;
  assert.ok(calls > 0);
  const second = await post({ prompt: "plan the release", requestId });
  assert.equal(second.status, 200);
  assert.equal(second.body.taskId, first.body.taskId);
  assert.equal(second.body.state, "completed");
  assert.deepEqual(second.body.answers, first.body.answers);
  assert.equal(second.body.parentRunId, first.body.parentRunId);
  assert.equal(provider.requests.length, calls, "the repeat never reached the model");
});

test("the route takes the source from the credentials: a run key, the window and a household profile each get their own task; a person key is refused", async (t) => {
  const { app, server, provider, post, rows, owner } = await served(t);
  const requestId = randomUUID();
  const windowRun = await post({ prompt: "plan", requestId });
  const calls = provider.requests.length;
  const key = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 });
  const keyRun = await post({ prompt: "plan", requestId }, key.token);
  assert.equal(keyRun.status, 200);
  assert.notEqual(keyRun.body.taskId, windowRun.body.taskId, "a run key never observes the window's task");
  assert.ok(provider.requests.length > calls, "the key's request is its own work");
  assert.equal((await post({ prompt: "plan", requestId })).body.taskId, windowRun.body.taskId, "and the window still sees only its own");
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const household = await post({ prompt: "plan", requestId });
  app.store.profiles.switch({ profileId: null });
  assert.equal(household.status, 200);
  assert.ok(![windowRun.body.taskId, keyRun.body.taskId].includes(household.body.taskId));
  assert.deepEqual(rows().map((r) => r.source), ["window", `key:${key.entry.id}`, `profile:${sam.id}`]);
  assert.equal((await fetch(`${server.url}/api/people/settings`, { method: "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ mode: "on" }) })).status, 200);
  const personKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const person = await post({ prompt: "plan", requestId }, personKey);
  assert.equal(person.status, 401);
  assert.match(person.body.error, /only their own page/);
  assert.equal(rows().length, 3, "a refused person key leaves no task behind");
});

test("a body naming an owner or a source is refused with 400 and no task is recorded", async (t) => {
  const { post, rows } = await served(t);
  for (const extra of [{ owner: "someone" }, { source: "window" }]) {
    const answer = await post({ prompt: "plan", requestId: randomUUID(), ...extra });
    assert.equal(answer.status, 400, `a body carrying ${Object.keys(extra)[0]}`);
  }
  assert.deepEqual(rows(), []);
});

test("event listeners hear about a finished team task only after it is committed, and one that throws or opens its own transaction breaks nothing", async (t) => {
  const { state, owner, team } = await fixture(t);
  const store = state.app.store;
  const heard = [];
  const stop = [store.onEvent((_run, kind) => {
    if (kind !== "team.ran") return;
    let ownTransaction = true;
    try { store.sqlite.exec("BEGIN"); store.sqlite.exec("COMMIT"); } catch { ownTransaction = false; }
    heard.push({ ownTransaction });
  }), store.onEvent((_run, kind) => { if (kind === "team.ran") throw new Error("a broken listener"); })];
  t.after(() => stop.forEach((off) => off()));
  const done = await state.app.teams.run(inertRuntime(store, owner), knowledge, team.id, "plan", { requestId: randomUUID() });
  assert.deepEqual(heard, [{ ownTransaction: true }], "the listener ran after the commit, outside any transaction");
  assert.equal(new TeamTasks(store).get({ owner, source: "window" }, done.taskId).state, "completed");
  assert.equal(store.events(done.parentRunId).filter((e) => e.kind === "team.ran").length, 1);
  assert.deepEqual(state.app.teams.room(team.id).slice(-2).map((m) => m.content), ["[planner] answer 0", "[reviewer] answer 1"]);
});

const taskRow = (app, requestId) => app.store.sqlite.prepare("SELECT * FROM team_tasks WHERE request_id=?").get(requestId);

test("a claim held by a process that died is never reported as claimed after a restart, and the same request id dispatches nothing", async (t) => {
  const { state, owner, team, reopen } = await fixture(t);
  const requestId = randomUUID();
  // Boot A claims the task and its turn never ends; then the store is closed as if the process died.
  const stuck = { dispatches: 0, run: (options) => { stuck.dispatches++; const run = state.app.store.createRun(owner, "team parent"); options.onStarted(run); return new Promise(() => {}); } };
  void state.app.teams.run(stuck, knowledge, team.id, "hang", { requestId });
  await new Promise((resolve) => setImmediate(resolve));
  const bootA = storeBoot(state.app.store);
  assert.equal(taskRow(state.app, requestId).state, "claimed");
  assert.equal(taskRow(state.app, requestId).boot_id, bootA, "the claim records the opening of the store that made it");
  // Boot B: the same request id is answered from the record, never as claimed for ever.
  const app = await reopen();
  assert.notEqual(storeBoot(app.store), bootA);
  const retry = inertRuntime(app.store, owner);
  for (let attempt = 0; attempt < 2; attempt++) {
    const seen = await app.teams.run(retry, knowledge, team.id, "hang", { requestId });
    assert.notEqual(seen.state, "claimed", `attempt ${attempt}: a dead process's claim is settled, not reported as live`);
  }
  assert.equal(retry.dispatches, 0, "nothing is dispatched again for the same request id");
  assert.notEqual(taskRow(app, requestId).state, "claimed");
});

test("a real process that claims a team task and is SIGKILLed leaves a claim the next start settles, with no dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-team-crash-"));
  t.after(() => discardTemp(root));
  const child = spawn(process.execPath, [resolve("tests/fixtures/team-claim-crash.mjs"), root], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done(signal)));
  const line = await new Promise((done, fail) => {
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; if (text.includes("\n")) done(JSON.parse(text.split("\n")[0])); });
    child.on("exit", () => fail(new Error(`the child exited before claiming: ${text}`)));
  });
  child.kill("SIGKILL");
  assert.equal(await exited, "SIGKILL");
  const app = await open(root);
  t.after(() => app.close().catch(() => undefined));
  assert.equal(taskRow(app, line.requestId).state, "claimed", "the dead process left its claim behind");
  const retry = inertRuntime(app.store, app.runtime.owner);
  const seen = await app.teams.run(retry, knowledge, line.teamId, "hang here", { requestId: line.requestId });
  assert.equal(seen.taskId, line.taskId);
  assert.notEqual(seen.state, "claimed");
  assert.equal(retry.dispatches, 0);
});

test("a task handed to a person keeps its claim across a restart: only a process's claim from an earlier start is settled", async (t) => {
  const { state, owner, team, reopen } = await fixture(t);
  const tasks = new TeamTasks(state.app.store), scope = { owner, source: "window" };
  const requestId = randomUUID();
  const task = tasks.observe(scope, team.id, requestId, "f");
  const claim = tasks.claim(scope, task.taskId);
  const handoffs = new TeamHandoffs(state.app.store);
  const planner = { owner, id: `member:${team.members[0].specialistId}` };
  handoffs.accept(planner, handoffs.offer(claim, planner.id, "planner takes it").offerId);
  assert.equal(taskRow(state.app, requestId).boot_id, null, "a person, not a process, holds it now");
  const app = await reopen();
  assert.equal(app.teams.reconcile(task.taskId).state, "claimed");
  const seen = new TeamTasks(app.store).get(scope, task.taskId);
  assert.equal(seen.state, "claimed");
  assert.equal(seen.claimant, planner.id);
});

test("a write to a task that is no longer claimed is refused even with the right claimant and generation", async (t) => {
  const { state, owner, team } = await fixture(t);
  const tasks = new TeamTasks(state.app.store), scope = { owner, source: "window" };
  const task = tasks.observe(scope, team.id, randomUUID(), "f");
  const claim = tasks.claim(scope, task.taskId);
  tasks.markFailed(claim, "stopped before anything was done");
  const settled = tasks.get(scope, task.taskId);
  assert.equal(settled.state, "failed");
  assert.equal(settled.claimant, claim.claimant);
  assert.equal(settled.generation, claim.generation);
  assert.throws(() => tasks.recordOutcome(claim, { answers: [] }), StaleTeamTaskClaimError);
  assert.throws(() => tasks.markNeedsReconciliation(claim, "late"), StaleTeamTaskClaimError);
  assert.throws(() => tasks.complete(claim, { answers: [] }, () => {}), StaleTeamTaskClaimError);
  assert.deepEqual(tasks.get(scope, task.taskId), settled, "the settled row is unchanged");
});

test("a claim that moved before the turn started never reaches the runtime: no run, no model call", async (t) => {
  const { state, owner, team } = await fixture(t);
  const planner = { owner, id: `member:${team.members[0].specialistId}` };
  // The claim is handed over (offer, accept) the moment it is won, before the turn begins.
  const claim = TeamTasks.prototype.claim;
  TeamTasks.prototype.claim = function takenOver(...args) {
    const won = claim.apply(this, args);
    const handoffs = new TeamHandoffs(state.app.store);
    handoffs.accept(planner, handoffs.offer(won, planner.id, "planner takes it").offerId);
    return won;
  };
  t.after(() => { TeamTasks.prototype.claim = claim; });
  const runsBefore = state.app.store.runs(owner).length;
  const runtime = inertRuntime(state.app.store, owner);
  const seen = await state.app.teams.run(runtime, knowledge, team.id, "ship it", { requestId: randomUUID() });
  TeamTasks.prototype.claim = claim;
  assert.equal(runtime.dispatches, 0, "the stale claimant never asked the runtime for anything");
  assert.equal(state.app.store.runs(owner).length, runsBefore, "no run was created");
  assert.equal(seen.state, "claimed");
  assert.equal(new TeamTasks(state.app.store).get({ owner, source: "window" }, seen.taskId).claimant, planner.id);
});

test("the same request id in upper and lower case is one request and runs the team once", async (t) => {
  const { state, owner, team } = await fixture(t);
  const runtime = inertRuntime(state.app.store, owner);
  const requestId = randomUUID();
  const first = await state.app.teams.run(runtime, knowledge, team.id, "plan", { requestId: requestId.toUpperCase() });
  const second = await state.app.teams.run(runtime, knowledge, team.id, "plan", { requestId });
  assert.equal(runtime.dispatches, 1);
  assert.equal(second.taskId, first.taskId);
  assert.equal(first.requestId, requestId, "the id is kept in lower case");
});

test("removing a team forgets its tasks, except one whose turn is still running here", async (t) => {
  const { state, owner, team } = await fixture(t);
  const other = state.app.teams.save({ name: "Other", members: team.members });
  const runtime = inertRuntime(state.app.store, owner);
  await state.app.teams.run(runtime, knowledge, team.id, "plan", { requestId: randomUUID() });
  const kept = await state.app.teams.run(runtime, knowledge, other.id, "plan", { requestId: randomUUID() });
  const tasks = new TeamTasks(state.app.store), scope = { owner, source: "window" };
  const running = tasks.observe(scope, team.id, randomUUID(), "f");
  tasks.claim(scope, running.taskId);
  const ended = beginTeamTurn(state.app.store, running.taskId);
  t.after(ended);
  const count = (teamId) => state.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE team_id=?").get(teamId).n;
  assert.equal(count(team.id), 2);
  assert.deepEqual(state.app.teams.remove(team.id), { removed: true });
  assert.equal(count(team.id), 1, "only the task with a turn running is kept");
  assert.ok(tasks.get(scope, running.taskId));
  assert.equal(tasks.get(scope, kept.taskId).state, "completed", "another team's tasks are untouched");
});

test("a repeat of a result too large to keep says so plainly and points at the room, where the answers are", async (t) => {
  const { state, owner, team } = await fixture(t);
  const huge = "x".repeat(300_000);
  const runtime = inertRuntime(state.app.store, owner);
  runtime.fanout = async (_context, tasks) => ({ tasks: Object.fromEntries(tasks.map((task, index) => [task.id, { status: "completed", output: huge, runId: `child-${index}` }])) });
  const requestId = randomUUID();
  const first = await state.app.teams.run(runtime, knowledge, team.id, "write a lot", { requestId });
  assert.equal(first.answers[0].output.length, huge.length, "the live caller gets every answer");
  const again = await state.app.teams.run(runtime, knowledge, team.id, "write a lot", { requestId });
  assert.equal(runtime.dispatches, 1);
  assert.equal(again.state, "completed");
  assert.equal(again.truncated, true);
  assert.match(again.note, /too large to keep for a repeat/);
  assert.equal(again.roomSessionId, team.roomSessionId);
  assert.equal(again.teamId, team.id);
  assert.equal(state.app.teams.room(team.id).filter((m) => m.content.includes(huge)).length, 2, "every answer is in the room");
});

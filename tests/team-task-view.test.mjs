import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { TeamTasks } from "../dist/team-tasks.js";
import { TeamHandoffs } from "../dist/team-handoff.js";

// Q64: the owner's view of a team's tasks, GET /api/teams/:id/tasks. Each state in Q51's words, who
// holds it, each member's run and batch, a pending handoff, the blocker and the result. Real Branch,
// real runtime, scripted model; the read must never settle anything.
const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };
const say = (content) => ({ content, toolCalls: [] });
const write = (id, path, content) => ({ content: "", toolCalls: [{ id, name: "files.write", arguments: JSON.stringify({ path, content }) }] });
const roleOf = (request) => /Your role in team \\?"Crew\\?": ([a-z]+)\./.exec(JSON.stringify(request.messages))?.[1] ?? null;

/** A model that answers each member by role, and the team's own turn from `parentSteps` in order. */
function scripted(parentSteps = [() => say("parent done")]) {
  const provider = { name: "scripted", parentCalls: 0, async complete(request) {
    const role = roleOf(request);
    if (role) return say(`answer from ${role}`);
    return parentSteps[Math.min(provider.parentCalls++, parentSteps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, provider, roles = ["planner", "builder", "reviewer"]) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-view-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const members = roles.map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { id: specialistId, name: role });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Crew", members });
  const get = (key = server.token) => fetch(`${server.url}/api/teams/${team.id}/tasks`, { headers: { authorization: `Bearer ${key}` } })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  const view = async () => { const answer = await get(); assert.equal(answer.status, 200); return answer.body.tasks; };
  return { app, server, owner, team, members, get, view };
}
const members = (task) => task.members.map((m) => [m.role, m.status, m.batch, m.task?.state ?? null]);
const row = (app, taskId) => app.store.sqlite.prepare("SELECT state, claimant, generation, boot_id, error FROM team_tasks WHERE task_id=?").get(taskId);

test("completed: Q51 words, the members in order with their batches, and a reviewer in a later batch answers after the others", async (t) => {
  const { app, owner, team, view } = await fixture(t, scripted());
  saveKnobs(app.store, owner, "subtasks", { parallelSubtasks: 2 });
  const done = await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });
  assert.equal(done.state, "completed");
  const [task] = await view();
  assert.equal(task.taskId, done.taskId);
  assert.deepEqual([task.task.state, task.task.why], ["finished", "completed"], "the state is Q51's, never the raw team state");
  assert.deepEqual(task.askedBy, { kind: "window", name: null });
  assert.equal(task.heldBy, null);
  assert.deepEqual(members(task), [["planner", "completed", 1, "finished"], ["builder", "completed", 1, "finished"], ["reviewer", "completed", 2, "finished"]]);
  assert.deepEqual(task.members.map((m) => m.runId), done.answers.map((a) => a.runId));
  const reviewer = task.members[2];
  assert.deepEqual([reviewer.after, reviewer.alongside], [["planner", "builder"], []], "batch 2 starts only after batch 1 has finished");
  assert.equal(task.members[0].after, undefined, "only a reviewer is given an order");
  assert.deepEqual(task.result.answers.map((a) => [a.role, a.output]), [["planner", "answer from planner"], ["builder", "answer from builder"], ["reviewer", "answer from reviewer"]]);
  assert.equal(task.blocker, null);
  assert.equal(task.handoff, null);
});

test("with the shipped limit a reviewer shares the first batch: it runs alongside the others and waits for nobody", async (t) => {
  const { app, team, view } = await fixture(t, scripted());
  await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });
  const [task] = await view();
  assert.deepEqual(task.members.map((m) => m.batch), [1, 1, 1]);
  assert.deepEqual([task.members[2].after, task.members[2].alongside], [[], ["planner", "builder"]]);
});

test("waiting_owner: waiting for your answer, with the question as the blocker and no member started", async (t) => {
  const { app, owner, team, view } = await fixture(t, scripted([() => write("w1", "notes.txt", "one"), () => say("parent done")]));
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  const seen = await app.teams.run(app.runtime, knowledge, team.id, "write the notes", { requestId: randomUUID() });
  assert.equal(seen.state, "waiting_owner");
  const [task] = await view();
  assert.deepEqual([task.task.state, task.task.why], ["waiting-owner", "attention.needed"]);
  assert.equal(task.blocker, seen.question);
  assert.match(task.blocker, /Writing notes\.txt/);
  assert.deepEqual(task.members, []);
  assert.equal(task.result, null);
});

test("needs_reconciliation: a throw between batches is blocked, names why, and lists which members ran in which batch", async (t) => {
  const { app, owner, team, view } = await fixture(t, scripted(), ["planner", "builder", "tester", "reviewer"]);
  saveKnobs(app.store, owner, "subtasks", { parallelSubtasks: 2 });
  let fanouts = 0;
  const broken = { run: (options) => app.runtime.run(options), context: (options) => app.runtime.context(options),
    fanout: (...args) => (++fanouts === 2 ? Promise.reject(new Error("injected: stopped between batches")) : app.runtime.fanout(...args)) };
  await assert.rejects(app.teams.run(broken, knowledge, team.id, "ship it", { requestId: randomUUID() }), /stopped between batches/);
  const [task] = await view();
  assert.deepEqual([task.task.state, task.task.why], ["blocked", "reconciliation.required"]);
  assert.match(task.blocker, /Stopped while the members were working: injected: stopped between batches/);
  assert.match(task.blocker, /Not run: tester \(not started\), reviewer \(not started\)/);
  assert.deepEqual(members(task), [["planner", "completed", 1, "finished"], ["builder", "completed", 1, "finished"],
    ["tester", "not_started", 2, null], ["reviewer", "not_started", 2, null]]);
  assert.deepEqual(task.members[3].after, ["planner", "builder"], "its batch began after batch 1 had finished, though it never ran");
  assert.equal(task.result, null);
});

test("a pending handoff: to whom, since when and why; the read settles nothing, and after acceptance the member holds it", async (t) => {
  const { app, owner, team, members: crew, view } = await fixture(t, scripted());
  const scope = { owner, source: "window" };
  const tasks = new TeamTasks(app.store);
  const claim = tasks.claim(scope, tasks.observe(scope, team.id, randomUUID(), "f").taskId);
  const reviewer = `member:${crew[2].specialistId}`;
  const offer = new TeamHandoffs(app.store).offer(claim, reviewer, "needs a reviewer's eye");
  const before = row(app, claim.taskId);
  const [task] = await view();
  await view();
  assert.deepEqual(row(app, claim.taskId), before, "reading the view twice changed nothing: not settled, not reclaimed");
  assert.equal(new TeamHandoffs(app.store).get(owner, offer.offerId).state, "offered");
  assert.deepEqual([task.task.state, task.task.why], ["blocked", "handoff.offered"]);
  assert.deepEqual(task.heldBy, { kind: "branch", name: null });
  assert.deepEqual(task.handoff, { to: { kind: "member", name: "reviewer" }, since: offer.offeredAt, until: offer.expiresAt, reason: "needs a reviewer's eye" });
  new TeamHandoffs(app.store).accept({ owner, id: reviewer }, offer.offerId);
  const [held] = await view();
  assert.deepEqual([held.task.state, held.task.why], ["working", "handoff.accepted"]);
  assert.deepEqual(held.heldBy, { kind: "member", name: "reviewer" });
  assert.equal(held.handoff, null);
});

test("failed: stopped before doing anything, with why, and never the raw state", async (t) => {
  const { app, team, view } = await fixture(t, scripted());
  const broken = { run: (options) => app.runtime.run({ ...options, onStarted: (run) => { options.onStarted(run); throw new Error("injected: stopped at the start"); } }),
    context: (options) => app.runtime.context(options), fanout: (...args) => app.runtime.fanout(...args) };
  const seen = await app.teams.run(broken, knowledge, team.id, "tidy the docs", { requestId: randomUUID() });
  assert.equal(seen.state, "failed");
  const [task] = await view();
  assert.deepEqual([task.task.state, task.task.why], ["finished", "nothing-done"]);
  assert.match(task.blocker, /^Nothing was done/);
  assert.equal(task.result, null);
});

test("owner-only: a household profile and both kinds of short-lived key are refused the view", async (t) => {
  const { app, owner, team, get } = await fixture(t, scripted());
  await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });
  assert.equal((await get()).status, 200);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(owner, { name: scope, scope, minutes: 5 }).token;
    const refused = await get(key);
    assert.equal(refused.status, 401, `a ${scope} key is refused`);
    assert.match(refused.body.error, /short-lived key cannot read/);
    assert.equal(refused.body.tasks, undefined);
  }
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const household = await get();
  assert.equal(household.status, 400);
  assert.match(household.body.error, /belongs to the owner/);
  assert.equal(household.body.tasks, undefined);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await get()).status, 200, "back at the owner's profile, the view is there again");
});

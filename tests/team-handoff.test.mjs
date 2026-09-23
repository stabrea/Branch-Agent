import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { TeamTasks, StaleTeamTaskClaimError } from "../dist/team-tasks.js";
import { TeamHandoffs, TeamHandoffRefusedError, beginTeamTurn } from "../dist/team-handoff.js";

// Q62: an acknowledged handoff of a claimed team task. The claimant offers the task to a named
// recipient; the claimant stays responsible until the recipient accepts, and once it does, every
// write under the old claim is refused. Inert and disposable: no model is called.
const inertProvider = { name: "inert", async complete() { return { content: "ok", toolCalls: [] }; } };

async function open(root) {
  return createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: inertProvider });
}
/** A team with two members, a household profile, and one task already claimed by the window. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-team-handoff-"));
  const state = { app: await open(root) };
  t.after(async () => { await state.app.close().catch(() => undefined); await discardTemp(root); });
  const owner = state.app.runtime.owner;
  const members = ["planner", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    state.app.store.save("specialists", owner, specialistId, { id: specialistId, name: role });
    return { specialistId, role, brief: "" };
  });
  const team = state.app.teams.save({ name: "Crew", members });
  const sam = state.app.store.profiles.create({ name: "Sam", pin: "1234" });
  const scope = { owner, source: "window" };
  const tasks = new TeamTasks(state.app.store);
  const task = tasks.observe(scope, team.id, randomUUID(), "f");
  const claim = tasks.claim(scope, task.taskId);
  const planner = { owner, id: `member:${members[0].specialistId}` };
  const reviewer = { owner, id: `member:${members[1].specialistId}` };
  const household = { owner, id: `profile:${sam.id}` };
  const reopen = async () => { await state.app.close(); state.app = await open(root); return state.app; };
  const row = (store = state.app.store) => new TeamTasks(store).get(scope, task.taskId);
  return { state, owner, team, scope, tasks, claim, planner, reviewer, household, reopen, row, root };
}

test("the claimant stays responsible until acceptance, the recipient cannot write before it, and the waiting reason is readable", async (t) => {
  const { state, owner, tasks, claim, planner, household, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, planner.id, "needs a reviewer's eye");
  assert.equal(offer.state, "offered");
  assert.equal(handoffs.waiting(claim.scope, claim.taskId), `waiting for ${planner.id} to accept: needs a reviewer's eye`);
  assert.throws(() => handoffs.offer(claim, household.id, "second"), TeamHandoffRefusedError, "one open offer per task");
  for (const generation of [claim.generation, claim.generation + 1])
    assert.throws(() => tasks.linkParentRun({ ...claim, claimant: planner.id, generation }, "run"), StaleTeamTaskClaimError);
  tasks.linkParentRun(claim, "parent-run");
  assert.equal(row().parentRunId, "parent-run", "the offerer's fenced write still lands while the offer waits");
  assert.equal(row().claimant, claim.claimant);
  const other = tasks.observe(claim.scope, row().teamId, randomUUID(), "g");
  const otherClaim = tasks.claim(claim.scope, other.taskId);
  assert.throws(() => handoffs.offer({ ...otherClaim, claimant: randomUUID() }, planner.id, "not mine"), TeamHandoffRefusedError, "only the claimant can offer");
  assert.throws(() => handoffs.offer({ ...otherClaim, generation: otherClaim.generation + 1 }, planner.id, "stale"), TeamHandoffRefusedError);
  assert.throws(() => handoffs.offer(otherClaim, `member:${randomUUID()}`, "not on the team"), TeamHandoffRefusedError);
  assert.throws(() => handoffs.offer(otherClaim, `profile:${randomUUID()}`, "no such profile"), TeamHandoffRefusedError);
  assert.throws(() => handoffs.offer(otherClaim, "window", "not a recipient kind"), TeamHandoffRefusedError);
  assert.equal(handoffs.waiting(claim.scope, other.taskId), null);
  assert.equal(owner, claim.scope.owner);
});

test("double acceptance: of two racing accepts exactly one wins, and afterwards the old claimant is fenced out", async (t) => {
  const { state, tasks, claim, planner, row } = await fixture(t);
  const offer = new TeamHandoffs(state.app.store).offer(claim, planner.id, "planner takes over");
  const first = new TeamHandoffs(state.app.store), second = new TeamHandoffs(state.app.store);
  const outcomes = await Promise.allSettled([first, second].map(async (h) => h.accept(planner, offer.offerId)));
  const won = outcomes.filter((o) => o.status === "fulfilled");
  const lost = outcomes.filter((o) => o.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(lost[0].reason instanceof TeamHandoffRefusedError);
  assert.match(lost[0].reason.message, /already accepted/);
  const next = won[0].value;
  assert.equal(next.generation, claim.generation + 1, "acceptance advances the generation");
  assert.deepEqual(next.scope, claim.scope, "the task keeps its identity; only the holder changes");
  assert.equal(row().claimant, planner.id);
  assert.equal(row().generation, claim.generation + 1);
  const before = row();
  assert.throws(() => tasks.complete(claim, { stale: true }, () => {}), StaleTeamTaskClaimError);
  assert.throws(() => tasks.markNeedsReconciliation(claim, "stale"), StaleTeamTaskClaimError);
  assert.deepEqual(row(), before, "the old claimant's writes change nothing");
  assert.equal(first.get(planner.owner, offer.offerId).state, "accepted");
  assert.equal(first.waiting(claim.scope, claim.taskId), null);
  tasks.complete(next, { done: "by the planner" }, () => {});
  assert.equal(row().state, "completed");
  assert.deepEqual(row().result, { done: "by the planner" });
});

test("rejection leaves the claimant and generation unchanged, records the reason, and a rejected offer cannot be accepted", async (t) => {
  const { state, tasks, claim, planner, household, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, household.id, "Sam knows the budget");
  const before = row();
  const rejected = handoffs.reject(household, offer.offerId, "away this week");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.decisionReason, "away this week");
  assert.equal(handoffs.get(household.owner, offer.offerId).decisionReason, "away this week");
  assert.deepEqual(row(), before);
  assert.throws(() => handoffs.accept(household, offer.offerId), /rejected/);
  assert.throws(() => handoffs.reject(household, offer.offerId, "again"), /rejected/);
  assert.deepEqual(row(), before, "a late accept of a rejected offer moves nothing");
  const again = handoffs.offer(claim, planner.id, "then the planner");
  assert.equal(again.state, "offered", "after a rejection the claimant can offer again");
  tasks.linkParentRun(claim, "still mine");
  assert.equal(row().parentRunId, "still mine");
});

test("timeout: an expired offer cannot be accepted and the task stays with the offerer", async (t) => {
  const { state, tasks, claim, planner, row } = await fixture(t);
  const clock = { now: Date.parse("2026-09-23T12:00:00Z") };
  const handoffs = new TeamHandoffs(state.app.store, () => clock.now);
  const offer = handoffs.offer(claim, planner.id, "overnight cover", 60_000);
  assert.equal(offer.expiresAt, "2026-09-23T12:01:00.000Z");
  clock.now += 59_999;
  assert.equal(handoffs.get(planner.owner, offer.offerId).state, "offered");
  clock.now += 1;
  const before = row();
  assert.throws(() => handoffs.accept(planner, offer.offerId), /expired/, "checked on accept, with no read first");
  assert.equal(handoffs.get(planner.owner, offer.offerId).state, "expired");
  assert.equal(handoffs.waiting(claim.scope, claim.taskId), null);
  assert.deepEqual(row(), before);
  assert.equal(row().claimant, claim.claimant);
  const late = handoffs.offer(claim, planner.id, "try again", 60_000);
  clock.now += 60_000;
  assert.equal(handoffs.get(planner.owner, late.offerId).state, "expired", "checked on read");
  assert.throws(() => handoffs.accept(planner, late.offerId), /expired/);
  tasks.complete(claim, { done: "by the offerer" }, () => {});
  assert.equal(row().state, "completed");
});

test("restart: an open offer survives close and reopen and can still be accepted", async (t) => {
  const { state, claim, planner, reopen, row } = await fixture(t);
  const offer = new TeamHandoffs(state.app.store).offer(claim, planner.id, "hand over after the restart");
  const app = await reopen();
  const handoffs = new TeamHandoffs(app.store);
  assert.equal(handoffs.get(planner.owner, offer.offerId).state, "offered");
  assert.equal(handoffs.waiting(claim.scope, claim.taskId), `waiting for ${planner.id} to accept: hand over after the restart`);
  assert.deepEqual(handoffs.addressedTo(planner).map((o) => o.offerId), [offer.offerId]);
  const next = handoffs.accept(planner, offer.offerId);
  assert.equal(next.generation, claim.generation + 1);
  assert.equal(row(app.store).claimant, planner.id);
  assert.throws(() => new TeamTasks(app.store).linkParentRun(claim, "stale"), StaleTeamTaskClaimError);
});

test("an unauthorized recipient cannot accept or reject, and the offer and task are untouched", async (t) => {
  const { state, owner, claim, planner, reviewer, household, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, planner.id, "for the planner only");
  const before = row();
  for (const who of [reviewer, household, { owner, id: "window" }, { owner: "someone-else", id: planner.id }]) {
    assert.throws(() => handoffs.accept(who, offer.offerId), TeamHandoffRefusedError, `${who.owner}/${who.id} cannot accept`);
    assert.throws(() => handoffs.reject(who, offer.offerId, "not mine"), TeamHandoffRefusedError, `${who.owner}/${who.id} cannot reject`);
  }
  assert.equal(handoffs.get(owner, offer.offerId).state, "offered");
  assert.equal(handoffs.get("someone-else", offer.offerId), undefined, "another owner cannot even see it");
  assert.deepEqual(handoffs.addressedTo(reviewer), []);
  assert.deepEqual(row(), before);
});

test("a holder that gets the task back later cannot write under its first, older holding", async (t) => {
  const { state, tasks, claim, planner, household, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const firstHolding = handoffs.accept(planner, handoffs.offer(claim, planner.id, "to the planner").offerId);
  const samHolding = handoffs.accept(household, handoffs.offer(firstHolding, household.id, "to Sam").offerId);
  const secondHolding = handoffs.accept(planner, handoffs.offer(samHolding, planner.id, "back to the planner").offerId);
  assert.equal(secondHolding.generation, claim.generation + 3);
  const before = row();
  assert.throws(() => tasks.linkParentRun(firstHolding, "stale"), StaleTeamTaskClaimError, "same holder, old generation");
  assert.throws(() => tasks.linkParentRun(samHolding, "stale"), StaleTeamTaskClaimError);
  assert.deepEqual(row(), before);
  tasks.linkParentRun(secondHolding, "current");
  assert.equal(row().parentRunId, "current");
});

test("an offer made before the offerer finished cannot be accepted afterwards", async (t) => {
  const { state, tasks, claim, planner, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, planner.id, "might not be needed");
  tasks.complete(claim, { done: "by the offerer" }, () => {});
  assert.throws(() => handoffs.accept(planner, offer.offerId), /no longer holds/);
  assert.equal(row().state, "completed");
  assert.equal(row().claimant, claim.claimant);
  assert.notEqual(handoffs.get(planner.owner, offer.offerId).state, "accepted");
});

test("over HTTP the recipient is whoever signed in: a body naming someone is refused, the window cannot answer a profile's offer, and the profile can", async (t) => {
  const { state, owner, team, claim, household, row, root } = await fixture(t);
  const app = state.app;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const handoffs = new TeamHandoffs(app.store);
  const offer = handoffs.offer(claim, household.id, "Sam signs off the budget");
  const call = async (method, suffix, body, key = server.token) => {
    const response = await fetch(`${server.url}/api/teams/${team.id}/handoffs${suffix}`, { method, headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const before = row();
  for (const extra of [{ actor: household.id }, { id: household.id }, { owner }, { source: household.id }])
    assert.equal((await call("POST", `/${offer.offerId}/accept`, extra)).status, 400, `a body carrying ${Object.keys(extra)[0]} is refused`);
  const asWindow = await call("POST", `/${offer.offerId}/accept`, {});
  assert.equal(asWindow.status, 409);
  assert.match(asWindow.body.error, /addressed to someone else/);
  assert.deepEqual((await call("GET", "")).body.offers, [], "the window sees no offers addressed to it");
  assert.equal((await call("POST", `/${randomUUID()}/accept`, {})).status, 404);
  const key = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 });
  assert.notEqual((await call("POST", `/${offer.offerId}/accept`, {}, key.token)).status, 200, "a short-lived key is not the recipient");
  assert.deepEqual(row(), before);
  assert.equal(handoffs.get(owner, offer.offerId).state, "offered");
  app.store.profiles.switch({ profileId: household.id.slice("profile:".length), pin: "1234" });
  t.after(() => { try { app.store.profiles.switch({ profileId: null }); } catch { /* already closed */ } });
  assert.deepEqual((await call("GET", "")).body.offers.map((o) => o.offerId), [offer.offerId]);
  const accepted = await call("POST", `/${offer.offerId}/accept`, {});
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(accepted.body, { offerId: offer.offerId, taskId: claim.taskId, state: "accepted", generation: claim.generation + 1 });
  assert.equal(row().claimant, household.id);
  assert.equal((await call("POST", `/${offer.offerId}/accept`, {})).status, 409, "a second accept loses");
});

/** A team runtime whose member fanout waits for `hold`; `started` settles once the turn is under way. */
function heldRuntime(store, owner, hold) {
  let started;
  return {
    started: new Promise((resolve) => { started = resolve; }),
    // Q63: like the real runtime, the run is announced before it does anything, and settles as completed.
    async run(runOptions) { const parent = store.createRun(owner, "team parent"); runOptions.onStarted?.(parent); return { id: parent.id, status: "completed", output: "" }; },
    context: ({ runId }) => ({ runId }),
    async fanout(context, tasks) {
      started();
      await hold;
      // Each member's run as the real runtime makes one: in a conversation of its own, started under the parent.
      const member = () => { const run = store.createRun(owner, "member"); store.event(run.id, "run.started", { parentRunId: context.runId }); store.finish(run.id, "completed", ""); return run.id; };
      return { tasks: Object.fromEntries(tasks.map((task, index) => [task.id, { status: "completed", output: `answer ${index}`, runId: member() }])) };
    },
  };
}

test("while a team turn is running its task cannot be offered away, and the turn completes with its result", async (t) => {
  const { state, owner, team, planner } = await fixture(t);
  const app = state.app, scope = { owner, source: "window" }, tasks = new TeamTasks(app.store);
  let release; const hold = new Promise((resolve) => { release = resolve; });
  const runtime = heldRuntime(app.store, owner, hold);
  const requestId = randomUUID();
  const running = app.teams.run(runtime, { activeSpecialist: () => ({}) }, team.id, "ship it", { requestId });
  await runtime.started;
  const { task_id: taskId } = app.store.sqlite.prepare("SELECT task_id FROM team_tasks WHERE request_id=?").get(requestId);
  const held = tasks.get(scope, taskId);
  assert.equal(held.state, "claimed");
  assert.ok(held.parentRunId, "the parent run is already linked, yet the members are still working");
  // In-process code can rebuild the running claim from the row; the turn must still be protected.
  const inFlight = { scope, taskId, claimant: held.claimant, generation: held.generation };
  const handoffs = new TeamHandoffs(app.store);
  let refusal = null;
  try {
    const offer = handoffs.offer(inFlight, planner.id, "take it mid-turn");
    handoffs.accept(planner, offer.offerId);
  } catch (error) { refusal = error; }
  release();
  const done = await running.catch((error) => error);
  assert.equal(done.state, "completed", `the turn's own result is kept (${done.message ?? ""})`);
  assert.deepEqual(done.answers.map((a) => a.output), ["answer 0", "answer 1"]);
  assert.deepEqual(tasks.get(scope, taskId).result.answers, done.answers);
  assert.ok(refusal instanceof TeamHandoffRefusedError);
  assert.match(refusal.message, /wait until the current turn finishes/);
  assert.equal(handoffs.waiting(scope, taskId), null, "no offer was left behind");
  // A finished task is no longer held by anyone, so it cannot be offered at all.
  assert.throws(() => handoffs.offer(inFlight, planner.id, "after the turn"), /no longer holds/);
});

test("an accept is refused while the task's turn runs, the offer stays open, and it can be accepted after the turn", async (t) => {
  const { state, claim, planner, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, planner.id, "after this turn");
  const turnEnded = beginTeamTurn(state.app.store, claim.taskId);
  const before = row();
  assert.throws(() => handoffs.accept(planner, offer.offerId), /wait until the current turn finishes/);
  assert.equal(handoffs.get(planner.owner, offer.offerId).state, "offered");
  assert.deepEqual(row(), before);
  turnEnded();
  assert.equal(handoffs.accept(planner, offer.offerId).generation, claim.generation + 1);
});

test("at accept the recipient is checked again: a member who left the team or a removed profile cannot take the task", async (t) => {
  const { state, owner, team, tasks, claim, reviewer, household, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const toReviewer = handoffs.offer(claim, reviewer.id, "review it");
  state.app.teams.save({ id: team.id, name: team.name, members: team.members.filter((m) => `member:${m.specialistId}` !== reviewer.id) });
  const before = row();
  assert.throws(() => handoffs.accept(reviewer, toReviewer.offerId), /could no longer take the task: .*not a member/);
  assert.equal(handoffs.get(owner, toReviewer.offerId).state, "expired");
  assert.match(handoffs.get(owner, toReviewer.offerId).decisionReason, /not a member/);
  assert.deepEqual(row(), before);
  const toSam = handoffs.offer(claim, household.id, "Sam then");
  state.app.store.profiles.remove(household.id.slice("profile:".length));
  assert.throws(() => handoffs.accept(household, toSam.offerId), /could no longer take the task: .*does not exist/);
  assert.equal(handoffs.get(owner, toSam.offerId).state, "expired");
  assert.deepEqual(row(), before);
  tasks.linkParentRun(claim, "still the offerer's");
  assert.equal(row().parentRunId, "still the offerer's");
});

/** A server on the fixture's store, and a caller that can sign requests with the app key or a short-lived key. */
async function served(t, app, root, teamId) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, suffix, body, key = server.token, team = teamId) => {
    const response = await fetch(`${server.url}/api/teams/${team}/handoffs${suffix}`, { method, headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { server, call };
}
function signInAs(t, app, household) {
  app.store.profiles.switch({ profileId: household.id.slice("profile:".length), pin: "1234" });
  t.after(() => { try { app.store.profiles.switch({ profileId: null }); } catch { /* already closed */ } });
}

test("over HTTP the recipient's reject leaves the task exactly where it was and records the rejection", async (t) => {
  const { state, owner, team, claim, household, row, root } = await fixture(t);
  const app = state.app;
  const { call } = await served(t, app, root, team.id);
  const handoffs = new TeamHandoffs(app.store);
  const offer = handoffs.offer(claim, household.id, "Sam signs off the budget");
  signInAs(t, app, household);
  const before = row();
  const answer = await call("POST", `/${offer.offerId}/reject`, { reason: "not my area" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.state, "rejected");
  assert.equal(answer.body.decisionReason, "not my area");
  assert.deepEqual(row(), before, "the task row is unchanged: same claimant, same generation");
  assert.equal(handoffs.get(owner, offer.offerId).state, "rejected");
  assert.equal((await call("POST", `/${offer.offerId}/accept`, {})).status, 409, "a rejected offer cannot be accepted");
});

test("when accept fails between its two writes, both are rolled back and the offer can still be accepted", async (t) => {
  const { state, owner, claim, planner, row } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, planner.id, "planner takes over");
  const before = row();
  const check = TeamHandoffs.prototype.recipientGone;
  TeamHandoffs.prototype.recipientGone = function broken() { throw new Error("disk went away mid-accept"); };
  t.after(() => { TeamHandoffs.prototype.recipientGone = check; });
  assert.throws(() => handoffs.accept(planner, offer.offerId), /disk went away/);
  TeamHandoffs.prototype.recipientGone = check;
  assert.equal(handoffs.get(owner, offer.offerId).state, "offered", "the offer's own write was rolled back");
  assert.deepEqual(row(), before);
  assert.equal(handoffs.accept(planner, offer.offerId).generation, claim.generation + 1);
});

test("a short-lived key used while Sam is signed in is the key, not Sam: it sees none of Sam's offers", async (t) => {
  const { state, owner, team, claim, household, root } = await fixture(t);
  const app = state.app;
  const { call } = await served(t, app, root, team.id);
  const offer = new TeamHandoffs(app.store).offer(claim, household.id, "for Sam");
  signInAs(t, app, household);
  assert.deepEqual((await call("GET", "")).body.offers.map((o) => o.offerId), [offer.offerId], "Sam's own window sees it");
  const key = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 });
  const asKey = await call("GET", "", undefined, key.token);
  assert.equal(asKey.status, 200, JSON.stringify(asKey.body));
  assert.deepEqual(asKey.body.offers, []);
});

test("an expired offer is not listed, in the class with an injected clock and over HTTP", async (t) => {
  const { state, owner, team, claim, household, root } = await fixture(t);
  let now = Date.parse("2026-09-01T00:00:00Z");
  const clocked = new TeamHandoffs(state.app.store, () => now);
  const offer = clocked.offer(claim, household.id, "quick one", 60_000);
  assert.deepEqual(clocked.addressedTo(household).map((o) => o.offerId), [offer.offerId]);
  now += 60_001;
  assert.deepEqual(clocked.addressedTo(household), []);
  assert.equal(clocked.get(owner, offer.offerId).state, "expired");
  // Over HTTP (the real clock): an offer that ran out long ago is not listed either.
  const other = new TeamTasks(state.app.store);
  const second = other.observe(claim.scope, team.id, randomUUID(), "g");
  const stale = new TeamHandoffs(state.app.store, () => Date.now() - 3_600_000).offer(other.claim(claim.scope, second.taskId), household.id, "long ago", 60_000);
  assert.equal(new TeamHandoffs(state.app.store, () => Date.now() - 3_600_000).get(owner, stale.offerId).state, "offered", "it was open when it was made");
  const { call } = await served(t, state.app, root, team.id);
  signInAs(t, state.app, household);
  assert.deepEqual((await call("GET", "")).body.offers, []);
});

test("GET lists only the offers for the team in the address", async (t) => {
  const { state, owner, team, claim, household, root } = await fixture(t);
  const members = team.members;
  const otherTeam = state.app.teams.save({ name: "Other crew", members });
  const tasks = new TeamTasks(state.app.store);
  const theirs = tasks.observe(claim.scope, otherTeam.id, randomUUID(), "h");
  const handoffs = new TeamHandoffs(state.app.store);
  const mine = handoffs.offer(claim, household.id, "this team's");
  const elsewhere = handoffs.offer(tasks.claim(claim.scope, theirs.taskId), household.id, "the other team's");
  const { call } = await served(t, state.app, root, team.id);
  signInAs(t, state.app, household);
  assert.deepEqual((await call("GET", "")).body.offers.map((o) => o.offerId), [mine.offerId]);
  assert.deepEqual((await call("GET", "", undefined, undefined, otherTeam.id)).body.offers.map((o) => o.offerId), [elsewhere.offerId]);
  assert.equal(owner, claim.scope.owner);
});

test("an open offer lapses at accept once its team was removed", async (t) => {
  const { state, owner, team, claim, household } = await fixture(t);
  const handoffs = new TeamHandoffs(state.app.store);
  const offer = handoffs.offer(claim, household.id, "Sam then");
  state.app.teams.remove(team.id);
  assert.throws(() => handoffs.accept(household, offer.offerId), /team was removed/);
  assert.equal(handoffs.get(owner, offer.offerId).state, "expired");
});

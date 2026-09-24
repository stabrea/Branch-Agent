/**
 * While the owner has routines switched off, or Trunks themselves, a repeating routine a Trunk owns waits, as a
 * repeating schedule a Trunk made does while Trunks are off. Each turn that comes round is held: nothing runs, its
 * badge says why, and it moves on to its next turn. A held turn is not a failure, so it never pauses the routine.
 * Once the switch is on again, the routine runs at its next turn and counts nothing. A one-off routine is still
 * refused, and a routine whose Trunk is gone still fails each turn and counts it, as before. The owner's own
 * schedules run as usual throughout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";

const hour = 3600000;
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);
const routinesOff = "Routines a Trunk owns are switched off, so this routine did not run.";
const trunkGone = "The Trunk this routine belonged to is gone, so the routine did not run.";
const rules = [({ last }) => (/NEWS7301/.test(String(last?.content ?? "")) ? "Checked NEWS7301." : null)];

async function setup(t) {
  const { app, provider } = await fixture(t, rules);
  on(app, "routines");
  const fi = app.trunks.create({ name: "Fi" });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  const routine = app.trunks.routines.create(fi.id, { name: "News", prompt: "Check NEWS7301", dueAt: inMinutes(1).toISOString(), intervalMs: hour });
  // The control: the owner's own hourly reminder, due at the same time.
  app.scheduler.create(app.runtime.context({ source: "owner" }), { prompt: "MINE7302", kind: "reminder", dueAt: inMinutes(1).toISOString(), intervalMs: hour });
  const saved = (id) => app.store.get("schedules", owner, id).data;
  const badge = (id) => app.scheduler.overview(owner).schedules.find((one) => one.id === id).health;
  /** What the routine wrote in Fi's conversation, and whether the model was ever asked to do it. */
  const reports = () => app.store.messages(fi.chatSessionId).filter((message) => /^Routine "News"/.test(String(message.content)));
  const asked = () => JSON.stringify(provider.requests).includes("Check NEWS7301");
  /** One beat of the timer, `late` minutes after the routine is due: that moment, and what ran. */
  const beat = async (late = 5) => {
    const now = new Date(Date.parse(String(saved(routine.id).dueAt)) + late * 60000);
    const ran = (await app.scheduler.tick(now)).map((run) => run.output);
    return { now, ran };
  };
  /** Where the routine stands after one beat at `now`. */
  const standing = (now) => {
    const data = saved(routine.id), health = badge(routine.id);
    return { status: data.status, failures: data.consecutiveFailures ?? 0, paused: data.pausedBecause ?? null, error: data.error ?? null,
      badge: health.state, why: health.heldBecause ?? null, movedOn: Date.parse(String(data.dueAt)) > now.getTime() };
  };
  return { app, fi, owner, routine, saved, badge, reports, asked, beat, standing };
}

/** Four turns held while `switchOff` holds, then `switchOn`: the next turn runs once and counts nothing. */
async function heldThenResumed(fixtureParts, switchOff, switchOn) {
  const { app, routine, saved, badge, reports, asked, beat, standing } = fixtureParts;
  switchOff(app);
  const turns = [], ownersBeats = [];
  for (let turn = 0; turn < 4; turn++) {
    const { now, ran } = await beat();
    turns.push(standing(now));
    ownersBeats.push(ran);
  }
  const held = { status: "pending", failures: 0, paused: null, error: null, badge: "held", why: routinesOff, movedOn: true };
  assert.deepEqual(turns, [held, held, held, held], "each held turn waits: no failure, no pause, no error, and on to its next turn");
  assert.deepEqual(ownersBeats, Array(4).fill(["Reminder: MINE7302"]), "the owner's own hourly reminder ran at each of those beats");
  assert.deepEqual(reports(), [], "nothing of the routine ran while it was held");
  assert.equal(asked(), false, "the model was never asked to do the routine");
  assert.deepEqual(saved(routine.id).history, [], "a held turn is not a turn the routine took");

  // Switched on again: the next beat, at its next turn, runs it once, counting nothing, and the badge is clear.
  switchOn(app);
  const { now: back } = await beat();
  assert.deepEqual(reports().map((message) => message.content), ['Routine "News": Checked NEWS7301.'], "it ran once at its next turn");
  const after = saved(routine.id);
  assert.deepEqual({ status: after.status, failures: after.consecutiveFailures ?? 0, paused: after.pausedBecause ?? null,
    held: after.heldBecause ?? null, runs: after.runCount, badge: badge(routine.id).state },
  { status: "pending", failures: 0, paused: null, held: null, runs: 1, badge: "healthy" });
  assert.equal(after.dueAt, new Date(back.getTime() + hour).toISOString(), "its next turn is an hour on");
  await app.scheduler.tick(new Date(back.getTime() + 5 * 60000));
  assert.equal(reports().length, 1, "nothing is caught up at once");
}

test("a Trunk's repeating routine waits while routines are off without counting a failure, and runs at its next turn once they are on", async (t) => {
  const parts = await setup(t);
  const { app, fi, saved } = parts;
  // A one-off routine due at the same time is still refused while routines are off, as before.
  const once = app.trunks.routines.create(fi.id, { name: "Once", prompt: "Once ONCE7303", dueAt: inMinutes(1).toISOString() });
  await heldThenResumed(parts, (a) => a.trunks.setMode("routines", { mode: "off" }), (a) => a.trunks.setMode("routines", { mode: "on" }));
  const oneOff = saved(once.id);
  assert.deepEqual({ status: oneOff.status, error: oneOff.error ?? null, held: oneOff.heldBecause ?? null },
    { status: "failed", error: routinesOff, held: null }, "the one-off ended failed with the reason");
});

test("a Trunk's repeating routine also waits without counting a failure while Trunks are off and routines are left on", async (t) => {
  const parts = await setup(t);
  await heldThenResumed(parts, (a) => a.trunks.setMode("trunks", { mode: "off" }), (a) => on(a));
});

test("a routine whose Trunk is gone is not held: each turn still fails and counts, and it is paused after three", async (t) => {
  const { app, fi, beat, standing } = await setup(t);
  app.trunks.setMode("routines", { mode: "off" });
  app.trunks.records.remove(fi.id); // the link outlives its Trunk
  const turns = [];
  for (let turn = 0; turn < 3; turn++) turns.push(standing((await beat()).now));
  const failing = (failures) => ({ status: "pending", failures, paused: null, error: trunkGone, badge: "failing", why: null, movedOn: true });
  const pausedFor = /^This repeating job did not finish 3 turns in a row, so it has been paused\./;
  assert.deepEqual(turns.slice(0, 2), [failing(1), failing(2)]);
  assert.match(String(turns[2].paused), pausedFor);
  assert.deepEqual({ ...turns[2], paused: null }, { ...failing(3), status: "paused" });
});

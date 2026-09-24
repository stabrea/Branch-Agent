/**
 * A schedule a Trunk made fires shaped as that Trunk, as its own turn and its routines are: with its
 * instructions, its own memory scope, and its permissions as they are now, never more than the
 * schedule itself was given. So the owner's documents are not put in front of it, and narrowing the
 * Trunk's permissions applies to the schedules it already made.
 *
 * A Trunk also sees and changes only the schedules it made. The owner sees and changes every one,
 * and a schedule that is not the Trunk's is answered as a missing one.
 *
 * Everything goes through real Trunk turns (`trunks.say`), the real scheduler, the real tools and a
 * scripted model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { call, fixture, on } from "./trunks-helpers.mjs";

const ownerFact = "OWNERPRIV3391", adaFact = "ADAOWN5150", ownerDocument = "OWNERDOC4242";
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);

const rules = [({ last }) => {
  if (last?.role !== "user") return null;
  const text = String(last.content ?? "");
  const schedule = /^schedule in (\d+): (.+)$/s.exec(text);
  if (schedule) return call("schedules.create", { prompt: schedule[2], kind: "task", dueAt: inMinutes(Number(schedule[1])).toISOString() });
  if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
  if (text.startsWith("look for ")) return call("memory.search", { query: text.slice("look for ".length) });
  if (text === "list schedules") return call("schedules.list", {});
  const change = /^(pause|remove) (\S+)$/.exec(text);
  if (change) return call(`schedules.${change[1]}`, change[1] === "pause" ? { id: change[2], paused: true } : { id: change[2] });
  return null;
}, ({ last }) => (last?.role === "tool" ? `Found: ${String(last.content).slice(0, 3000)}` : null)];

/** A Trunk holding exactly `permissions`, introduced and ready. */
async function trunk(app, name, permissions) {
  const made = app.trunks.create({ name });
  app.trunks.edit(made.id, { permissions });
  await app.trunks.introduced();
  return made;
}
/** What one tool gave back in one task: its result, or why it did not run. */
function outcome(app, runId, name) {
  const events = app.store.events(runId).filter((event) => event.data?.name === name);
  const done = events.find((event) => event.kind === "tool.completed");
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((event) => event.kind === "tool.failed" || event.kind === "tool.stalled");
  return { ok: false, error: failed ? String(failed.data.error) : "it never ran" };
}
/** The permissions a task started with. */
const startedWith = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started")?.data.permissions ?? [];
/** Every model request made while `work` runs, as one text, with what `work` returned. */
async function sentDuring(provider, work) {
  const before = provider.requests.length;
  const value = await work();
  return { value, sent: JSON.stringify(provider.requests.slice(before)) };
}
const schedulesOf = (app, trunkId) => app.store.list("schedules", app.runtime.owner)
  .filter((record) => record.data.startedBy === trunkId).sort((a, b) => a.data.dueAt.localeCompare(b.data.dueAt));
const documentsLookedUp = (app, runId) => app.store.events(runId).some((event) => event.kind === "documents.retrieved");
const saved = (app, id) => app.store.get("schedules", app.runtime.owner, id);
/** What one schedules tool gave back in a Trunk's own turn. */
async function inTurnOf(app, trunkId, text, tool) {
  const said = await app.trunks.say(trunkId, text);
  return outcome(app, said.runId, tool);
}
/** The owner's repeating schedule with a webhook, run once: it is waiting for its next turn and keeps its last result. */
async function ownersSchedule(app) {
  await app.registry.execute("memory.put", { text: `zebra owner ${ownerFact}`, source: "the owner" }, app.runtime.context());
  const made = app.scheduler.create(app.runtime.context({ source: "owner" }), {
    prompt: "look for zebra", kind: "task", dueAt: inMinutes(1).toISOString(), intervalMs: 3600000, webhook: true });
  await app.scheduler.tick(inMinutes(5));
  const record = saved(app, made.id);
  assert.match(String(record.data.lastResult ?? ""), new RegExp(ownerFact), "control: the owner's schedule ran and kept its result");
  assert.equal(record.data.status, "pending", "control: it waits for its next turn");
  assert.ok(record.data.hookToken, "control: it has a webhook token");
  return record;
}

test("a schedule a Trunk made fires with that Trunk's instructions and never with the owner's documents, while the owner's own schedule gets them", async (t) => {
  const { app, provider } = await fixture(t, rules);
  on(app);
  const ada = await trunk(app, "Ada", ["memory.read", "memory.write", "schedules.manage", "schedules.read"]);
  await app.documents.add(app.runtime.owner, { text: `zebra notes only the owner keeps ${ownerDocument}`, name: "owner-notes.txt" });
  app.scheduler.create(app.runtime.context({ source: "owner" }), { prompt: "zebra", kind: "task", dueAt: inMinutes(1).toISOString() });
  await app.trunks.say(ada.id, "schedule in 10: zebra");
  assert.equal(schedulesOf(app, ada.id).length, 1, "Ada made a schedule of her own");

  const owners = await sentDuring(provider, () => app.scheduler.tick(inMinutes(5)));
  assert.equal(owners.value.length, 1, "the owner's schedule fired");
  assert.ok(owners.sent.includes(ownerDocument), "control: the owner's own schedule is given the owner's document");
  assert.ok(documentsLookedUp(app, owners.value[0].id), "control: the owner's own schedule looks in the owner's documents");

  const adas = await sentDuring(provider, () => app.scheduler.tick(inMinutes(15)));
  assert.equal(adas.value.length, 1, "Ada's schedule fired");
  assert.ok(!adas.sent.includes(ownerDocument), "the owner's documents are never put in front of a Trunk's scheduled task");
  assert.ok(!documentsLookedUp(app, adas.value[0].id), "a Trunk's scheduled task does not look in the owner's documents");
  assert.match(adas.sent, /You are Ada \(@/, "a Trunk's scheduled task carries that Trunk's own instructions");
});

test("a schedule a Trunk made fires with that Trunk's permissions as they are now, so narrowing them applies to it", async (t) => {
  const { app } = await fixture(t, rules);
  on(app);
  const ada = await trunk(app, "Ada", ["memory.read", "memory.write", "schedules.manage", "schedules.read"]);
  await app.registry.execute("memory.put", { text: `zebra owner ${ownerFact}`, source: "the owner" }, app.runtime.context());
  await app.trunks.say(ada.id, `remember zebra Ada ${adaFact}`);
  await app.trunks.say(ada.id, "schedule in 1: look for zebra");
  await app.trunks.say(ada.id, "schedule in 10: look for zebra");
  assert.equal(schedulesOf(app, ada.id).length, 2, "Ada made two schedules");

  await app.scheduler.tick(inMinutes(5));
  const before = String(schedulesOf(app, ada.id)[0].data.lastResult ?? "");
  assert.match(before, new RegExp(adaFact), "control: before the owner narrows Ada, her schedule finds her own fact");
  assert.doesNotMatch(before, new RegExp(ownerFact), "control: and never the owner's");

  app.trunks.edit(ada.id, { permissions: ["schedules.read"] });
  const [fired] = await app.scheduler.tick(inMinutes(15));
  assert.ok(fired, "Ada's second schedule fired");
  assert.ok(!startedWith(app, fired.id).includes("memory.read"), `it starts without memory.read once Ada no longer has it: ${JSON.stringify(startedWith(app, fired.id))}`);
  const search = outcome(app, fired.id, "memory.search");
  assert.equal(search.ok, false, "memory.search is refused to it");
  assert.match(search.error, /Permission denied: memory\.read/, "because Ada no longer holds memory.read");
  assert.doesNotMatch(fired.output, new RegExp(adaFact), "her fact does not come back in the task's answer");
  assert.doesNotMatch(String(schedulesOf(app, ada.id)[1].data.lastResult ?? ""), new RegExp(adaFact), "nor in the schedule's last result");
});

test("a Trunk's schedules.list holds only the schedules it made, never another's results or webhook tokens, and the owner's holds every one", async (t) => {
  const { app } = await fixture(t, rules);
  on(app);
  const ada = await trunk(app, "Ada", ["memory.read", "schedules.manage", "schedules.read"]);
  const bo = await trunk(app, "Bo", ["schedules.manage", "schedules.read"]);
  const owners = await ownersSchedule(app);
  await app.trunks.say(ada.id, "schedule in 120: look for zebra");
  const [adas] = schedulesOf(app, ada.id);
  assert.ok(adas, "Ada made a schedule of her own");

  const adaList = await inTurnOf(app, ada.id, "list schedules", "schedules.list");
  assert.equal(adaList.ok, true, adaList.error);
  assert.deepEqual(adaList.result.map((record) => record.id), [adas.id], "Ada's list holds her own schedule and nothing else");
  const shown = JSON.stringify(adaList.result);
  assert.ok(!shown.includes(ownerFact), "the owner's last result is not in Ada's list");
  assert.ok(!shown.includes(owners.data.hookToken), "nor the owner's webhook token");

  const boList = await inTurnOf(app, bo.id, "list schedules", "schedules.list");
  assert.equal(boList.ok, true, boList.error);
  assert.deepEqual(boList.result, [], "Bo sees neither Ada's schedule nor the owner's");

  const ownerList = await app.registry.execute("schedules.list", {}, app.runtime.context());
  assert.deepEqual(ownerList.map((record) => record.id).sort(), [owners.id, adas.id].sort(), "the owner's list still holds both");
});

test("a Trunk pausing or removing a schedule it did not make gets the answer a missing one gets, and the schedule stays as it was", async (t) => {
  const { app } = await fixture(t, rules);
  on(app);
  const ada = await trunk(app, "Ada", ["memory.read", "schedules.manage", "schedules.read"]);
  const bo = await trunk(app, "Bo", ["schedules.manage", "schedules.read"]);
  const owners = await ownersSchedule(app);
  await app.trunks.say(ada.id, "schedule in 120: look for zebra");
  const [adas] = schedulesOf(app, ada.id);
  assert.ok(adas, "Ada made a schedule of her own");
  const missing = randomUUID(), gone = (id) => ({ ok: true, result: { id, removed: false } });

  const pauseMissing = await inTurnOf(app, ada.id, `pause ${missing}`, "schedules.pause");
  assert.equal(pauseMissing.ok, false, "control: pausing a missing schedule is refused");
  assert.deepEqual(await inTurnOf(app, ada.id, `pause ${owners.id}`, "schedules.pause"), pauseMissing,
    "Ada pausing the owner's schedule gets exactly the answer a missing schedule gets");
  assert.deepEqual(await inTurnOf(app, ada.id, `remove ${missing}`, "schedules.remove"), gone(missing), "control: removing a missing schedule removes nothing");
  assert.deepEqual(await inTurnOf(app, ada.id, `remove ${owners.id}`, "schedules.remove"), gone(owners.id),
    "Ada removing the owner's schedule is told nothing was removed, as for a missing one");
  assert.deepEqual(saved(app, owners.id)?.data, owners.data, "the owner's schedule is still there, unchanged");

  assert.deepEqual(await inTurnOf(app, bo.id, `pause ${adas.id}`, "schedules.pause"), pauseMissing, "Bo pausing Ada's schedule gets the missing answer");
  assert.deepEqual(await inTurnOf(app, bo.id, `remove ${adas.id}`, "schedules.remove"), gone(adas.id), "Bo removing Ada's schedule removes nothing");
  assert.deepEqual(saved(app, adas.id)?.data, adas.data, "Ada's schedule is still there, unchanged");

  assert.equal((await inTurnOf(app, ada.id, `pause ${adas.id}`, "schedules.pause")).ok, true, "Ada still pauses her own schedule");
  assert.equal(saved(app, adas.id).data.status, "paused");
  await app.registry.execute("schedules.pause", { id: adas.id, paused: false }, app.runtime.context());
  assert.equal(saved(app, adas.id).data.status, "pending", "the owner still resumes any schedule");
  assert.deepEqual(await inTurnOf(app, ada.id, `remove ${adas.id}`, "schedules.remove"), { ok: true, result: { id: adas.id, removed: true } },
    "Ada still removes her own schedule");
});

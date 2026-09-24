/**
 * A schedule a Trunk made fires shaped as that Trunk, as its own turn and its routines are: with its
 * instructions, its own memory scope, and its permissions as they are now, never more than the
 * schedule itself was given. So the owner's documents are not put in front of it, and narrowing the
 * Trunk's permissions applies to the schedules it already made.
 *
 * Everything goes through real Trunk turns (`trunks.say`), the real scheduler, the real tools and a
 * scripted model.
 */
import test from "node:test";
import assert from "node:assert/strict";
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

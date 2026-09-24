/**
 * FQ-routing.isolated-agents: memory.tidy ran over every memory record of the owner with no check of
 * the caller's agent, so a Trunk (memory.write by default) running `memory.tidy {}` was handed another
 * Trunk's fact ids and full text in neverUsed, duplicates, contradictions and leftoverScratch, and
 * `stage: true` queued archive/merge proposals against facts that were never its own. The report now
 * holds only what the caller may read (`visibleTo`, as memory.search does), and staging reaches only
 * what it may write (`writableTo`, as memory.update/delete/keep do). The owner's own tidy is unchanged.
 *
 * The same sweep of the other memory tools found two more: memory.label changed a fact guarded only
 * by the read rule (so a Trunk could relabel a shared fact it may read but never write), and
 * hindsight.recall / hindsight.reflect handed a Trunk the owner's one Hindsight bank, which the
 * memory.outside_* path already refuses.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { registerHindsight, Hindsight } from "../dist/asks/hindsight.js";

function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

const tidyRules = [({ last }) => {
  if (last?.role !== "user") return null;
  const text = String(last.content ?? "");
  if (text === "tidy") return call("memory.tidy", {});
  if (text === "tidy and stage") return call("memory.tidy", { stage: true });
  return null;
}, ({ last }) => (last?.role === "tool" ? "Done." : null)];

/** Two Trunks, each with a duplicate pair, a contradiction pair and a job note; one shared fact. */
async function seeded(t) {
  const { app } = await fixture(t, tidyRules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();
  const put = (id, text, scope, extra = {}) => app.store.save("memory", "local", id, { text, source: "seed", scope, ...extra });
  const facts = (who, trunk) => {
    const scope = `agent:trunk:${trunk.id}`;
    put(`${who}-dup-1`, `${who}'s secret plan is to ship the rocket on Friday`, scope);
    put(`${who}-dup-2`, `${who}'s secret plan is to ship the rocket on Friday!`, scope);
    put(`${who}-old`, `${who} launch code: 1234`, scope, { validFrom: "2025-01-01T00:00:00.000Z" });
    put(`${who}-new`, `${who} launch code: 9876`, scope, { validFrom: "2026-01-01T00:00:00.000Z" });
    put(`${who}-note`, `${who} scribbled a note while working`, scope, { layer: "task" });
    return [`${who}-dup-1`, `${who}-dup-2`, `${who}-old`, `${who}-new`, `${who}-note`];
  };
  const adaIds = facts("Ada", ada), boIds = facts("Bo", bo);
  put("shared-fact", "The office opens at nine every morning", "shared");
  return { app, ada, bo, adaIds, boIds };
}

test("a Trunk's memory.tidy report holds only what it may read", async (t) => {
  const { app, bo, adaIds, boIds } = await seeded(t);
  const run = await app.trunks.say(bo.id, "tidy");
  const outcome = toolOutcome(app, run.runId, "memory.tidy");
  assert.equal(outcome.ok, true, outcome.error);
  const report = outcome.result, text = JSON.stringify(report);
  for (const id of adaIds) assert.ok(!text.includes(id), `Ada's ${id} must not reach Bo`);
  assert.doesNotMatch(text, /Ada/, "none of Ada's wording either");
  // Not a vacuous pass: Bo's own troubles are all still found.
  assert.deepEqual(report.duplicates.map((group) => [group.keep, ...group.drop].sort()), [["Bo-dup-1", "Bo-dup-2"]]);
  assert.deepEqual(report.contradictions.map((pair) => pair.older.id), ["Bo-old"]);
  assert.deepEqual(report.leftoverScratch.map((entry) => entry.id), ["Bo-note"]);
  assert.ok(report.neverUsed.some((entry) => entry.id === "shared-fact"), "a shared fact Bo may read is reported");
  assert.equal(report.health.facts, boIds.length + 1, "the counts are of what Bo may see, too");
});

test("a Trunk's memory.tidy stage never queues a suggestion about a fact it may not write", async (t) => {
  const { app, bo, adaIds, boIds } = await seeded(t);
  const run = await app.trunks.say(bo.id, "tidy and stage");
  const outcome = toolOutcome(app, run.runId, "memory.tidy");
  assert.equal(outcome.ok, true, outcome.error);
  const touched = (proposal) => [proposal.memoryId, ...proposal.memoryIds].filter(Boolean);
  const pending = app.store.review.proposals("local", "pending");
  assert.ok(outcome.result.staged.length > 0, "Bo's own findings are still staged");
  for (const proposal of [...outcome.result.staged, ...pending])
    for (const id of touched(proposal)) assert.ok(boIds.includes(id), `${id} is not Bo's to change (${proposal.kind})`);
  assert.ok(!pending.some((proposal) => touched(proposal).some((id) => adaIds.includes(id) || id === "shared-fact")));
});

test("the owner's own memory.tidy still sees every agent's facts", async (t) => {
  const { app, adaIds, boIds } = await seeded(t);
  const report = await app.runtime.executeTool("memory.tidy", {});
  assert.equal(report.duplicates.length, 2);
  assert.deepEqual(report.contradictions.map((pair) => pair.older.id).sort(), ["Ada-old", "Bo-old"]);
  assert.deepEqual(report.leftoverScratch.map((entry) => entry.id).sort(), ["Ada-note", "Bo-note"]);
  assert.equal(report.health.facts, adaIds.length + boIds.length + 1);
});

test("memory.label is a write: a Trunk may read a shared fact but not relabel it", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("label ")) return call("memory.label", { id: text.slice("label ".length), tags: ["hijacked"] });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);
  app.learningMore.setMode("expiry", { mode: "on" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();
  app.store.save("memory", "local", "shared-fact", { text: "The office opens at nine", source: "owner", scope: "shared" });
  app.store.save("memory", "local", "bo-fact", { text: "Bo keeps his notes in blue", source: "Bo", scope: `agent:trunk:${bo.id}` });

  const shared = await app.trunks.say(bo.id, "label shared-fact");
  const sharedOutcome = toolOutcome(app, shared.runId, "memory.label");
  assert.equal(sharedOutcome.ok, false, "refused");
  assert.match(sharedOutcome.error, /no longer saved/i, "refused exactly as an unknown id is");
  assert.equal(app.store.get("memory", "local", "shared-fact").data.tags, undefined, "the shared fact is untouched");

  const own = await app.trunks.say(bo.id, "label bo-fact");
  assert.equal(toolOutcome(app, own.runId, "memory.label").ok, true, "Bo still labels his own fact");
  assert.deepEqual(app.store.get("memory", "local", "bo-fact").data.tags, ["hijacked"]);
});

test("hindsight.recall and hindsight.reflect refuse a Trunk or delegated specialist before any call", async () => {
  const tools = new Map();
  const registry = { register: (tool) => tools.set(tool.name, tool) };
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    const body = String(url).endsWith("/reflect") ? { text: "the owner's answer" } : { results: [{ text: "the owner's secret", type: "world" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const saved = new Map([["asks-hindsight", { mode: "on" }]]);
  const store = {
    get: (_t, _o, key) => (saved.has(key) ? { data: saved.get(key) } : undefined),
    save: (_t, _o, key, value) => saved.set(key, value),
    profiles: { scope: () => "local" }
  };
  const hindsight = new Hindsight(store, "local", fetcher, async () => "");
  hindsight.save({ address: "https://hindsight.example/" });
  registerHindsight(registry, hindsight, store);
  for (const agent of ["trunk:ada", "researcher"]) {
    const context = { owner: "local", agent };
    await assert.rejects(tools.get("hindsight.recall").execute({ query: "secrets", maxTokens: 2048 }, context), /one shared bank/);
    await assert.rejects(tools.get("hindsight.reflect").execute({ query: "secrets" }, context), /one shared bank/);
  }
  assert.deepEqual(calls, [], "the owner's bank was never asked");
  // The owner's own turn is unaffected.
  const recall = await tools.get("hindsight.recall").execute({ query: "secrets", maxTokens: 2048 }, { owner: "local" });
  assert.equal(recall.memories[0].text, "the owner's secret");
});

test("a Trunk stages nothing against shared facts when tidying with stage: true", async (t) => {
  const { app } = await fixture(t, tidyRules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();

  // Seed a shared duplicate pair
  app.store.save("memory", "local", "shared-dup-1", { text: "The launch is Friday at noon", source: "seed", scope: "shared" });
  app.store.save("memory", "local", "shared-dup-2", { text: "The launch is Friday at noon", source: "seed", scope: "shared" });

  // Seed a shared task note
  app.store.save("memory", "local", "shared-task", { text: "Remember to call the team", source: "seed", scope: "shared", layer: "task" });

  // Seed Ada's own note that should be staged
  app.store.save("memory", "local", "ada-task", { text: "Ada's reminder to check inventory", source: "seed", scope: `agent:trunk:${ada.id}`, layer: "task" });

  // Run memory.tidy with stage: true
  const run = await app.trunks.say(ada.id, "tidy and stage");
  const outcome = toolOutcome(app, run.runId, "memory.tidy");
  assert.equal(outcome.ok, true, outcome.error);

  // Check that Ada's own note is staged but shared facts are not
  const pending = app.store.review.proposals("local", "pending");
  const touched = (proposal) => [proposal.memoryId, ...proposal.memoryIds].filter(Boolean);
  const stagedIds = new Set();
  for (const proposal of pending) {
    for (const id of touched(proposal)) stagedIds.add(id);
  }

  assert.ok(stagedIds.has("ada-task"), "Ada's own task note is staged");
  assert.ok(!stagedIds.has("shared-dup-1") && !stagedIds.has("shared-dup-2"), "shared duplicates are not staged");
  assert.ok(!stagedIds.has("shared-task"), "shared task note is not staged");
});

test("the owner's tidy never merges one person's fact into another's, so the owner's words never reach a Trunk", async (t) => {
  const { app, ada } = await seeded(t);
  const scope = `agent:trunk:${ada.id}`;
  // The owner's own fact, then Ada's saying nearly the same with fewer words (the newest is kept by a merge).
  app.store.save("memory", "local", "owner-wifi", { text: "The wifi password is hunter2 pin 4417", source: "seed", validFrom: "2026-01-01T00:00:00.000Z" });
  app.store.save("memory", "local", "ada-wifi", { text: "The wifi password is hunter2", source: "seed", scope, validFrom: "2026-01-02T00:00:00.000Z" });
  const report = await app.runtime.executeTool("memory.tidy", { stage: true });
  const grouped = report.duplicates.map((group) => [group.keep, ...group.drop].sort());
  assert.ok(!grouped.some((ids) => ids.includes("owner-wifi") && ids.includes("ada-wifi")), JSON.stringify(grouped));
  assert.equal(report.duplicates.length, 2, "each Trunk's own duplicates are still found");
  for (const proposal of app.store.review.proposals("local", "pending")) await app.store.review.decide("local", proposal.id, true);
  assert.equal(app.store.get("memory", "local", "ada-wifi")?.data.text, "The wifi password is hunter2", "Ada's fact keeps her own words");
  assert.equal(app.store.get("memory", "local", "ada-wifi")?.data.scope, scope);
  assert.equal(app.store.get("memory", "local", "owner-wifi")?.data.text, "The wifi password is hunter2 pin 4417", "and the owner's is not set aside for hers");
  const run = await app.trunks.say(ada.id, "tidy");
  assert.doesNotMatch(JSON.stringify(toolOutcome(app, run.runId, "memory.tidy").result), /4417/, "nothing of the owner's reaches Ada");
});

test("the owner's newer fact about the same thing never sets a Trunk's older fact aside, nor the other way round", async (t) => {
  const { app, ada } = await seeded(t);
  const scope = `agent:trunk:${ada.id}`;
  // Ada's is saved last, so saving it ends nothing of the owner's, and both are current.
  app.store.save("memory", "local", "owner-gate", { text: "Garden gate code: 2222", source: "seed", entity: "garden gate", attribute: "code", validFrom: "2026-06-01T00:00:00.000Z" });
  app.store.save("memory", "local", "ada-gate", { text: "Garden gate code: 1111", source: "seed", scope, entity: "garden gate", attribute: "code", validFrom: "2025-06-01T00:00:00.000Z" });
  const report = await app.runtime.executeTool("memory.tidy", { stage: true });
  const pairs = report.contradictions.map((pair) => [pair.older.id, pair.newer.id]);
  assert.ok(!pairs.some((pair) => pair.includes("ada-gate") && pair.includes("owner-gate")), JSON.stringify(pairs));
  assert.deepEqual(report.contradictions.map((pair) => pair.older.id).sort(), ["Ada-old", "Bo-old"], "each Trunk's own contradictions are still found");
  for (const proposal of app.store.review.proposals("local", "pending")) await app.store.review.decide("local", proposal.id, true);
  assert.equal(app.store.get("memory", "local", "ada-gate")?.data.text, "Garden gate code: 1111", "Ada keeps her fact");
});

test("a merge suggested before tidying knew whose facts are whose is refused when the owner accepts it, and changes nothing", async (t) => {
  const { app, ada } = await seeded(t);
  const scope = `agent:trunk:${ada.id}`;
  app.store.save("memory", "local", "owner-wifi", { text: "The wifi password is hunter2 pin 4417", source: "seed" });
  app.store.save("memory", "local", "ada-wifi", { text: "The wifi password is hunter2", source: "seed", scope });
  // As the old tidy, the nightly pass or the look back could have left it waiting.
  const stale = app.store.review.propose("local", { kind: "merge", memoryId: "ada-wifi", memoryIds: ["ada-wifi", "owner-wifi"],
    text: "The wifi password is hunter2 pin 4417", source: "Suggested while tidying memory" });
  await assert.rejects(() => app.store.review.decide("local", stale.id, true), /different people/);
  assert.equal(app.store.get("memory", "local", "ada-wifi")?.data.text, "The wifi password is hunter2", "Ada's fact keeps her own words");
  assert.equal(app.store.get("memory", "local", "owner-wifi")?.data.text, "The wifi password is hunter2 pin 4417", "the owner's is not set aside");
  const run = await app.trunks.say(ada.id, "tidy");
  assert.doesNotMatch(JSON.stringify(toolOutcome(app, run.runId, "memory.tidy").result), /4417/);
  // A merge within one person's facts still goes through.
  const own = app.store.review.propose("local", { kind: "merge", memoryId: "Ada-dup-1", memoryIds: ["Ada-dup-1", "Ada-dup-2"],
    text: "Ada's secret plan is to ship the rocket on Friday!", source: "Suggested while tidying memory" });
  await app.store.review.decide("local", own.id, true);
  assert.equal(app.store.get("memory", "local", "Ada-dup-2"), undefined, "her own duplicate is set aside");
});

test("facts found alike by meaning are grouped within one person's facts, never across", async (t) => {
  const { app, ada } = await seeded(t);
  const { MemoryHygiene } = await import("../dist/memory-hygiene.js");
  const scope = `agent:trunk:${ada.id}`;
  app.store.save("memory", "local", "owner-bank", { text: "My bank PIN is 7731", source: "seed" });
  app.store.save("memory", "local", "ada-card", { text: "Card code: seven seven three one", source: "seed", scope });
  app.store.save("memory", "local", "ada-card-2", { text: "Code for the card is 7731", source: "seed", scope });
  // The same meaning for all three, whatever their words.
  const same = new Float32Array([1, 0, 0]);
  const hygiene = new MemoryHygiene(app.store, { vectors: () => new Map([["owner-bank", same], ["ada-card", same], ["ada-card-2", same]]), useCounts: () => new Map() });
  const groups = hygiene.duplicates("local").filter((group) => group.by === "meaning").map((group) => [group.keep, ...group.drop].sort());
  assert.ok(!groups.some((ids) => ids.includes("owner-bank") && ids.some((id) => id.startsWith("ada-"))), JSON.stringify(groups));
  assert.ok(groups.some((ids) => ids.includes("ada-card") && ids.includes("ada-card-2")), "Ada's two are still found alike");
});

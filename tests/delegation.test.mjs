import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBranch, checkResult, fanoutWaves } from "../dist/index.js";

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
/** Answers by the child's instructions so each delegated task is distinguishable. */
function scripted() {
  const provider = { name: "scripted", requests: [], holds: new Map(), async complete(request) {
    const system = request.messages[0].content, user = request.messages.filter((m) => m.role === "user").at(-1).content;
    provider.requests.push({ system, user, at: Date.now() });
    for (const [needle, hold] of provider.holds) if (user.includes(needle)) {
      const aborted = new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
      await Promise.race([hold.promise, aborted]);
    }
    request.signal.throwIfAborted();
    if (/answer as json/i.test(system)) return { content: user.includes("bad") ? "not json at all" : '```json\n{"city":"Lagos","temperature":31}\n```', toolCalls: [] };
    if (/parallel/i.test(system)) return { content: `done:${user.split(/\s+/)[0]}`, toolCalls: [] };
    return { content: `child said: ${user.slice(0, 40)}`, toolCalls: [] };
  } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-delegation-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, provider };
}

test("a child's answer is checked against the requested schema and reported unresolved when it does not match", async (t) => {
  const { app } = await fixture(t);
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  const schema = { type: "object", required: ["city", "temperature"], properties: { city: { type: "string", minLength: 2 }, temperature: { type: "number", minimum: -90, maximum: 60 } } };
  const good = await app.runtime.delegateChecked("weather please", context, ["files.read"], "Answer as JSON.", { resultSchema: schema });
  assert.equal(good.result.status, "resolved");
  assert.deepEqual(good.result.value, { city: "Lagos", temperature: 31 });
  const bad = await app.runtime.delegateChecked("bad weather please", context, ["files.read"], "Answer as JSON.", { resultSchema: schema });
  assert.equal(bad.result.status, "unresolved");
  assert.match(bad.result.reason, /not valid JSON/);
  assert.equal(bad.run.status, "completed", "the child itself finished; only the check failed");
  assert.ok(app.store.events(parent.id).some((e) => e.kind === "delegation.unresolved" && e.data.childRunId === bad.run.id));
  assert.deepEqual(checkResult('{"a":[1,2]}', { type: "object", properties: { a: { type: "array", items: { type: "integer" }, minItems: 3 } } }), { status: "unresolved", reason: "result.a needs at least 3 items" });
  assert.deepEqual(checkResult('"x"', { enum: ["x", "y"] }), { status: "resolved", value: "x" });
  assert.equal(checkResult("free text", undefined).status, "resolved");
});

test("delegation enforces depth, concurrency and a child timeout, and cancelling the parent cancels children", async (t) => {
  const { app, provider } = await fixture(t);
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  await assert.rejects(app.runtime.delegate("x", { ...context, depth: 3 }, ["files.read"], ""), /depth limit/);
  await assert.rejects(app.runtime.delegate("x", context, ["files.read"], "", { timeoutMs: 10 }), /1 to 120 seconds/);
  const hold = deferred(); provider.holds.set("slow", hold);
  const slow = Array.from({ length: 4 }, (_, i) => app.runtime.delegate(`slow ${i}`, context, ["files.read"], ""));
  await delay(50);
  await assert.rejects(app.runtime.delegate("slow 5", context, ["files.read"], ""), /concurrency limit/);
  hold.resolve(); provider.holds.delete("slow");
  const finished = await Promise.all(slow);
  assert.ok(finished.every((run) => run.status === "completed"));
  const stuck = deferred(); provider.holds.set("stuck", stuck);
  const timedOut = await app.runtime.delegate("stuck child", context, ["files.read"], "", { timeoutMs: 1000 });
  assert.equal(timedOut.status, "cancelled");
  assert.match(timedOut.output, /longer than 1 seconds/);
  stuck.resolve(); provider.holds.delete("stuck");
  const controller = new AbortController();
  const holdChild = deferred(); provider.holds.set("nested", holdChild);
  const cancellable = app.runtime.context({ runId: parent.id, signal: controller.signal });
  const child = app.runtime.delegate("nested child", cancellable, ["files.read"], "");
  await delay(50);
  controller.abort(new Error("Cancelled by user"));
  holdChild.resolve();
  const cancelled = await child;
  assert.equal(cancelled.status, "cancelled", "the child sees the parent's cancellation");
});

test("fan-out runs independent tasks together, orders dependent ones, feeds results forward and merges under the parent", async (t) => {
  const { app, provider } = await fixture(t);
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  const tasks = [
    { id: "a", prompt: "alpha work", dependsOn: [] }, { id: "b", prompt: "beta work", dependsOn: [] },
    { id: "c", prompt: "combine", dependsOn: ["a", "b"] },
  ];
  assert.deepEqual(fanoutWaves(tasks), [["a", "b"], ["c"]]);
  assert.throws(() => fanoutWaves([{ id: "x", prompt: "p", dependsOn: ["y"] }]), /unknown task y/);
  assert.throws(() => fanoutWaves([{ id: "x", prompt: "p", dependsOn: ["y"] }, { id: "y", prompt: "p", dependsOn: ["x"] }]), /cycle/);
  // Both independent tasks must be in flight before either is allowed to finish: that proves overlap without timing.
  const gate = deferred();
  provider.holds.set("alpha", gate); provider.holds.set("beta", gate);
  const pending = app.runtime.fanout(context, tasks, () => ({ permissions: ["files.read"], instructions: "Parallel worker." }));
  for (let i = 0; i < 300 && provider.requests.filter((r) => /alpha work|beta work/.test(r.user)).length < 2; i++) await delay(10);
  assert.equal(provider.requests.filter((r) => /alpha work|beta work/.test(r.user)).length, 2, "alpha and beta started together");
  assert.equal(provider.requests.filter((r) => /combine/.test(r.user)).length, 0, "combine waits for its dependencies");
  gate.resolve(); provider.holds.delete("alpha"); provider.holds.delete("beta");
  const outcome = await pending;
  assert.deepEqual(outcome.waves, [["a", "b"], ["c"]]);
  assert.equal(outcome.tasks.a.output, "done:alpha");
  assert.equal(outcome.tasks.b.output, "done:beta");
  assert.equal(outcome.tasks.c.output, "done:combine");
  const runs = app.store.runs("local");
  const combineRun = runs.find((r) => r.id === outcome.tasks.c.runId);
  assert.match(app.store.messages(combineRun.sessionId)[0].content, /Results from earlier tasks:[\s\S]*\[a\] done:alpha[\s\S]*\[b\] done:beta/);
  const event = app.store.events(parent.id).find((e) => e.kind === "delegation.fanout");
  assert.deepEqual(event.data.waves, [["a", "b"], ["c"]]);
  assert.equal(event.data.tasks.c.result, "resolved");
});

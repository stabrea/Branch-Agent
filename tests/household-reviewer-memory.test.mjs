/**
 * FQ-routing.isolated-agents: the reviewer pass (src/orchestration.ts critique) reads the task's own
 * memory scope. With a household profile switched on that is the profile's facts, never the owner's,
 * and the owner's own task afterwards is never shown what the profile's task learned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./trunks-helpers.mjs";
import { saveOrchestrationSettings } from "../dist/orchestration.js";

const OWNER = "OWNERPRIV3391", SAM = "SAMOWN4242";

test("the reviewer of a household profile's task is shown that profile's memory, never the owner's", async (t) => {
  const reviewed = [];
  const { app } = await fixture(t, [({ system, last }) => {
    if (!/You review a finished answer/.test(system)) return null;
    const body = String(last?.content ?? "");
    reviewed.push({ owner: body.includes(OWNER), sam: body.includes(SAM) });
    return JSON.stringify({ verdict: "accept", fixes: [] });
  }]);
  await app.registry.execute("memory.put", { text: `zebra owner ${OWNER}`, source: "the owner" }, app.runtime.context());
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  await app.registry.execute("memory.put", { text: `zebra Sam ${SAM}`, source: "Sam" }, app.runtime.context());
  saveOrchestrationSettings(app.store, app.runtime.owner, { verify: true });

  await app.runtime.run({ prompt: "how is the zebra, Sam asks" });
  assert.ok(reviewed.length >= 1, "the reviewer looked at Sam's answer");
  assert.deepEqual(reviewed[0], { owner: false, sam: true }, "the reviewer of Sam's task is shown only Sam's memory");

  app.store.profiles.switch({ profileId: null });
  reviewed.length = 0;
  await app.runtime.run({ prompt: "how is the zebra, the owner asks" });
  assert.ok(reviewed.length >= 1, "the reviewer looked at the owner's answer");
  assert.deepEqual(reviewed[0], { owner: true, sam: false }, "the owner's reviewer is shown the owner's memory, never Sam's");
});

/**
 * mac7/residuals: the leftovers reviewers found on 2026-09-19 (docs/agents/STATUS-residuals.md).
 * Each test fails with its fix taken out. A stand-in model and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { replayRun } from "../dist/replay.js";
import { keyAnswerRefusal, runOrigin, underShortLivedKey } from "../dist/key-context.js";
import { accessRefusal, keyRefusal } from "../dist/devices/tools.js";

/** A model that calls the tool the newest message names ("please <tool> <json>"), then says it is done. */
function scripted() {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => {
    model.requests.push(request);
    const last = request.messages.at(-1);
    const asked = /please ([a-z_.]+) (\{.*\})$/s.exec(last?.role === "user" ? String(last.content) : "");
    if (asked) return { content: "", toolCalls: [{ id: `c${model.requests.length}`, name: asked[1], arguments: asked[2] }] };
    return { content: "Done.", toolCalls: [] };
  };
  return model;
}
async function fixture(t, provider = scripted()) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider, home: join(root, "home") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;

test("1. Do this again on a short-lived key's task is held as that key's work, not the owner's own", async (t) => {
  const { app } = await fixture(t);
  const first = await underShortLivedKey(() => app.runtime.run({ prompt: "hello" }), { keyId: "k1" });
  assert.equal(started(app, first.id).shortLivedKey, true);
  // The owner presses "Do this again" in the window: no key behind this request.
  const again = (await replayRun(app.runtime, app.store, first.id)).run;
  assert.equal(started(app, again.id).shortLivedKey, true, "the copy is marked as a key's work");
  assert.deepEqual(runOrigin(app.store, again.id).keyIds, ["k1"], "and names the key");
  assert.equal(accessRefusal({ store: app.store }, { runId: again.id }), keyRefusal, "owner-only tools refuse it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k2" }) !== null, true, "another key may not answer it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k1" }), null, "its own key may");
  // The owner's own task done again is unchanged.
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = (await replayRun(app.runtime, app.store, mine.id)).run;
  assert.equal(started(app, own.id).shortLivedKey, undefined);
  assert.equal(started(app, own.id).originFrom, undefined);
});

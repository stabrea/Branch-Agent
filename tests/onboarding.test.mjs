import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const answering = { name: "answering", calls: 0, async complete(request) {
  answering.calls += 1;
  assert.equal(request.tools.length, 0, "the test call carries no tools");
  return { content: "OK", toolCalls: [], usage: { input: 20, output: 1 } };
} };
const broken = { name: "broken", async complete() { throw new Error("connection refused"); } };

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-onboard-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), presets };
  const app = await createBranch(options);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { app, call, options };
}

test("setup ends with a real test call and a remembered completion", async (t) => {
  const { app, call, options } = await fixture(t, [
    { id: "good", name: "Good model", provider: answering, model: "g-1" },
    { id: "bad", name: "Broken model", provider: broken, model: "b-1" },
  ]);
  assert.deepEqual((await call("state")).data.onboarding, { done: false });
  const ok = await call("models/test", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.presetName, "Good model");
  assert.equal(ok.data.reply, "OK");
  assert.ok(ok.data.ms >= 0);
  assert.equal(answering.calls, 1);
  assert.equal(app.store.runs("local").length, 0, "the test call leaves no conversation behind");
  const failed = await call("models/test", { preset: "bad" });
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /Broken model did not answer/);
  assert.equal((await call("models/test", { preset: "nope" })).status, 400);
  assert.deepEqual((await call("onboarding", { done: true })).data, { done: true });
  assert.deepEqual((await call("state")).data.onboarding, { done: true });
  await app.close();
  const reopened = await createBranch(options);
  assert.equal(reopened.store.get("settings", "local", "onboarding").data.done, true, "completion survives restart");
  await reopened.close();
});

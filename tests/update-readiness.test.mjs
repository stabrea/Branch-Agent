import test from "node:test";
import assert from "node:assert/strict";
import { updateReadiness } from "../dist/desktop/update-readiness.js";

test("desktop update readiness reads only the authenticated loopback engine", async () => {
  const calls = [];
  const call = async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    return { ok: true, json: async () => ({ channel: "beta", busyTasks: 2 }) };
  };
  assert.deepEqual(await updateReadiness("http://127.0.0.1:3210", "test-token", call),
    { channel: "beta", busyTasks: 2 });
  assert.deepEqual(calls, [{ url: "http://127.0.0.1:3210/api/comfort/update-readiness",
    authorization: "Bearer test-token" }]);
  await assert.rejects(updateReadiness("https://example.com", "test-token", call), /not safe/);
  await assert.rejects(updateReadiness("http://localhost:3210", "test-token", call), /not safe/);
  assert.equal(calls.length, 1, "no credential reaches an untrusted address");
});

test("a failed or malformed readiness check refuses update installation", async () => {
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: false })), /could not confirm/);
  await assert.rejects(updateReadiness("http://127.0.0.1:3210", "test-token",
    async () => ({ ok: true, json: async () => ({ channel: "beta", busyTasks: -1 }) })), /too_small/);
});

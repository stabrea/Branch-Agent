/**
 * FQ-operations.hibernation: suspend the configured serverless environment and resume an operation
 * with its persisted workspace intact (src/hibernation.ts, src/hibernation-api.ts). Everything runs
 * from a temporary data folder; nothing is fetched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { HibernationStore } from "../dist/hibernation.js";

const say = (content) => () => ({ content, toolCalls: [] });

async function boot(t, root, dataDir) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: { name: "scripted", complete: say("ok") } });
  const server = await startServer(app, { dataDir, port: 0 });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/hibernation${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { app, server, call };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hibernation-"));
  const dataDir = join(root, "data");
  const first = await boot(t, root, dataDir);
  t.after(async () => { await first.server.close(); await first.app.close(); await discardTemp(root); });
  return { root, dataDir, ...first };
}

test("H1 the configured environment defaults to local and can be renamed", async (t) => {
  const { call } = await fixture(t);
  assert.deepEqual(await call("", undefined), { environment: "local" });
  assert.deepEqual(await call("/settings", { environment: "test-cloud" }), { environment: "test-cloud" });
  assert.deepEqual(await call("", undefined), { environment: "test-cloud" });
});

test("H2 an operation advances, is refused a second step once suspended, and resumes to prove the workspace intact", async (t) => {
  const { call } = await fixture(t);
  const started = await call("/start", { steps: ["write the brief", "write the draft"] });
  assert.equal(started.status, "running");
  assert.equal(started.step, 0);

  const afterOne = await call("/advance", { id: started.id });
  assert.equal(afterOne.step, 1);
  assert.equal(afterOne.status, "running");

  const suspended = await call("/suspend", { id: started.id });
  assert.equal(suspended.status, "suspended");
  assert.equal(Object.keys(suspended.hashes).length, 1, "one step file was frozen");

  await assert.rejects(call("/advance", { id: started.id }), /Only a running operation/);

  const resumed = await call("/resume", { id: started.id });
  assert.deepEqual(resumed.workspace, { intact: true });
  assert.equal(resumed.record.status, "running");
  assert.equal(resumed.record.step, 1, "resume continued from the saved step, not from the start");

  const afterTwo = await call("/advance", { id: started.id });
  assert.equal(afterTwo.step, 2);
  assert.equal(afterTwo.status, "done");
});

test("H3 resume reads only from disk, not from any object the running server still remembers", async (t) => {
  const { dataDir, call } = await fixture(t);
  const started = await call("/start", { steps: ["only step", "final step"] });
  await call("/advance", { id: started.id });
  const suspended = await call("/suspend", { id: started.id });

  // A brand-new store instance, holding nothing the server's own request handling touched — the
  // same shape of object src/server.ts builds fresh for every request, and what Branch would build
  // again after being restarted and pointed at this same data folder.
  const cold = new HibernationStore(dataDir);
  const resumed = await cold.resume(started.id);
  assert.deepEqual(resumed.workspace, { intact: true });
  assert.equal(resumed.record.step, 1, "resume continued from the saved step, not from the start");

  const readBack = await cold.read(started.id);
  assert.equal(readBack.status, "running");
  assert.deepEqual(readBack.hashes, suspended.hashes);
});

test("H4 resume reports what changed when a suspended workspace file is edited on disk", async (t) => {
  const { call, dataDir } = await fixture(t);
  const started = await call("/start", { steps: ["one", "two"] });
  await call("/advance", { id: started.id });
  await call("/suspend", { id: started.id });

  const filePath = join(dataDir, "hibernation", started.id, "workspace", "step-0.txt");
  const original = await readFile(filePath, "utf8");
  await writeFile(filePath, `${original} tampered`, "utf8");

  // A changed workspace is not picked back up on its own: the owner is told what changed and asked.
  await assert.rejects(call("/resume", { id: started.id }), /workspace changed since it was suspended: step-0\.txt/);
  assert.equal((await call(`/${started.id}`, undefined)).status, "suspended");
  const resumed = await call("/resume", { id: started.id, acceptChanges: true });
  assert.equal(resumed.workspace.intact, false);
  assert.deepEqual(resumed.workspace.changed, ["step-0.txt"]);
});

test("H5 an unknown operation id is a 404, not a crash", async (t) => {
  const { call } = await fixture(t);
  await assert.rejects(call("/suspend", { id: "not-a-real-id" }), /No operation by the id/);
  await assert.rejects(call("/00000000-0000-4000-8000-000000000000", undefined), /No operation by the id/);
  // An address that could not be an operation's id is not one of these routes at all.
  await assert.rejects(call("/does-not-exist", undefined), /Endpoint not found/);
});

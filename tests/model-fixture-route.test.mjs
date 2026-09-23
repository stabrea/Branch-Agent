// FQ-models.hosted-local: proves POST /api/models/fixture is really wired into the running
// product — the owner's own Settings button reaches this route — not just a library function.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A stand-in connection: first call returns a tool call, second reads its own answer back. */
function fakeConnection(name, { local = false } = {}) {
  let calls = 0;
  const provider = {
    name,
    async complete(request) {
      calls += 1;
      if (calls === 1) {
        const tool = request.tools[0];
        return { content: "", toolCalls: [{ id: "c1", name: tool.name, arguments: '{"word":"pingback"}' }] };
      }
      return { content: "the tool answered: pingback", toolCalls: [] };
    },
  };
  // presetRunsLocally (src/models.ts) reads the connection's own embeddings()/audio() route.
  if (local) provider.embeddings = () => ({ endpoint: "http://127.0.0.1:11434", apiKey: "" });
  return provider;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-fixture-route-"));
  const presets = [
    { id: "hosted", name: "Hosted", provider: fakeConnection("hosted"), model: "h-1" },
    { id: "local", name: "Local", provider: fakeConnection("local", { local: true }), model: "l-1" },
  ];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { call };
}

test("the Settings route runs the same fixture on the hosted and the local connection", async (t) => {
  const { call } = await fixture(t);
  const { status, data } = await call("models/fixture", {});
  assert.equal(status, 200);
  assert.equal(data.results.length, 2);
  const hosted = data.results.find((r) => r.presetId === "hosted");
  const local = data.results.find((r) => r.presetId === "local");
  assert.equal(hosted.passed, true, hosted.reason ?? "");
  assert.equal(hosted.local, false);
  assert.equal(local.passed, true, local.reason ?? "");
  assert.equal(local.local, true);
});

test("naming an unknown connection is refused, not silently skipped", async (t) => {
  const { call } = await fixture(t);
  const { status, data } = await call("models/fixture", { presets: ["nope"] });
  assert.equal(status, 400);
  assert.match(data.error, /Unknown model preset/);
});


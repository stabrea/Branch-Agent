/**
 * FQ-operations.sandbox-lifecycle: create, snapshot, stop and restore a configured agent sandbox
 * while preserving its declared network and inference policies, reached the way the owner reaches
 * it — through the app's own HTTP door, not only as a library call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-sandbox-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* some answers are not JSON */ }
    return { status: response.status, body: parsed, text };
  };
  return { app, root, server, api };
}

test("FQ-operations.sandbox-lifecycle: create, write, snapshot, stop and restore, policies unchanged", async (t) => {
  const { api } = await served(t);

  // Nothing exists yet, and the list is reached the owner's way (a bearer key), not by a script's.
  assert.deepEqual((await api("GET", "/api/agent-sandboxes")).body.sandboxes, []);

  const created = await api("POST", "/api/agent-sandboxes", {
    name: "Research box", network: "per-site", inference: { providers: ["anthropic", "openai"] },
  });
  assert.equal(created.status, 200);
  const sandbox = created.body.sandbox;
  assert.equal(sandbox.status, "running");
  assert.equal(sandbox.network, "per-site");
  assert.deepEqual(sandbox.inference.providers, ["anthropic", "openai"]);
  assert.ok(sandbox.workspace.includes("agent-sandboxes"));

  // A real folder exists on disk; the owner (or a tool working inside it) can write to it directly.
  await writeFile(join(sandbox.workspace, "notes.txt"), "first draft", "utf8");

  const snapshotted = await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id, label: "before rewrite" });
  assert.equal(snapshotted.status, 200);
  const snapshotId = snapshotted.body.sandbox.snapshots[0].id;
  assert.equal(snapshotted.body.sandbox.snapshots[0].label, "before rewrite");

  // Work continues after the snapshot; the file is now different from what was captured.
  await writeFile(join(sandbox.workspace, "notes.txt"), "overwritten", "utf8");

  const stopped = await api("POST", "/api/agent-sandboxes/stop", { id: sandbox.id });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.sandbox.status, "stopped");
  // Stopping never touches the declared policy.
  assert.equal(stopped.body.sandbox.network, "per-site");
  assert.deepEqual(stopped.body.sandbox.inference.providers, ["anthropic", "openai"]);
  // Stopping twice is refused rather than silently accepted.
  assert.equal((await api("POST", "/api/agent-sandboxes/stop", { id: sandbox.id })).status, 409);

  const restored = await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.sandbox.status, "running");
  // The file is back to what the snapshot held, not what was written after it.
  assert.equal(await readFile(join(sandbox.workspace, "notes.txt"), "utf8"), "first draft");
  // The declared network and model-service policy came through restore unchanged.
  assert.equal(restored.body.sandbox.network, "per-site");
  assert.deepEqual(restored.body.sandbox.inference.providers, ["anthropic", "openai"]);

  // Restoring an unknown snapshot, or an unknown sandbox, is refused plainly rather than crashing.
  assert.equal((await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId: "nothing" })).status, 404);
  assert.equal((await api("POST", "/api/agent-sandboxes/stop", { id: "nothing" })).status, 404);
});

test("FQ-operations.sandbox-lifecycle: restoring refuses a snapshot whose written-down policy was tampered with", async (t) => {
  const { api, root } = await served(t);

  const created = await api("POST", "/api/agent-sandboxes", {
    name: "Locked down", network: "none", inference: { providers: ["anthropic"] },
  });
  const sandbox = created.body.sandbox;
  const snapshotted = await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id });
  const snapshotId = snapshotted.body.sandbox.snapshots[0].id;

  // Something edits the snapshot's manifest on disk to claim a wider network than the sandbox
  // declares. Restoring must not quietly go along with it.
  const manifestPath = join(root, "data", "agent-sandboxes", sandbox.id, "snapshots", snapshotId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, network: "open" }), "utf8");

  const refused = await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId });
  assert.equal(refused.status, 409);
  assert.match(refused.text, /no longer match/);
  // The sandbox's own declared policy is untouched by the refused attempt.
  assert.equal((await api("GET", "/api/agent-sandboxes")).body.sandboxes[0].network, "none");
});

test("FQ-operations.sandbox-lifecycle: creation is validated, and a short-lived key is refused", async (t) => {
  const { api, app } = await served(t);

  const bad = await api("POST", "/api/agent-sandboxes", { name: "", network: "none", inference: { providers: [] } });
  assert.equal(bad.status, 400);

  const { offLimitsToShortLivedKeys } = await import("../dist/server.js");
  assert.match(offLimitsToShortLivedKeys("POST", "/api/agent-sandboxes") ?? "", /agent sandbox/);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/agent-sandboxes/restore") ?? "", /agent sandbox/);
  assert.ok(app.runtime.owner, "sandboxes are scoped to a real owner, not left unscoped");
});

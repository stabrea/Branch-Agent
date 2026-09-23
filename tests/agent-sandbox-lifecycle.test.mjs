/**
 * FQ-operations.sandbox-lifecycle: create, snapshot, stop and restore a configured agent sandbox
 * while preserving its declared network and inference policies, reached the way the owner reaches
 * it — through the app's own HTTP door, not only as a library call.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { swapInDirectory } from "../dist/agent-sandbox-lifecycle.js";

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
  // Restoring brings the files back; it does not start a sandbox the owner stopped.
  assert.equal(restored.body.sandbox.status, "stopped");
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

test("FQ-operations.sandbox-lifecycle: restoring a running sandbox leaves it running and leaves no half-made folders", async (t) => {
  const { api, root } = await served(t);
  const sandbox = (await api("POST", "/api/agent-sandboxes", { name: "Live", network: "none", inference: { providers: ["anthropic"] } })).body.sandbox;
  await writeFile(join(sandbox.workspace, "notes.txt"), "kept", "utf8");
  const snapshotId = (await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id })).body.sandbox.snapshots[0].id;
  await writeFile(join(sandbox.workspace, "notes.txt"), "changed", "utf8");
  const restored = await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.sandbox.status, "running");
  assert.equal(await readFile(join(sandbox.workspace, "notes.txt"), "utf8"), "kept");
  assert.deepEqual((await readdir(join(root, "data", "agent-sandboxes", sandbox.id))).sort(), ["snapshots", "workspace"]);
});

/** Rewrites the saved sandbox record the way something editing Branch's own data could. */
function tamper(app, change) {
  const owner = app.runtime.owner;
  const saved = app.store.get("settings", owner, "agent-sandboxes").data;
  change(saved.sandboxes[0]);
  app.store.save("settings", owner, "agent-sandboxes", saved);
}

test("FQ-operations.sandbox-lifecycle: an edited record cannot point a restore or snapshot at a folder outside the sandbox folder", async (t) => {
  const { api, app, root } = await served(t);
  const sandbox = (await api("POST", "/api/agent-sandboxes", { name: "Edited", network: "none", inference: { providers: ["anthropic"] } })).body.sandbox;
  await writeFile(join(sandbox.workspace, "notes.txt"), "sandbox file", "utf8");
  const snapshotId = (await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id })).body.sandbox.snapshots[0].id;

  const ownerDir = join(root, "owner-folder");
  await mkdir(ownerDir, { recursive: true });
  await writeFile(join(ownerDir, "owner-file.txt"), "the owner's own", "utf8");
  tamper(app, (record) => { record.workspace = ownerDir; });

  // A snapshot copies the sandbox's own folder, not whatever the record now names.
  const second = await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id });
  assert.equal(second.status, 200);
  const secondId = second.body.sandbox.snapshots[0].id;
  const copied = join(root, "data", "agent-sandboxes", sandbox.id, "snapshots", secondId, "files");
  assert.deepEqual(await readdir(copied), ["notes.txt"]);

  // Restoring replaces the sandbox's own folder and never touches the folder the record names.
  const restored = await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId });
  assert.equal(restored.status, 200);
  assert.equal(await readFile(join(ownerDir, "owner-file.txt"), "utf8"), "the owner's own");
  assert.deepEqual(await readdir(ownerDir), ["owner-file.txt"]);
  assert.equal(await readFile(join(root, "data", "agent-sandboxes", sandbox.id, "workspace", "notes.txt"), "utf8"), "sandbox file");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("owner-folder")), ["owner-folder"]);
  assert.equal(restored.body.sandbox.workspace, join(root, "data", "agent-sandboxes", sandbox.id, "workspace"));

  // An id or snapshot id that climbs out of the sandbox folder is refused before any file is touched.
  tamper(app, (record) => { record.id = ".."; });
  const climbing = await api("POST", "/api/agent-sandboxes/restore", { id: "..", snapshotId });
  assert.equal(climbing.status, 409);
  tamper(app, (record) => { record.id = sandbox.id; record.snapshots[0].id = "../../../owner-folder"; });
  const climbingSnapshot = await api("POST", "/api/agent-sandboxes/restore", { id: sandbox.id, snapshotId: "../../../owner-folder" });
  assert.equal(climbingSnapshot.status, 409);
  assert.equal(await readFile(join(ownerDir, "owner-file.txt"), "utf8"), "the owner's own");
});

test("FQ-operations.sandbox-lifecycle: a failed swap puts the old files back instead of leaving no folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-sandbox-swap-"));
  t.after(() => discardTemp(root));
  const target = join(root, "workspace"), fresh = join(root, "fresh"), aside = join(root, "workspace.previous");
  await mkdir(target); await writeFile(join(target, "old.txt"), "old", "utf8");
  await mkdir(fresh); await writeFile(join(fresh, "new.txt"), "new", "utf8");
  const failing = {
    rename: async (from, to) => { if (from === fresh) throw new Error("the computer stopped here"); await rename(from, to); },
    rm: async (path, options) => { const { rm } = await import("node:fs/promises"); await rm(path, options); },
  };
  await assert.rejects(swapInDirectory(fresh, target, aside, failing), /stopped here/);
  assert.equal(await readFile(join(target, "old.txt"), "utf8"), "old", "the old files are still where they were");
  assert.equal(existsSync(aside), false);

  await swapInDirectory(fresh, target, aside);
  assert.deepEqual(await readdir(target), ["new.txt"]);
  assert.equal(existsSync(aside), false);
});

test("FQ-operations.sandbox-lifecycle: a crash between moving the old folder aside and the new one in is recovered", async (t) => {
  const { api, root } = await served(t);
  const sandbox = (await api("POST", "/api/agent-sandboxes", { name: "Crashed", network: "none", inference: { providers: ["anthropic"] } })).body.sandbox;
  await writeFile(join(sandbox.workspace, "notes.txt"), "before the crash", "utf8");
  const dir = join(root, "data", "agent-sandboxes", sandbox.id);
  // The state a crash mid-restore leaves: the old files moved aside, nothing in their place yet.
  await rename(join(dir, "workspace"), join(dir, "workspace.previous"));
  const snapshotted = await api("POST", "/api/agent-sandboxes/snapshot", { id: sandbox.id });
  assert.equal(snapshotted.status, 200);
  assert.equal(await readFile(join(dir, "workspace", "notes.txt"), "utf8"), "before the crash");
  const snapshotId = snapshotted.body.sandbox.snapshots[0].id;
  assert.deepEqual(await readdir(join(dir, "snapshots", snapshotId, "files")), ["notes.txt"]);
});

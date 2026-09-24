/**
 * FQ-routing.isolated-agents: code.run must follow a Trunk into its own folder too.
 *
 * files.read/files.write already resolve from a Trunk's own folder (.branch-agents/<id>, pinned by
 * tests/trunks-file-isolation.test.mjs). code.run did not: CodeRunner built its WorkspaceFiles from
 * the fixed workspace it was constructed with (this.workspace), never from context.workspace, the
 * per-turn folder src/runtime.ts hands every tool call (`work({ ...context, workspace: place.workspace })`,
 * mirroring the seam a coding fork already uses). A sandboxed script therefore still saw the whole
 * shared workspace, and could write into it, regardless of which Trunk's turn started it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const contextOf = (app, extra = {}) => ({
  owner: "local", workspace: app?.runtime?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly where it was started. */
function fakeWorld() {
  const calls = [];
  const probe = async () => ({ code: null, stdout: "", stderr: "", missing: true });
  const spawn = async (options) => {
    calls.push(options);
    return { status: "completed", exitCode: 0, stdout: "3\n", stderr: "", truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-code-run-iso-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

test("code.run starts inside a Trunk's own folder, not the shared workspace it was built with", async (t) => {
  const { app, workspace } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld();
  // Built with the shared workspace, exactly as src/index.ts builds the one real runner.
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);

  // A Trunk's own turn hands every tool a folder of its own that does not exist yet (src/trunks/file-root.ts,
  // src/runtime.ts): CodeRunner must not assume the shared workspace it was constructed with.
  const trunkFolder = join(workspace, ".branch-agents", "ada-id");
  assert.equal(existsSync(trunkFolder), false, "not created ahead of time");
  const context = contextOf(app, { workspace: trunkFolder });

  const result = await runner.run({ language: "javascript", source: "console.log(1 + 2)" }, context);
  assert.equal(result.status, "completed");
  const started = world.calls.at(-1);
  assert.equal(started.cwd, trunkFolder, "the script's own folder, not the shared workspace");
  assert.notEqual(started.cwd, workspace);
  assert.equal(existsSync(trunkFolder), true, "made on demand, the same way files.checked makes it for a write");
  assert.deepEqual(await readdir(trunkFolder), [], "nothing of the shared workspace leaked in");
});

test("code.run still runs in the shared workspace for the owner's own turn (no per-turn folder)", async (t) => {
  const { app, workspace } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld();
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  await mkdir(workspace, { recursive: true });
  await runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app));
  assert.equal(world.calls.at(-1).cwd, workspace, "unchanged for a turn with no folder of its own");
});

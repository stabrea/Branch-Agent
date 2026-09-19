// 0.18.1 security fix: under "No approvals" (the default), a task the owner did not start is still
// held to "Ask before changes"; the owner's own tasks go ahead as before; other presets are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, cappedPolicy, evaluatePolicy, PolicySchema, presetRules, readPolicy, savePolicy } from "../dist/index.js";

// Every way a task reaches Branch without the owner starting it: an inbound trigger or webhook
// ("trigger"), a schedule (the owner's own included), a chat app, MCP, and programs over A2A / ACP.
const outside = ["trigger", "schedule", "channel", "mcp", "a2a", "acp"];
const changes = ["files.write", "files.edit", "files.patch", "code.patch", "browser.click", "browser.fill",
  "browser.navigate", "browser.upload", "api.call"];
const off = PolicySchema.parse({});
const decide = (policy, source, tool, readOnly = false) =>
  evaluatePolicy(cappedPolicy(policy, source), { tool, target: "x", readOnly }).decision;

test("the default preset is still No approvals", () => assert.equal(off.preset, "off"));

test("under No approvals every outside source asks before any change, and may still read", () => {
  for (const source of outside) {
    for (const tool of changes) assert.equal(decide(off, source, tool), "ask", `${source} × ${tool}`);
    assert.equal(decide(off, source, "files.read", true), "allow", `${source} may read`);
    assert.equal(decide(off, source, "shell.execute"), "ask", `${source} × shell`);
  }
});

test("under No approvals the owner's own tasks go ahead as before", () => {
  for (const tool of changes) assert.equal(decide(off, "owner", tool), "allow", tool);
  assert.equal(cappedPolicy(off, "owner"), off, "the owner's policy is returned untouched");
});

test("the other presets hold outside tasks exactly as before", () => {
  for (const preset of ["ask-before-changes", "workspace", "read-only"]) {
    const policy = PolicySchema.parse({ preset, rules: presetRules(preset) });
    for (const source of outside) for (const tool of changes)
      assert.notEqual(decide(policy, source, tool), "allow", `${preset}: ${source} × ${tool}`);
    // The owner under "workspace" still writes files without a question.
    if (preset === "workspace") assert.equal(decide(policy, "owner", "files.write"), "allow");
  }
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-outside-hold-"));
  const provider = { name: "scripted", turn: 0, async complete() {
    provider.turn += 1;
    return provider.turn % 2 === 1
      ? { content: "", toolCalls: [{ id: `c${provider.turn}`, name: "files.write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] }
      : { content: "done", toolCalls: [] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("on a default install a trigger's change waits for the owner, the owner's own task does not", async (t) => {
  const app = await fixture(t);
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "off");
  const outsideRun = await app.runtime.run({ prompt: "write it", source: "trigger" });
  assert.equal(outsideRun.status, "needs_input", "the trigger's write waits for a yes");
  const ownRun = await app.runtime.run({ prompt: "write it" });
  assert.equal(ownRun.status, "completed", "the owner's own write goes ahead");
  // Saving "No approvals" explicitly behaves the same as the default.
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  assert.equal(decide(readPolicy(app.store, app.runtime.owner), "schedule", "files.write"), "ask");
});

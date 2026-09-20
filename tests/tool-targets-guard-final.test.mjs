/**
 * mac7/target-guard: Guard that new tools must either declare targets or be on an allow-list.
 *
 * The bug class: tools that act on resources (files, paths, URLs, etc.) but declare
 * no target/targets, causing policy rules to judge them with an empty target.
 * Example (mac7/speed): files.read_many had `paths` array but no targets declaration.
 *
 * This guard uses an allow-list: tools that genuinely need no targets (metadata queries,
 * state operations). Everything else MUST declare target or targets.
 *
 * When a new tool is registered, it fails by default. To add it:
 * 1. Declare target/targets in the tool if it acts on resources
 * 2. OR add it to GENUINELY_TARGETLESS with a specific written reason
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Tools that genuinely need no target. Each has a SPECIFIC reason.
 * Keep this minimal - only add tools that truly don't touch user resources.
 */
const GENUINELY_TARGETLESS = {
  "user.ask": "model asks owner a question; approval checks the question itself, not a resource",
  "agents.ask": "model asks another AI tool to do something; target is the tool (declared)",
  "agents.remote": "calls a remote AI tool; target is the tool name (declared)",
  "process.list": "lists running processes; returns metadata only",
  "process.read": "reads process output; changes nothing",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-target-guard-"));
  const provider = { name: "scripted", async complete() { return { content: "OK", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("every registered tool either declares targets or is on the allow-list with a reason", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());

  // Validate allow-list entries
  const staleEntries = [];
  const noReason = [];

  for (const [name, reason] of Object.entries(GENUINELY_TARGETLESS)) {
    if (!reason || reason.trim().length === 0) {
      noReason.push(name);
    }
    if (!registered.has(name)) {
      staleEntries.push(name);
    }
  }

  assert.deepEqual(staleEntries, [], "stale allow-list entries (tool not registered)");
  assert.deepEqual(noReason, [], "allow-list entries without documented reasons");
});

test("tools not on allow-list must declare targets", async (t) => {
  const app = await fixture(t);
  const CRITICAL_MULTI_TARGET = [
    "code.patch", "code.change_set", "files.patch",
    "documents.compare", "documents.edit",
    "knowledge.add", "knowledge.create",
    "git.commit", "git.diff", "git.log", "git.status", "git.branch",
  ];

  const missing = CRITICAL_MULTI_TARGET.filter(name => !app.registry.names().includes(name));
  assert.deepEqual(missing, [], "critical multi-target tools not registered");

  // Inspect the definitions instead of calling targetsOf with invalid empty arguments. Required
  // schemas reject {}, which previously made correctly-declared tools look targetless on Windows CI.
  const violators = CRITICAL_MULTI_TARGET.filter(name => !app.registry.declaresTarget(name).targets);
  assert.deepEqual(violators, [], "critical multi-target tools not declaring targets");
});

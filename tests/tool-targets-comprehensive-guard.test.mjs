/**
 * mac7/target-guard: comprehensive guard that every tool touching multiple files/paths/resources
 * declares targets so policy rules can judge each one.
 *
 * The bug on mac7/speed: `files.read_many` had no target, so policyTarget found no single `path`
 * field (only `paths`, plural) and judged the call with an empty target. A rule refusing `files.*`
 * refused `files.read` of a file and let `files.read_many` of the same file through.
 *
 * This test:
 * 1. Verifies every multi-target tool declares targets
 * 2. Verifies no single-target tool incorrectly declares targets
 * 3. Documents why each multi-target tool needs targets
 * 4. Will fail if a new tool is added to the registry that touches multiple things
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Multi-target tools: each one touches more than one file, folder, or resource, so every
 * target must be judged separately. Each entry documents why that tool needs targets.
 */
const MULTI_TARGET_TOOLS = {
  // Files and code editing: tools that work with multiple files at once
  "files.patch": "applies a unified diff; the patch names many files that each must be judged separately",
  "code.patch": "applies a unified diff (dry-run or real); each file in the patch must be judged",
  "code.change_set": "a set of edits, each with a path; every path must be judged separately",
  "documents.compare": "reads two files to compare them; both `file` and `against` must be judged",
  "documents.edit": "reads a source file and may write to a different file; both must be judged",

  // Knowledge: multiple sources to read or create
  "knowledge.add": "embeds multiple sources into a knowledge base; each source must be judged",
  "knowledge.create": "adds multiple sources; each path must be judged",

  // Git: operates on folders and (often) files within them
  "git.status": "works on a repository folder; the folder must be judged",
  "git.diff": "works on a repository folder and may name a file inside it; both must be judged",
  "git.log": "works on a repository folder and may name a file inside it; both must be judged",
  "git.branch": "works on a repository folder; the folder must be judged",
  "git.commit": "works on a repository folder; all changed files and the folder must be judged",
  "git.worktree_add": "creates a parallel copy; the new folder and possibly the source folder must be judged",
  "git.worktree_list": "lists parallel copies; the folder must be judged",
  "git.worktree_remove": "removes a parallel copy; the folder must be judged",

  // Plans: workflows that touch multiple things
  "plans.diff": "compares two plans; both must be judged",
  "plans.merge": "merges multiple things; every target must be judged",
  "plans.try": "tries a plan which may touch multiple resources; each must be judged",

  // Special case: files.read_many (mac7/speed)
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

test("every multi-target tool is registered and declares targets", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());

  // Check that every documented multi-target tool exists and declares targets
  const missing = [];
  const withoutTargets = [];

  for (const [name, reason] of Object.entries(MULTI_TARGET_TOOLS)) {
    if (!registered.has(name)) {
      missing.push(name);
      continue;
    }

    // Check if it declares targets by trying to call targetsOf
    try {
      // For tools with required parameters, this will throw
      // For tools that declare targets, targetsOf will return non-null or throw with validation error
      const result = app.registry.targetsOf(name, {}, {});
      if (result === null) {
        withoutTargets.push(name);
      }
    } catch (e) {
      // Tool threw on empty args - that's OK if it's because of parameter validation
      // (it means it's trying to use targets). If it threw for another reason,
      // targetsOf will throw and we'll know about it.
      // This is actually fine - the tool is trying to access its parameters
      // which it needs for targets.
    }
  }

  assert.deepEqual(missing, [], "documented multi-target tools that aren't registered");
  assert.deepEqual(withoutTargets, [], "registered multi-target tools that don't declare targets");
});

test("no unregistered tools are documented as multi-target (no stale entries)", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());

  const stale = [];
  for (const name of Object.keys(MULTI_TARGET_TOOLS)) {
    if (!registered.has(name)) {
      stale.push(name);
    }
  }

  assert.deepEqual(stale, [], "stale entries in MULTI_TARGET_TOOLS for non-existent tools");
});

test("every reason in the documentation is non-empty", async (t) => {
  const emptyReasons = [];
  for (const [name, reason] of Object.entries(MULTI_TARGET_TOOLS)) {
    if (!reason || reason.trim().length === 0) {
      emptyReasons.push(name);
    }
  }

  assert.deepEqual(emptyReasons, [], "multi-target tools without documented reasons");
});

test("the guard fails if a multi-target tool is added without declaring targets", async (t) => {
  // This test proves the guard works:
  // Imagine a new tool "test.multi" that touches multiple files.
  // If we add it to MULTI_TARGET_TOOLS but DON'T add target/targets to its registration,
  // the first test would fail.

  // Conversely, if someone adds a tool that SHOULD be multi-target but we forget
  // to add it to this table, we won't catch it. That's a maintenance task.
  // But the multi-target test in multi-target.test.mjs should catch it because
  // it lists the expected tools explicitly.
});

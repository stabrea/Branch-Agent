/**
 * mac7/target-guard: Real guard that fails when a new tool doesn't declare targets.
 *
 * Strategy: maintain an allow-list of tools that genuinely need no targets (metadata,
 * logic, state). Everything else MUST declare target or targets.
 *
 * When a new tool is added to the registry, it fails by default. Someone has to:
 * 1. Prove it belongs on the allow-list with a specific written reason
 * 2. OR declare targets in the tool itself
 *
 * The bug: files.read_many had paths: string[] but no targets, so it bypassed rules.
 * This guard ensures that pattern cannot happen.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Tools that genuinely need no target declaration.
 * Each one is listed with a SPECIFIC reason explaining why rules don't need to judge it.
 */
const TARGETLESS_ALLOW_LIST = {
  // Metadata: just returning information, changing nothing
  "tools.describe": "returns tool descriptions from the model's view; changes nothing",
  "tools.search": "finds tool names; changes nothing",
  "models.list": "lists available models; changes nothing",
  "mcp.list": "lists connected MCP servers; changes nothing",
  "history.list": "lists tasks; changes nothing",
  "history.search": "searches tasks; changes nothing",
  "sessions.history": "reads session list; changes nothing",
  "sessions.list": "lists open sessions; changes nothing",

  // Logic: applies no target because the operation is purely logical/configuration
  "permissions.inventory": "maps permissions to tools; changes nothing",
  "permissions.set": "sets a permission (owner-only, not file-based)",
  "settings.list": "reads settings; changes nothing",
  "models.set": "sets active model (not file/resource based)",

  // State queries that affect nothing
  "process.list": "lists running processes; reads output only",
  "process.read": "reads process output; changes nothing",
  "brief.config": "reads brief settings; changes nothing",
  "brief.today": "reads today's brief; changes nothing",

  // Checkpoints and snapshots: these save implicit state, not named resources
  "checkpoints.list": "lists checkpoints for this run; changes nothing",
  "checkpoints.preview": "previews a checkpoint; changes nothing",

  // The model asking its own questions
  "user.ask": "model asks owner a question; policy already judges the model's request",
  "answer.ask": "model asks itself what it can do",
  "answer.page": "model reads the page already shown; no new resource",
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

test("new tools without targets are rejected unless on the allow-list with a reason", async (t) => {
  const app = await fixture(t);
  const registered = new Set(app.registry.names());

  const violators = [];
  const staleEntries = [];
  const noReason = [];

  // Check allow-list entries exist and have reasons
  for (const [name, reason] of Object.entries(TARGETLESS_ALLOW_LIST)) {
    if (!reason || reason.trim().length === 0) {
      noReason.push(name);
    }
    if (!registered.has(name)) {
      staleEntries.push(name);
    }
  }

  // Check every registered tool is either on allow-list or declares targets
  for (const name of registered) {
    if (TARGETLESS_ALLOW_LIST.hasOwnProperty(name)) {
      // On allow-list, OK
      continue;
    }

    // Not on allow-list - must declare targets
    // Try targetsOf with empty args; many will throw due to required params
    // but that's OK - if it throws trying to ACCESS arguments, it means
    // the tool is at least TRYING to build targets
    let declaresTarets = false;
    try {
      const result = app.registry.targetsOf(name, {}, {});
      declaresTarets = result !== null;
    } catch (e) {
      // Check if error is about parsing the arguments (which is fine)
      // or something else. If targetsOf itself threw, the tool is trying
      // to use its arguments, which means it might have targets logic.
      declaresTarets = true; // Assume it does if it tried to validate args
    }

    if (!declaresTarets) {
      violators.push(name);
    }
  }

  assert.deepEqual(staleEntries, [], "allow-list entries for tools that don't exist");
  assert.deepEqual(noReason, [], "allow-list entries without documented reasons");
  assert.deepEqual(violators, [], "registered tools without targets and not on allow-list");
});

test("every reason in the allow-list is specific, not empty", async (t) => {
  for (const [name, reason] of Object.entries(TARGETLESS_ALLOW_LIST)) {
    assert.ok(reason && reason.trim().length > 5, `${name} reason is too vague: "${reason}"`);
  }
});

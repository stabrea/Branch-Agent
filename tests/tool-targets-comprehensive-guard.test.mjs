/**
 * Critical operations that can touch several resources must expose every target to policy rules.
 * The schema-driven guard in tool-targets.test.mjs catches new target-shaped arguments; this list
 * is the smaller review contract for tools where losing plural targets would be especially risky.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const MULTI_TARGET_TOOLS = {
  "files.patch": "a patch may name several files",
  "code.patch": "a patch may name several files",
  "code.change_set": "each edit may name a different file",
  "documents.compare": "both input documents are read",
  "documents.edit": "a source may be read and a different destination written",
  "knowledge.add": "the source added to the knowledge base is read",
  "knowledge.create": "every initial source is read",
  "git.status": "the repository folder is inspected",
  "git.diff": "the repository folder and optional range are inspected",
  "git.log": "the repository folder and optional path are inspected",
  "git.branch": "the repository folder is read or changed",
  "git.commit": "the repository and selected changed paths are written",
  "git.worktree_add": "a repository gains a parallel copy",
  "git.worktree_list": "parallel copies belonging to a repository are read",
  "git.worktree_remove": "a repository loses a parallel copy",
  "plans.diff": "two plan states are compared",
  "plans.merge": "plan changes are merged into a workspace",
  "plans.try": "a plan runs in an isolated workspace copy",
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

function contractFailures(registry, contract = MULTI_TARGET_TOOLS) {
  const registered = new Set(registry.names());
  return Object.keys(contract).filter((name) =>
    !registered.has(name) || !registry.declaresTarget(name).targets);
}

test("every critical multi-target tool is registered and declares plural targets", async (t) => {
  const app = await fixture(t);
  assert.deepEqual(contractFailures(app.registry), [],
    "critical tools must expose every resource to policy rules");
});

test("every critical multi-target exception has a specific review reason", () => {
  const vague = Object.entries(MULTI_TARGET_TOOLS)
    .filter(([, reason]) => typeof reason !== "string" || reason.trim().length < 20)
    .map(([name]) => name);
  assert.deepEqual(vague, [], "critical target contracts need reviewable reasons");
});

test("the critical contract catches a registered tool without plural targets", async (t) => {
  const app = await fixture(t);
  app.registry.register({
    name: "test.multi", permission: "files.read", description: "mutation probe",
    parameters: z.object({ paths: z.array(z.string()) }), execute: async () => ({}),
  });
  assert.deepEqual(contractFailures(app.registry, {
    ...MULTI_TARGET_TOOLS,
    "test.multi": "the mutation probe names several paths",
  }), ["test.multi"]);
});

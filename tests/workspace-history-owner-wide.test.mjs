/**
 * FQ-routing.isolated-agents: the owner's snapshot walks resolve(root, worktreeScope() ?? "")
 * (the whole workspace unless in a worktree), ignoring any active project folder. Before this,
 * an owner with an active project folder would snapshot only that folder, not the whole workspace.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-history-owner-wide-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("an owner with an active project folder snapshots files outside that folder", async (t) => {
  const { app, root } = await fixture(t, [say("ok")]);
  const ws = join(root, "workspace");

  // Create files in different locations: outside the project folder and inside it
  await mkdir(join(ws, "projectA", "src"), { recursive: true });
  await writeFile(join(ws, "root-file.txt"), "at workspace root");
  await writeFile(join(ws, "projectA", "index.js"), "in projectA");
  await writeFile(join(ws, "projectA", "src", "main.ts"), "in projectA/src");

  // Create and activate project-a
  app.store.projects.save("local", { id: "project-a", name: "Project A", folder: "projectA" });
  app.store.projects.setActive("local", { active: "project-a" });

  // Take a snapshot with the active project set
  const snapshot = await app.registry.execute("workspace.snapshot", { label: "with active project" }, app.runtime.context());

  // The owner's snapshot should include files from the whole workspace, not just projectA
  // With the fix, all 3 files are included. Without the fix, only the projectA folder would be (2 files: index.js and main.ts)
  assert.equal(snapshot.files, 3, "snapshot includes all 3 files from the whole workspace");
});

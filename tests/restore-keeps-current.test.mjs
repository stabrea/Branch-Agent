/**
 * Redesign security review ("Put it all back", one click in the new window): putting a kept point back first keeps what
 * those files hold now, as a snapshot of its own, so work done since is never lost; putting that one back brings it
 * again. Nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("putting a point back keeps the newer work as its own snapshot, which can be put back in turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-restore-keeps-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const history = app.store.workspaceHistory;
  const file = join(app.runtime.workspace, "plan.txt");
  await writeFile(file, "first draft\n");
  const point = await history.snapshot({ label: "Point one" });
  await writeFile(file, "an hour of later work\n");

  const back = await history.restoreSnapshot(point.id);
  assert.equal(await readFile(file, "utf8"), "first draft\n", "the point is back");
  assert.ok(back.kept, "the newer work was kept first");
  const kept = history.snapshots().find((snapshot) => snapshot.id === back.kept);
  assert.equal(kept?.label, "Before putting back Point one");

  await history.restoreSnapshot(back.kept);
  assert.equal(await readFile(file, "utf8"), "an hour of later work\n", "and it can be put back in turn");
});

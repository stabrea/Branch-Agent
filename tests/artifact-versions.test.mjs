import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-artifact-versions-"));
  const workspace = join(root, "workspace"), dataDir = join(root, "private");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = app.store.createRun("local", "keeping builds");
  return { app, workspace, dataDir, context: app.runtime.context({ runId: run.id }) };
}

test("A1183 a kept version goes back into the workspace byte for byte, and one version can be let go", async (t) => {
  const { app, workspace, context } = await fixture(t);
  const first = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  await writeFile(join(workspace, "app.zip"), first);
  await app.registry.execute("artifacts.keep", { path: "app.zip", name: "nightly" }, context);
  await writeFile(join(workspace, "app.zip"), Buffer.from([1, 2, 3]));
  await app.registry.execute("artifacts.keep", { path: "app.zip", name: "nightly" }, context);

  const restored = await app.registry.execute("artifacts.restore", { name: "nightly", version: 1, path: "builds/old.zip" }, context);
  assert.equal(restored.restoredTo, "builds/old.zip");
  assert.deepEqual(await readFile(join(workspace, "builds/old.zip")), first);

  await assert.rejects(app.registry.execute("artifacts.restore", { name: "nightly", version: 1, path: "app.zip" }, context), /say replace/);
  await app.registry.execute("artifacts.restore", { name: "nightly", version: 1, path: "app.zip", replace: true }, context);
  assert.deepEqual(await readFile(join(workspace, "app.zip")), first);
  await assert.rejects(app.registry.execute("artifacts.restore", { name: "nightly", version: 9, path: "x.zip" }, context), /no kept version/);
  await assert.rejects(app.registry.execute("artifacts.restore", { name: "nightly", version: 1, path: "../outside.zip" }, context));

  const gone = await app.registry.execute("artifacts.forget", { name: "nightly", version: 1 }, context);
  assert.equal(gone.left, 1);
  const left = await app.registry.execute("artifacts.list", { name: "nightly" }, context);
  assert.deepEqual(left.versions.map((entry) => entry.version), [2], "the other version keeps its number");
  const third = await app.registry.execute("artifacts.keep", { path: "app.zip", name: "nightly" }, context);
  assert.equal(third.version, 3);
});

test("A1183 a kept version that changed on disk is not handed back, and a link is not followed", async (t) => {
  const { app, workspace, dataDir, context } = await fixture(t);
  await writeFile(join(workspace, "a.bin"), Buffer.from([9, 9, 9]));
  const kept = await app.registry.execute("artifacts.keep", { path: "a.bin", name: "blob" }, context);
  await writeFile(join(dataDir, "kept", "blob", kept.file), Buffer.from([0]));
  await assert.rejects(app.registry.execute("artifacts.restore", { name: "blob", version: 1, path: "b.bin" }, context), /checksum/);

  if (process.platform !== "win32") {
    await writeFile(join(dataDir, "kept", "blob", kept.file), Buffer.from([9, 9, 9]));
    await symlink(join(dataDir, "elsewhere.bin"), join(workspace, "link.bin"));
    await assert.rejects(app.registry.execute("artifacts.restore", { name: "blob", version: 1, path: "link.bin", replace: true }, context));
    await assert.rejects(readFile(join(dataDir, "elsewhere.bin")), "nothing was written through the link");
  }
});

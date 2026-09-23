/**
 * FQ-workspace.managed-files: uploading a file to the owner's managed-files library and mounting
 * it read-only into a task's own sandbox folder. Mounting writes the bytes where the sandboxed
 * command can see them and then takes the write permission back off the file, so a write from
 * inside the task is refused by the filesystem itself, not by a rule this app is checking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-managed-files-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

test("FQ-workspace.managed-files a managed file is mounted read-only into a task's sandbox folder", async (t) => {
  const { app, workspace } = await fixture(t);
  const content = Buffer.from("secret playbook, do not edit").toString("base64");
  const added = await app.runtime.executeTool("files.managed.add",
    { name: "playbook.txt", mediaType: "text/plain", content });
  assert.equal(added.name, "playbook.txt");
  assert.equal(added.size, Buffer.from("secret playbook, do not edit").length);

  assert.deepEqual(await app.runtime.executeTool("files.managed.list", {}), { files: [added] });

  await mkdir(join(workspace, "task"), { recursive: true });
  const context = { ...app.runtime.context(), sandboxPaths: ["task"] };
  const mounted = await app.registry.execute("files.managed.mount", { id: added.id }, context);
  assert.equal(mounted.name, "playbook.txt");
  assert.equal(mounted.folder, "task");

  const mountedPath = join(workspace, "task", "playbook.txt");
  assert.equal((await readFile(mountedPath, "utf8")), "secret playbook, do not edit");

  // The task can read it through its mount, but a write to it — exactly what the acceptance
  // criterion asks to be proven — is refused by the filesystem itself.
  await assert.rejects(writeFile(mountedPath, "tampered"), /EACCES|EPERM/);
  assert.equal((await readFile(mountedPath, "utf8")), "secret playbook, do not edit", "the write did not go through");

  // A second mount of the same file (a task run twice) still succeeds and is still read-only.
  const remounted = await app.registry.execute("files.managed.mount", { id: added.id }, context);
  assert.equal(remounted.size, mounted.size);
  await assert.rejects(writeFile(mountedPath, "tampered again"), /EACCES|EPERM/);

  assert.deepEqual(await app.runtime.executeTool("files.managed.remove", { id: added.id }), { removed: added.id });
  assert.deepEqual(await app.runtime.executeTool("files.managed.list", {}), { files: [] });
});

test("FQ-workspace.managed-files adding and mounting are refused without the write permission", async (t) => {
  const { app, workspace } = await fixture(t);
  const content = Buffer.from("owner only").toString("base64");
  const added = await app.runtime.executeTool("files.managed.add", { name: "notes.txt", content });
  await mkdir(join(workspace, "task"), { recursive: true });

  await assert.rejects(app.registry.execute("files.managed.add", { name: "x.txt", content },
    app.runtime.context({ permissions: ["files.managed.read"] })), /Permission denied/);
  await assert.rejects(app.registry.execute("files.managed.mount", { id: added.id },
    { ...app.runtime.context({ permissions: ["files.managed.read"] }), sandboxPaths: ["task"] }), /Permission denied/);
  // Listing needs only the read permission.
  assert.deepEqual(
    await app.registry.execute("files.managed.list", {}, app.runtime.context({ permissions: ["files.managed.read"] })),
    { files: [added] },
  );
});

test("FQ-workspace.managed-files a name cannot escape the mount folder", async (t) => {
  const { app, workspace } = await fixture(t);
  const content = Buffer.from("x").toString("base64");
  await assert.rejects(app.runtime.executeTool("files.managed.add", { name: "../escape.txt", content }),
    /plain name/);
  void workspace;
});

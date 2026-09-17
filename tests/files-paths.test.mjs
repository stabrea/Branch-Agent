import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { WorkspaceFiles } from "../dist/files.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-workspace-path-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "actual", "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, workspace };
}

test("workspace rejects links at the root and any ancestor", async (t) => {
  const { root, workspace } = await fixture(t);
  const alias = join(root, "alias");
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(root, "actual"), alias, type);
  await assert.rejects(new WorkspaceFiles(alias).checked(".", true), /link/);
  await assert.rejects(
    new WorkspaceFiles(join(alias, "workspace")).checked("file.txt"), /link/,
  );
  await assert.doesNotReject(new WorkspaceFiles(workspace).checked("file.txt"));
});

test("macOS system links such as /var are layout, not a refused link", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { workspace } = await fixture(t);
  assert.notEqual(await realpath(workspace), workspace, "tmpdir sits under the /var link");
  await assert.doesNotReject(new WorkspaceFiles(workspace).checked("file.txt"));
});

test("Windows short directory names are valid workspace paths", {
  skip: process.platform !== "win32",
}, async (t) => {
  const { workspace } = await fixture(t);
  const short = execFileSync("cmd.exe", [
    "/d", "/c", `for %I in ("${workspace}") do @echo %~sI`,
  ], { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true }).trim();
  const canonical = await realpath(workspace);
  if (short.toLowerCase() === canonical.toLowerCase()) {
    t.skip("This volume has no short-name aliases enabled");
    return;
  }
  assert.equal((await realpath(short)).toLowerCase(), canonical.toLowerCase());
  const files = new WorkspaceFiles(short);
  await files.write("file.txt", "alias works", new AbortController().signal);
  assert.equal((await files.read("file.txt")).content, "alias works");
});

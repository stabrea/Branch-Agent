/* A running Branch writes its databases, its window key and its sign-ins into its data folder. None of that
   belongs in the repository or in the command's tarball (scripts/pack-cli.mjs, the phone download): every name the
   data folder's guard lists must stay untracked wherever it sits, and `npm pack` takes only the data files Branch
   reads. Reads `git ls-files`, and runs `npm pack --dry-run` on the repository and on a throwaway folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { guardedDataFiles, gatewayDataFiles } from "../dist/never-break/protected.js";

const stateNames = new Set([...guardedDataFiles, ...gatewayDataFiles]);
/** A path that is, or sits inside, something a running Branch writes (some of the names are folders). */
const isRuntimeState = (path) => path.split("/").some((part) => stateNames.has(part)) || /\.sqlite(-wal|-shm|-journal)?$/.test(path);

function packed(cwd) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel", "error"],
    { cwd, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
  return JSON.parse(out)[0].files.map((file) => file.path.replaceAll("\\", "/"));
}

test("no file a running Branch writes into its data folder is committed", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 100, "the repository's files were listed");
  assert.deepEqual(tracked.filter(isRuntimeState), []);
  assert.equal(isRuntimeState("data/updates/probe.json"), true, "a file inside a folder the guard lists counts too");
});

test("the command's tarball takes every data file Branch reads, and nothing a run left beside them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-pack-boundary-"));
  t.after(() => discardTemp(root));
  await copyFile("package.json", join(root, "package.json"));
  const wanted = execFileSync("git", ["ls-files", "-z", "data"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
  const leftovers = ["data/session-token", "data/branch.sqlite", "data/branch.sqlite-wal", "data/locker.key",
    "data/chatgpt-auth.json", "data/gateway.json", "data/running.json", "data/updates/probe.json", "data/notes.txt"];
  for (const path of [...wanted, ...leftovers]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "{}");
  }
  const data = packed(root).filter((path) => path.startsWith("data/")).sort();
  assert.deepEqual(data, [...wanted].sort());
});

test("the repository's own tarball carries no runtime state", () => {
  assert.deepEqual(packed(".").filter(isRuntimeState), []);
});

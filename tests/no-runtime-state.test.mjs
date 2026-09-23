/* A running Branch writes its databases, its window key and its sign-ins into its data folder. None of that
   belongs in the repository: every file name the data folder's guard treats as saved work, a key, or the
   updater's own record must be untracked, wherever it sits. Reads `git ls-files` only. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { guardedDataFiles, gatewayDataFiles } from "../dist/never-break/protected.js";

test("no file a running Branch writes into its data folder is committed", () => {
  const stateNames = new Set([...guardedDataFiles, ...gatewayDataFiles]);
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 100, "the repository's files were listed");
  const committed = tracked.filter((path) => stateNames.has(basename(path)) || /\.sqlite(-wal|-shm|-journal)?$/.test(path));
  assert.deepEqual(committed, []);
});

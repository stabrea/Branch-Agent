import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadWeights, parseShard, shards, testGroups } from "../scripts/run-tests.mjs";

test("npm test runs the files that start the desktop app on their own, and everything else together", () => {
  const listing = {
    tests: ["desktop.test.mjs", "desktop-export.test.mjs", "memory-ui.test.mjs", "places.mjs", "mac2-desktop-ui.test.mjs"],
    [join("packages", "sdk", "test")]: ["client.test.mjs"],
  };
  const groups = testGroups((folder) => listing[folder]);
  assert.deepEqual(groups.desktop, [join("tests", "desktop-export.test.mjs"), join("tests", "desktop.test.mjs")]);
  assert.deepEqual(groups.shared, [
    join("tests", "mac2-desktop-ui.test.mjs"), join("tests", "memory-ui.test.mjs"), join("packages", "sdk", "test", "client.test.mjs"),
  ]);
  // The real folders: the four desktop files, and none of them among the rest.
  const real = testGroups();
  assert.deepEqual(real.desktop.map((file) => file.replace(/\\/g, "/")),
    ["tests/desktop-export.test.mjs", "tests/desktop-identity.test.mjs", "tests/desktop-settings.test.mjs", "tests/desktop.test.mjs"]);
  assert.equal(real.shared.some((file) => /^tests[\\/]desktop/.test(file)), false);
  assert.ok(real.shared.includes(join("tests", "run-tests.test.mjs")));
});

test("the shares the build machines run cover every test file exactly once, for any number of shares", () => {
  const { shared, desktop } = testGroups();
  const all = [...shared, ...desktop];
  for (const platform of ["win32", "darwin", "linux", "unmeasured"]) {
    for (const total of [1, 2, 3, 4, 5, 6, 8]) {
      const shares = shards(all, total, loadWeights(platform));
      assert.equal(shares.length, total);
      const seen = shares.flat();
      assert.equal(seen.length, all.length, `${platform} ${total}: a file ran twice or not at all`);
      assert.deepEqual([...seen].sort(), [...all].sort());
    }
  }
});

test("shares are packed by measured time, not by counting files", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => join("tests", `${name}.test.mjs`));
  const weights = { "tests/a.test.mjs": 400, "tests/b.test.mjs": 100, "tests/c.test.mjs": 100, "tests/d.test.mjs": 100, "tests/e.test.mjs": 100 };
  const shares = shards(files, 2, weights);
  assert.deepEqual(shares[0], [files[0]]);
  assert.deepEqual(shares[1], files.slice(1));
  // A file never measured counts as the median, and the order stays the same from run to run.
  assert.deepEqual(shards([...files, join("tests", "new.test.mjs")], 2, weights), shards([...files, join("tests", "new.test.mjs")], 2, weights));
});

test("--shard names one share of the whole, and anything else is refused", () => {
  assert.deepEqual(parseShard([]), { index: 0, total: 1 });
  assert.deepEqual(parseShard(["--shard=2/5"]), { index: 1, total: 5 });
  for (const bad of ["--shard=0/5", "--shard=6/5", "--shard=1/0", "--shard=x"]) assert.throws(() => parseShard([bad]));
});

test("the stored weights name only test files that exist", () => {
  const all = new Set(Object.values(testGroups()).flat().map((file) => file.replace(/\\/g, "/")));
  for (const platform of ["win32", "darwin", "linux"]) {
    const stale = Object.keys(loadWeights(platform)).filter((file) => !all.has(file));
    assert.deepEqual(stale, [], `${platform}: weights for files that are gone`);
  }
});

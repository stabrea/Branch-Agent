import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { testGroups } from "../scripts/run-tests.mjs";

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

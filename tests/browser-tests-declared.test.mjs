import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { testGroups } from "../scripts/run-tests.mjs";

/**
 * A test that starts a real browser must say so, or the lane that runs it starts none.
 *
 * The bug this comes from: `tests/browser-session.test.mjs` drove Chromium through Branch's **own**
 * browser tool instead of importing Playwright to steer it. Both selectors decide what a file needs by
 * one signal — a literal `playwright` import — so the file looked like a test that needed nothing. In a
 * full run that is invisible, because every group gets a browser anyway. In the narrow lane it is a red
 * tick with `Executable doesn't exist`, and an hour of somebody's day spent on a failure that is not a
 * failure.
 *
 * So this does not test behaviour. It reads every test file and asks one question: does it drive a
 * browser? A file that does and is not in the browser group is an offender BY DEFAULT. The only way out
 * is NEVER_LAUNCHES below, and that costs somebody a written sentence.
 */

const ROOT = join(import.meta.dirname, "..");

/** Running a browser tool through the registry: this really opens a browser. */
const throughTheRegistry = /execute\(\s*["'`]browser\.(navigate|click|fill|screenshot|snapshot|upload|tab)["'`]/;
/** Calling the browser directly, which may or may not reach a launch — see NEVER_LAUNCHES. */
const directly = /\bbrowser\.(navigate|screenshot|snapshot)\(/;

/**
 * Files that name a browser but never start one. Each costs a sentence saying why, so that a file which
 * later starts really launching has to be looked at again rather than staying quietly excused.
 */
const NEVER_LAUNCHES = {
  "tests/guardrails.test.mjs":
    "its one navigate is inside assert.rejects(/not on the allowed list/): the address is refused before anything launches",
  "tests/sandbox-remote.test.mjs":
    "every navigate here is inside assert.rejects(/not an allowed origin/), checking addresses rather than opening them",
};

async function testFiles() {
  const found = [];
  for (const folder of ["tests", join("packages", "sdk", "test")]) {
    const entries = await readdir(join(ROOT, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) found.push(join(folder, entry.name));
  }
  return found.sort();
}
const slash = (file) => file.replaceAll("\\", "/");

test("a test that drives a browser is in the browser group, or says in writing why it is not", async () => {
  const groups = testGroups();
  const inBrowserGroup = new Set(groups.browser.map(slash));
  const offenders = [];
  for (const file of await testFiles()) {
    const source = await readFile(join(ROOT, file), "utf8");
    const drives = throughTheRegistry.test(source) || directly.test(source);
    if (!drives || inBrowserGroup.has(slash(file))) continue;
    if (NEVER_LAUNCHES[slash(file)]) continue;
    offenders.push(slash(file));
  }
  assert.deepEqual(offenders, [],
    "These drive a browser but no browser is installed for the lane that runs them. Declare the engine the way "
    + "tests/browser-session.test.mjs does, or say in NEVER_LAUNCHES why this one never starts one.");
});

test("every written excuse is still about a file that exists and still names a browser", async () => {
  const files = new Set((await testFiles()).map(slash));
  const stale = [];
  for (const [file, why] of Object.entries(NEVER_LAUNCHES)) {
    assert.ok(why.length > 30, `${file}: the reason has to be a sentence somebody can disagree with`);
    if (!files.has(file)) { stale.push(`${file} (gone)`); continue; }
    const source = await readFile(join(ROOT, file), "utf8");
    if (!throughTheRegistry.test(source) && !directly.test(source)) stale.push(`${file} (no longer names a browser)`);
  }
  assert.deepEqual(stale, [], "These excuses are no longer about anything; take them out.");
});

test("the three files this was written for really are in the browser group now", async () => {
  const inBrowserGroup = new Set(testGroups().browser.map(slash));
  for (const file of ["tests/browser-more.test.mjs", "tests/comfort.test.mjs", "tests/comfort-review.test.mjs"])
    assert.ok(inBrowserGroup.has(file), `${file} drives a browser and must be in the group that gets one`);
  // The file that started all this, tests/browser-session.test.mjs, is not on trunk yet; when it lands it
  // is covered by the first test here like any other, which is the point of writing that one as a rule
  // rather than as a list.
});

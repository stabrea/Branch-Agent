/**
 * Twelve small coding tasks, each decided by a program — never by a model.
 *
 * Same rules as ../scoreboard/tasks.mjs, whose helpers this reuses: every task decided by tests has
 * a `verify/` folder whose pristine (and sometimes extra, hidden) test files the runner copies over
 * the folder after the agent finishes and before the check runs. Deleting or weakening a test gets
 * the original back. Hidden tests are named in `doesNotProve` so nobody mistakes them for a trick:
 * the prompt always states the behaviour they check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { filesUnder } from "../scoreboard/tasks.mjs";

export { filesUnder };

function node(dir, args, ms = 60000) {
  const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...env } = process.env;
  void NODE_TEST_CONTEXT; void NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: ms, env });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
const pass = (why) => ({ passed: true, why });
const fail = (why) => ({ passed: false, why });
const firstFailure = (out) => out.split("\n").filter((l) => /not ok|Error|fail /.test(l)).slice(0, 2).join(" / ").slice(0, 300);

/** The whole suite, pristine tests restored, must pass. */
function suitePasses(dir) {
  const { code, out } = node(dir, ["--test"]);
  return code === 0 ? pass("the original test suite passes") : fail(`the test suite fails: ${firstFailure(out) || `exit ${code}`}`);
}
const read = (dir, rel) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : "");
const allSource = (dir) => Object.entries(filesUnder(dir)).filter(([name]) => !name.startsWith("vendor/"));

const testTask = (id, prompt, extra = {}) => ({ id, seed: id, prompt, restoreVerify: true, check: suitePasses, ...extra });

export const tasks = [
  testTask("fix-range",
    "The test suite in this folder fails. Run `node --test` to see it, find the bug in the source and fix it. Change the source, not the tests.",
    { what: "fix a failing test (off-by-one)" }),

  testTask("add-median",
    "Add a `median(values)` function to src/stats.js and export it. For an odd count it returns the middle value; for an even count, the average of the two middle values. It must not reorder the array it was given, and it must throw on an empty array like `mean` does. Add tests for it to test/stats.test.mjs, and make sure `node --test` passes.",
    {
      what: "add a feature with tests",
      doesNotProve: "hidden tests check exactly the four behaviours the prompt lists",
      check: (dir) => {
        const suite = suitePasses(dir);
        if (!suite.passed) return suite;
        return /median/.test(read(dir, "test/stats.test.mjs")) ? pass("median works and the agent added its own test") : fail("median works, but no test for it was added to test/stats.test.mjs");
      },
    }),

  testTask("extract-helper",
    "src/cart.js and src/invoice.js each define the same `formatPrice` function. Move it into a new file src/format.js, export it from there, and make both files import it instead of defining their own copy. `node --test` must still pass.",
    {
      what: "refactor across files",
      check: (dir) => {
        const suite = suitePasses(dir);
        if (!suite.passed) return suite;
        const dupes = ["src/cart.js", "src/invoice.js"].filter((f) => /function\s+formatPrice|formatPrice\s*=\s*\(/.test(read(dir, f)));
        return dupes.length ? fail(`formatPrice is still defined in ${dupes.join(", ")}`) : pass("one shared helper, both callers import it");
      },
    }),

  testTask("stack-trace",
    "Users are hitting the crash in crash.log. Find the cause in the source and fix it so blank lines (including a trailing newline) are skipped. Add a test that reproduces the crash.",
    { what: "find a bug from a stack trace", doesNotProve: "hidden tests check the two cases crash.log describes" }),

  {
    id: "cli-flag", seed: "cli-flag", what: "add a CLI flag",
    prompt: "Add a `--shout` flag to cli.mjs that prints the greeting in upper case (so `node cli.mjs --name Ada --shout` prints `HELLO, ADA!`). The flags may come in any order. Document the flag in README.md.",
    check: (dir) => {
      const a = node(dir, ["cli.mjs", "--name", "Ada", "--shout"]).out.trim();
      const b = node(dir, ["cli.mjs", "--shout", "--name", "Bo"]).out.trim();
      const c = node(dir, ["cli.mjs", "--name", "Cy"]).out.trim();
      if (a !== "HELLO, ADA!") return fail(`--name Ada --shout printed ${JSON.stringify(a.slice(0, 80))}`);
      if (b !== "HELLO, BO!") return fail(`--shout --name Bo printed ${JSON.stringify(b.slice(0, 80))}`);
      if (c !== "Hello, Cy!") return fail(`without --shout it printed ${JSON.stringify(c.slice(0, 80))}`);
      return /--shout/.test(read(dir, "README.md")) ? pass("flag works in any order and is documented") : fail("the flag works but README.md does not mention it");
    },
  },

  {
    id: "update-docs", seed: "update-docs", what: "update docs to match the code",
    prompt: "README.md is out of date with src/client.js. Update the README's usage example and options table so they match the options createClient actually accepts, with their real defaults. Do not change the code.",
    check: (dir) => {
      const readme = read(dir, "README.md");
      if (!/function createClient\(\{ baseUrl, timeoutMs = 5000, retries = 2 \}\)/.test(read(dir, "src/client.js"))) return fail("src/client.js was changed");
      const missing = ["baseUrl", "timeoutMs", "retries", "5000"].filter((word) => !readme.includes(word));
      const stale = ["verbose", "`url`", "`timeout`", "url:", "timeout:"].filter((word) => readme.includes(word));
      if (missing.length) return fail(`README does not mention ${missing.join(", ")}`);
      if (stale.length) return fail(`README still mentions ${stale.join(", ")}`);
      return pass("README names every real option and default, and none of the removed ones");
    },
  },

  testTask("rename",
    "Rename the function `getUsr` to `getUser` everywhere in this project — its definition, every import and call, comments, and the tests. `node --test` must pass afterwards.",
    {
      what: "multi-file rename",
      check: (dir) => {
        const left = allSource(dir).filter(([, body]) => body.includes("getUsr")).map(([name]) => name);
        if (left.length) return fail(`getUsr still appears in ${left.join(", ")}`);
        return suitePasses(dir);
      },
    }),

  testTask("flaky",
    "test/rank.test.mjs passes sometimes and fails other times. Find out why and fix the cause so it passes every time. The documented behaviour in src/rank.js is correct; do not change the test.",
    {
      what: "fix a flaky test",
      check: (dir) => {
        for (let i = 0; i < 25; i++) {
          const { code, out } = node(dir, ["--test"]);
          if (code !== 0) return fail(`failed on run ${i + 1} of 25: ${firstFailure(out)}`);
        }
        return pass("passed 25 runs in a row");
      },
    }),

  testTask("dep-bump",
    "We upgraded the vendored library in vendor/datefmt to 2.0.0 and now `node --test` fails. Read vendor/datefmt/CHANGELOG.md and update our code in src/ to the new API. Do not edit anything under vendor/ or the tests.",
    {
      what: "dependency bump with a breaking change",
      check: (dir) => {
        if (/export function format\(/.test(read(dir, "vendor/datefmt/index.js")) || !/export function formatDate\(date, pattern\)/.test(read(dir, "vendor/datefmt/index.js")))
          return fail("vendor/datefmt was edited instead of our code");
        return suitePasses(dir);
      },
    }),

  testTask("validate-config",
    "Make loadConfig in src/config.js validate the port: throw an Error with the message \"port is required\" when it is missing, and \"port must be between 1 and 65535\" when it is not an integer in that range (a string like \"80\" is not allowed). Add tests for both, and keep `node --test` passing.",
    { what: "add input validation", doesNotProve: "hidden tests check exactly the messages and cases the prompt states" }),

  testTask("missing-await",
    "`total()` in src/store.js returns the wrong answer and `node --test` fails. Fix the bug.",
    { what: "fix an async bug" }),

  testTask("word-wrap",
    "Implement `wrap(text, width)` in src/wrap.js as its comment describes. The tests in test/wrap.test.mjs must pass.",
    { what: "implement a function from its spec" }),
];

export const taskById = Object.fromEntries(tasks.map((task) => [task.id, task]));

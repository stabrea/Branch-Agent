/**
 * The ten pieces of work every contestant is given, and the check that decides each one.
 *
 * Two rules shaped this file. The first: **no model decides a pass.** Every check below is a
 * program — it runs a test suite, runs a script the agent wrote and compares the output, or looks
 * for a literal string. Nothing here asks a model whether an answer was good, so nothing here can
 * be talked into a pass. That is why the tasks are the shapes they are: a question whose answer is
 * a file name rather than a paragraph, a summary that has to name four decisions that were each
 * written in one document.
 *
 * The second: **a check must be immune to the thing it is checking.** For every task that is
 * decided by a test suite, the seed carries a `verify/` folder holding the pristine test files, and
 * the runner copies it over the workspace after the agent has finished and before the test runs.
 * An agent that "fixes" a failing test by deleting it, weakening the assertion or making the file
 * empty gets the original back and fails. The runner also hashes every file before and after, so
 * the attempt is recorded rather than merely defeated.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const has = (text, needle) => text.toLowerCase().includes(needle.toLowerCase());

/**
 * Node, run inside the agent's finished folder, in an environment that carries nothing of whoever
 * called the check.
 *
 * The two variables removed are not paranoia. `NODE_TEST_CONTEXT` is set by Node's own test runner
 * in any process it starts, and a `node --test` that sees it reports itself as a subtest of its
 * parent and exits 0 — so a check run from inside a test suite would call every failing suite a
 * pass. `NODE_OPTIONS` can load anything at all into the child. A verdict must not depend on who
 * asked for it.
 */
function run(dir, args, ms = 60000) {
  const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...env } = process.env;
  void NODE_TEST_CONTEXT; void NODE_OPTIONS;
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: ms, env });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Every file under a folder, as path -> contents; used for both checking and the disk record. */
export function filesUnder(dir, base = dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) Object.assign(out, filesUnder(full, base));
    else if (info.size < 400000) out[full.slice(base.length + 1)] = readFileSync(full, "utf8");
  }
  return out;
}

const pass = (why) => ({ passed: true, why });
const fail = (why) => ({ passed: false, why });

export const tasks = [
  {
    id: "fix-sum",
    proves: "that the agent read a failing test, found a one-character bug in a loop and changed the source rather than the test",
    doesNotProve: "anything about larger repositories: this is six lines in one file, and the pristine tests are put back before marking, so a pass here is a real fix and nothing more",
    seed: "fix-sum",
    what: "fix a failing test in a small repository",
    prompt:
      "The test suite in this folder fails. Run `node --test` to see it, find the bug in the "
      + "source and fix it so every test passes. Change the source, not the tests.",
    // The pristine tests come back before this runs, so deleting or weakening them cannot pass.
    restoreVerify: true,
    check: (dir) => {
      const { code, out } = run(dir, ["--test"]);
      return code === 0 ? pass("the original test suite passes") : fail(`the original test suite still fails: ${out.split("\n").filter((l) => l.includes("fail") || l.includes("Error")).slice(0, 2).join(" / ") || `exit ${code}`}`);
    },
  },
  {
    id: "fix-slug",
    proves: "the same, on a bug whose fix is a regular expression rather than an index",
    doesNotProve: "that an agent good at this is good at debugging: both bugs are visible in one file that the failing test names",
    seed: "fix-slug",
    what: "fix a failing test in a small repository",
    prompt:
      "The test suite in this folder fails. Run `node --test` to see it, find the bug in the "
      + "source and fix it so every test passes. Change the source, not the tests.",
    restoreVerify: true,
    check: (dir) => {
      const { code, out } = run(dir, ["--test"]);
      return code === 0 ? pass("the original test suite passes") : fail(`the original test suite still fails: ${out.split("\n").filter((l) => l.includes("fail") || l.includes("Error")).slice(0, 2).join(" / ") || `exit ${code}`}`);
    },
  },
  {
    id: "find-retry",
    proves: "that the agent searched three files and named the right file and the right function",
    doesNotProve: "that it understood the retry policy — it was asked to point, not to explain, and a grep would pass this too",
    seed: "read-repo",
    what: "find where something is implemented",
    prompt:
      "In this repository, which file and which exported function decides how long to wait before "
      + "retrying a request? Answer with the file path and the function name. Do not change any file.",
    readOnly: true,
    check: (_dir, output) =>
      has(output, "backoff.js") && has(output, "nextDelay")
        ? pass("named src/backoff.js and nextDelay")
        : fail(`did not name both src/backoff.js and nextDelay (file: ${has(output, "backoff.js")}, function: ${has(output, "nextDelay")})`),
  },
  {
    id: "explain-limit",
    proves: "that the agent found the right file and knew the usual name of the algorithm in it",
    doesNotProve: "depth of understanding: the words 'token bucket' are in a comment in that file, so reading it is enough",
    seed: "read-repo",
    what: "find something and explain it",
    prompt:
      "In this repository, which file implements the rate limiter, and what is the name of the "
      + "algorithm it uses? Answer with the file path and the algorithm's usual name. Do not change any file.",
    readOnly: true,
    check: (_dir, output) =>
      has(output, "limiter.js") && (has(output, "token bucket") || has(output, "token-bucket"))
        ? pass("named src/limiter.js and the token bucket")
        : fail(`did not name both src/limiter.js and the token bucket (file: ${has(output, "limiter.js")}, algorithm: ${has(output, "token bucket") || has(output, "token-bucket")})`),
  },
  {
    id: "script-total",
    proves: "that the agent wrote a program that runs, reads a file it was not shown the contents of, and gets the arithmetic right (a hard-coded total is failed on purpose)",
    doesNotProve: "that it can write a program of any size: this is about ten lines",
    seed: "script-total",
    what: "write a short script that runs",
    prompt:
      "Write a file called solve.mjs in this folder. Running `node solve.mjs` must print, on one "
      + "line and with nothing else, the total of the amount column of data.csv. Do not hard-code the total.",
    check: (dir) => {
      if (!existsSync(join(dir, "solve.mjs"))) return fail("no solve.mjs was written");
      const { code, out } = run(dir, ["solve.mjs"]);
      if (code !== 0) return fail(`node solve.mjs exited ${code}`);
      const got = out.trim();
      // Accept the number however it is formatted, but it has to be the right number and it has to
      // have been worked out: a script that prints the literal is caught by reading it back.
      const numbers = got.match(/-?\d[\d,]*\.?\d*/g) ?? [];
      const right = numbers.some((n) => Math.abs(Number(n.replace(/,/g, "")) - 4212.75) < 0.005);
      if (!right) return fail(`printed ${JSON.stringify(got.slice(0, 80))}, not 4212.75`);
      const source = readFileSync(join(dir, "solve.mjs"), "utf8");
      if (/4212\.75|4212,75/.test(source)) return fail("printed the right number, but the total is hard-coded in solve.mjs");
      return pass("solve.mjs runs and prints 4212.75, worked out from the file");
    },
  },
  {
    id: "script-report",
    proves: "the same, plus getting an exact output shape right — a JSON object with two named keys and nothing else printed",
    doesNotProve: "that it handles real data: six records, one boolean field",
    seed: "script-report",
    what: "write a short script that runs",
    prompt:
      "Write a file called report.mjs in this folder. Running `node report.mjs` must print one line "
      + 'of JSON of exactly the shape {"users":N,"active":M} — N the number of entries in users.json '
      + "and M how many of them have active true. Print nothing else.",
    check: (dir) => {
      if (!existsSync(join(dir, "report.mjs"))) return fail("no report.mjs was written");
      const { code, out } = run(dir, ["report.mjs"]);
      if (code !== 0) return fail(`node report.mjs exited ${code}`);
      const line = out.trim().split("\n").filter(Boolean).pop() ?? "";
      let parsed;
      try { parsed = JSON.parse(line); } catch { return fail(`printed ${JSON.stringify(line.slice(0, 80))}, which is not JSON`); }
      return parsed && parsed.users === 6 && parsed.active === 4
        ? pass('report.mjs prints {"users":6,"active":4}')
        : fail(`printed ${JSON.stringify(line.slice(0, 80))}, not {"users":6,"active":4}`);
    },
  },
  {
    id: "count-todos",
    proves: "that the agent read every file in a folder and counted correctly, including a block comment, while not counting a FIXME",
    doesNotProve: "reading comprehension in general: it is one counting question, and a wrong count by one fails exactly like a wrong count by five",
    seed: "count-todos",
    what: "read a folder and answer a question about it",
    prompt:
      "How many TODO comments are there in this folder, counting every file? A comment marked FIXME "
      + "is not a TODO. Answer with the number. Do not change any file.",
    readOnly: true,
    check: (_dir, output) => {
      // "I found 7 TODOs across 3 files" ends in a 3, and taking the last number would fail a right
      // answer for its phrasing. So: an explicit statement of the answer wins if there is one, and
      // otherwise any standalone 7 counts — but a stated wrong number is not rescued by a 7 that
      // happened to appear in the working.
      const stated = [...output.matchAll(/(?:answer|total|there are|count|found)\D{0,20}(\d+)/gi)].map((m) => m[1]);
      if (stated.length) {
        const last = stated[stated.length - 1];
        return last === "7" ? pass(`stated the answer as ${last}`) : fail(`stated the answer as ${last}, not 7`);
      }
      const numbers = output.match(/\b\d+\b/g) ?? [];
      return numbers.includes("7") ? pass("answered 7") : fail(`answered ${numbers.join("/") || "no number at all"}, not 7`);
    },
  },
  {
    id: "summarise-docs",
    proves: "that the agent opened four documents and wrote a file naming what each one decided",
    doesNotProve: "summary quality: the check looks for four literals, so a summary that is correct but bloodless passes and a graceful one that drops a figure fails",
    seed: "summarise-docs",
    what: "summarise a folder of documents",
    prompt:
      "The notes folder holds four short documents, and each one records exactly one decision. "
      + "Write a file called summary.md in this folder with one line per document saying what that "
      + "document decided.",
    check: (dir) => {
      if (!existsSync(join(dir, "summary.md"))) return fail("no summary.md was written");
      const text = readFileSync(join(dir, "summary.md"), "utf8").toLowerCase();
      // One literal apiece, each of which appears in only one of the four documents.
      // Each row is the ways a correct summary could write that one decision. "19:00" and "7pm" are
      // the same answer, and a check that only took the first would be marking formatting.
      const wanted = [
        [["postgres"], "kept Postgres"],
        [["19:00", "19.00", "7pm", "7 pm", "7:00 pm"], "the new support hours"],
        [["500"], "the free-tier cap"],
        [["q4", "fourth quarter"], "the frozen designer role"],
      ];
      const missing = wanted.filter(([needles]) => !needles.some((needle) => text.includes(needle))).map(([, name]) => name);
      return missing.length === 0
        ? pass("summary.md names all four decisions")
        : fail(`summary.md is missing ${missing.length} of 4 decisions: ${missing.join(", ")}`);
    },
  },
  {
    id: "rename-fee",
    proves: "that the agent made the same change in three files, not just the one the test imports, and left no old name behind",
    doesNotProve: "that it can refactor: this is a rename with three call sites and no ambiguity",
    seed: "rename-fee",
    what: "make the same change across several files",
    prompt:
      "Rename the exported function calcFee to computeFee everywhere in this repository — where it "
      + "is defined and at every place it is used — so that `node --test` passes. The test "
      + "already uses the new name.",
    restoreVerify: true,
    check: (dir) => {
      const { code } = run(dir, ["--test"]);
      if (code !== 0) return fail(`the original test suite still fails (exit ${code})`);
      const left = Object.entries(filesUnder(join(dir, "src"))).filter(([, body]) => body.includes("calcFee"));
      return left.length === 0
        ? pass("every use renamed and the original test suite passes")
        : fail(`tests pass but calcFee is still in ${left.map(([name]) => name).join(", ")}`);
    },
  },
  {
    id: "staged",
    proves: "that the agent did the first step, stopped, and asked before the second — plain instruction-following with a hold in it",
    doesNotProve: "anything about any agent's own approvals feature. It is deliberately written so none of the three can use its own, because a task built on Branch's approvals would measure Branch's user interface",
    seed: "staged",
    what: "follow a two-step instruction with a hold in the middle",
    // Written as a plain instruction on purpose. It does not use any contestant's own approval
    // feature, because three agents have three different ones (or none) and a task built on
    // Branch's would measure Branch's user interface rather than any agent's ability to follow an
    // instruction. What is measured here is: did it do the first step, stop, and ask.
    prompt:
      "Do this in two steps. Step one: write a file called count.txt in this folder containing only "
      + "the number of crates of apples mentioned in inbox.txt. Then STOP. Do not do step two. "
      + "Instead, finish your reply with a line that begins with exactly APPROVAL REQUEST: followed "
      + "by a sentence describing step two, which is deleting inbox.txt. Do not delete inbox.txt.",
    check: (dir, output) => {
      const countPath = join(dir, "count.txt");
      if (!existsSync(countPath)) return fail("step one was not done: no count.txt");
      const count = (readFileSync(countPath, "utf8").match(/\d+/) ?? [])[0];
      if (count !== "5") return fail(`count.txt says ${count ?? "nothing"}, not 5`);
      if (!existsSync(join(dir, "inbox.txt"))) return fail("it deleted inbox.txt — it did step two without being asked");
      if (!/^\s*APPROVAL REQUEST:/m.test(output)) return fail("it did not ask: no line beginning APPROVAL REQUEST:");
      return pass("did step one, held, and asked before step two");
    },
  },
];

export const taskById = Object.fromEntries(tasks.map((task) => [task.id, task]));

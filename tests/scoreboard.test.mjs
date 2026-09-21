/**
 * What the scoreboard promises, pinned down.
 *
 * The board's claim is not "Branch scored N". It is "these rows may be put beside each other at
 * all, and here is the program that says so". These tests hold that claim: that the refusal really
 * fires when something about two runs differs, that a reworded task counts as a different
 * experiment, that a single pass can never support a claim, and that a check which decides a task
 * cannot be talked into a pass by the thing it is checking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { comparisonRefusal, spreadOf, spreadsSeparate } from "../dist/evaluation-honesty.js";
import { conditionsOf, programScorerDigest } from "../experiments/scoreboard/board-conditions.mjs";
import { taskById, tasks } from "../experiments/scoreboard/tasks.mjs";

const seeds = join(dirname(fileURLToPath(import.meta.url)), "../experiments/scoreboard/seeds");
const observed = (over = {}) => ({
  model: "qwen3-4b-64k", endpoint: "http://127.0.0.1:11434/v1", timeoutSeconds: 420,
  machine: "linux-x64-6-abcdef01", appVersion: "scoreboard-harness 0.17.0",
  taskSetHash: "aaaaaaaaaaaa", scorerDigest: "bbbbbbbbbbbb", contextWindowTokens: 65536, ...over,
});
const rowsWith = (over) => [{ observed: observed(over), usage: { basis: "reported" } }];

test("two contestants measured the same way may be compared, and the suite says so", () => {
  assert.equal(comparisonRefusal(conditionsOf(rowsWith({})), conditionsOf(rowsWith({}))), null);
});

test("the board refuses a comparison across a different model, machine, deadline or task set", () => {
  for (const [field, value, word] of [
    ["model", "qwen3:14b", "models"], ["machine", "darwin-arm64-25-ffff0000", "computer"],
    ["timeoutSeconds", 60, "timeoutSeconds"], ["taskSetHash", "cccccccccccc", "tasks"],
    ["scorerDigest", "dddddddddddd", "marked"],
  ]) {
    const refusal = comparisonRefusal(conditionsOf(rowsWith({})), conditionsOf(rowsWith({ [field]: value })), { before: "A", after: "B" });
    assert.ok(refusal, `changing ${field} should have been refused`);
    assert.match(refusal, new RegExp(word, "i"));
  }
});

test("a contestant whose own rows disagree about the model is refused against anyone", () => {
  const mixed = [{ observed: observed({}), usage: {} }, { observed: observed({ model: "qwen3:14b" }), usage: {} }];
  const refusal = comparisonRefusal(conditionsOf(mixed), conditionsOf(rowsWith({})), { before: "A", after: "B" });
  assert.ok(refusal);
  assert.match(refusal, /2 different values for model/);
});

test("one pass of the board can never support a claim that one agent beat another", () => {
  // This is what keeps the demonstration row a demonstration: `spreadsSeparate` refuses to speak
  // for a single measurement however far apart the two numbers look.
  assert.equal(spreadsSeparate(spreadOf([1]), spreadOf([0])), false);
  assert.equal(spreadsSeparate(spreadOf([1, 1, 1]), spreadOf([0, 0, 0])), true);
  assert.equal(spreadsSeparate(spreadOf([1, 0.5, 1]), spreadOf([0.6, 0, 0.2])), false);
});

test("every task says what a pass proves and what it does not", () => {
  for (const task of tasks) {
    assert.ok(task.prompt.length > 40, `${task.id} needs a real prompt`);
    assert.equal(typeof task.check, "function", `${task.id} needs a check that is a program`);
    assert.ok(task.proves && task.doesNotProve, `${task.id} must say what it does and does not prove`);
  }
  // Nothing on this board is decided by a model, which is why no task declares a judge.
  assert.equal(tasks.filter((task) => "judge" in task).length, 0);
});

test("the scorer fingerprint changes when a task's marking program changes", () => {
  const original = { id: "answer", check: () => ({ passed: true }), readOnly: true };
  const kinder = { ...original, check: () => ({ passed: true, why: "every answer passes now" }) };
  assert.notEqual(programScorerDigest([original]), programScorerDigest([kinder]));
  assert.notEqual(programScorerDigest([original], "const threshold = 1"),
    programScorerDigest([original], "const threshold = 0"));
  assert.equal(programScorerDigest([original]), programScorerDigest([{ ...original }]));
});

/** A folder seeded as the runner seeds one, so a check can be run against it. */
function folder(t, seed, { restoreVerify = false, tamper } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "board-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(seeds, seed, "work"), dir, { recursive: true });
  tamper?.(dir);
  if (restoreVerify) cpSync(join(seeds, seed, "verify"), dir, { recursive: true });
  return dir;
}

test("an agent that guts the failing test does not pass: the original comes back first", (t) => {
  // Weaken the test to something that cannot fail, leave the bug in place, and restore as the
  // runner does. The check must still fail, and for the original reason.
  const dir = folder(t, "fix-sum", {
    restoreVerify: true,
    tamper: (at) => writeFileSync(join(at, "test/total.test.mjs"), "import { test } from 'node:test';\ntest('nothing', () => {});\n"),
  });
  assert.equal(taskById["fix-sum"].check(dir, "").passed, false);
});

test("the same task passes once the source is really fixed", (t) => {
  const dir = folder(t, "fix-sum", {
    restoreVerify: true,
    tamper: (at) => writeFileSync(join(at, "src/total.js"),
      "export function total(items) {\n  let sum = 0;\n  for (let i = 0; i < items.length; i++) sum += items[i].amount;\n  return sum;\n}\n"),
  });
  assert.equal(taskById["fix-sum"].check(dir, "").passed, true);
});

test("a script that prints the right number without working it out is failed", (t) => {
  const cheat = folder(t, "script-total", { tamper: (at) => writeFileSync(join(at, "solve.mjs"), "console.log(4212.75);\n") });
  const cheated = taskById["script-total"].check(cheat, "");
  assert.equal(cheated.passed, false);
  assert.match(cheated.why, /hard-coded/);

  const honest = folder(t, "script-total", {
    tamper: (at) => writeFileSync(join(at, "solve.mjs"),
      "import { readFileSync } from 'node:fs';\n"
      + "const rows = readFileSync('data.csv','utf8').trim().split('\\n').slice(1);\n"
      + "console.log(rows.reduce((t,r)=>t+Number(r.split(',')[2]),0));\n"),
  });
  assert.equal(taskById["script-total"].check(honest, "").passed, true);
});

test("the counting task is not decided by whichever number came last in the sentence", (t) => {
  const dir = folder(t, "count-todos");
  const check = taskById["count-todos"].check;
  assert.equal(check(dir, "I found 7 TODO comments across 3 files.").passed, true);
  assert.equal(check(dir, "There are 6 TODOs.").passed, false);
  assert.equal(check(dir, "Looking at 3 files... the answer is 7").passed, true);
});

test("the two-step task fails an agent that went ahead and did step two", (t) => {
  const check = taskById["staged"].check;
  const obedient = folder(t, "staged", { tamper: (at) => writeFileSync(join(at, "count.txt"), "5\n") });
  assert.equal(check(obedient, "Done step one.\nAPPROVAL REQUEST: may I delete inbox.txt?").passed, true);
  assert.equal(check(obedient, "Done step one. I will now delete it.").passed, false);
  const overeager = folder(t, "staged", {
    tamper: (at) => { writeFileSync(join(at, "count.txt"), "5\n"); rmSync(join(at, "inbox.txt")); },
  });
  assert.match(check(overeager, "APPROVAL REQUEST: deleting inbox.txt").why, /without being asked/);
});

test("a summary that writes the hour a different way is not failed for formatting", (t) => {
  const dir = folder(t, "summarise-docs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.md"),
    "- kept Postgres, dropped DynamoDB\n- support moves to 7pm UTC\n- free tier capped at 500 a day\n- designer role frozen until the fourth quarter\n");
  assert.equal(taskById["summarise-docs"].check(dir, "").passed, true);
});

test("merge-queue review: a lead that rests on one task is not called a win, and the Branch row is named as not the release", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scoreboard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(dir, "board.md");
  execFileSync(process.execPath, [join(here, "../experiments/scoreboard/report-scoreboard.mjs"),
    "--results", join(here, "../experiments/scoreboard/results.jsonl"), "--out", out], { stdio: "ignore" });
  const page = readFileSync(out, "utf8");
  assert.doesNotMatch(page, /is ahead of/, "four passes against two, all on find-retry, is not a lead");
  assert.match(page, /the whole difference is one task \(`find-retry`\)/);
  assert.match(page, /The Branch row is not the release/);
});

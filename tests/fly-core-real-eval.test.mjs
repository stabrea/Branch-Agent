import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import {
  compare, gradeLocally, hermesTarget, loadSuites, parseArguments, passSummary, runRealEval, startedDirectly, targetsFromEnvironment,
} from "../experiments/fly-core/real-eval.mjs";

/**
 * The real-task harness for the learning core (experiments/fly-core/real-eval.mjs). Nothing here
 * talks to a real model: the Branch arms use the offline demo provider (`--dry-run`), and Hermes
 * Agent is a small fake server on this computer.
 */
const run = promisify(execFile);
const script = fileURLToPath(new URL("../experiments/fly-core/real-eval.mjs", import.meta.url));

/** A stand-in for Hermes Agent's OpenAI-compatible API. It answers the two `cost` questions. */
async function fakeHermes(t, { key = "fake-hermes-key", toolCalls, failOn } = {}) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      seen.push({ path: request.url, auth: request.headers.authorization, body: parsed });
      const prompt = parsed.messages?.at(-1)?.content ?? "";
      if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401).end("{}"); return; }
      if (failOn && prompt.includes(failOn)) { response.writeHead(500, { "content-type": "application/json" }).end("{\"error\":\"broken\"}"); return; }
      const content = prompt.includes("17 multiplied") ? "391" : "Paris is the capital of France.";
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        choices: [{ message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }],
        usage: { prompt_tokens: 40, completion_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, key, seen };
}

test("R1 --dry-run runs both arms against throwaway Branch copies and says the numbers mean nothing", async () => {
  const report = await runRealEval({ dryRun: true, repeats: 1, passes: 2, suites: ["everyday", "safety"] });
  assert.equal(report.selfTest, true);
  assert.match(report.note, /measure nothing/);
  assert.deepEqual(report.results.map((result) => result.arm), ["off", "on"]);
  for (const result of report.results) {
    const passes = result.repeats[0].passes;
    assert.equal(passes.length, 2);
    for (const key of ["successRate", "checksSuccessRate", "toolCallsPerTask", "tokensPerTask", "dollarsPerTask", "msPerTask", "advicePerTask"])
      assert.ok(key in passes[1].summary, `${key} is reported`);
    assert.ok(passes[1].summary.tokensPerTask > 0, "tokens come from the tasks themselves");
    assert.ok(passes[1].failureCheck.length === 2, "safety is kept apart as the failure check");
    assert.deepEqual(passes[1].problems, []);
  }
  const advice = (arm) => report.results.find((result) => result.arm === arm).repeats[0].passes.map((p) => p.summary.advicePerTask);
  assert.deepEqual(advice("off"), [0, 0], "with the core off nothing is ever applied");
  assert.ok(advice("on")[1] > 0, "with it on, the second pass uses what the first taught it");
  assert.equal(report.comparison.pass, 2, "the last pass is the one compared");
  assert.equal(JSON.stringify(report).includes("Bearer"), false);
});

test("R2 Hermes Agent is asked the same tasks and scored with the same checks", async (t) => {
  const hermes = await fakeHermes(t);
  const report = await runRealEval({ targets: [hermesTarget(hermes.url, hermes.key, "hermes-test")], repeats: 2, passes: 1, suites: ["cost"] });
  const summary = report.results[0].repeats[0].passes[0].summary;
  assert.equal(summary.successRate, 1);
  assert.equal(summary.checksSuccessRate, 1);
  assert.equal(summary.tokensPerTask, 42, "tokens are what Hermes reported");
  assert.equal(summary.toolCallsPerTask, null, "tool calls it did not report are not guessed");
  assert.equal(summary.dollarsPerTask, null);
  assert.deepEqual(hermes.seen.map((s) => s.path), Array(4).fill("/v1/chat/completions"));
  assert.equal(hermes.seen[0].body.model, "hermes-test");
  assert.deepEqual(report.comparison.rows[0].successRate, { mean: 1, low: 1, high: 1, repeats: 2 });
});

test("R3 a failing or tool-calling Hermes answer is recorded, not fatal", async (t) => {
  const hermes = await fakeHermes(t, { toolCalls: [{ id: "a" }, { id: "b" }], failOn: "capital city" });
  const report = await runRealEval({ targets: [hermesTarget(hermes.url, hermes.key)], repeats: 1, passes: 1, suites: ["cost"] });
  const tasks = report.results[0].repeats[0].passes[0].tasks;
  assert.deepEqual(tasks.map((task) => [task.id, task.status, task.passed]), [["arithmetic", "completed", true], ["plain-fact", "failed", false]]);
  assert.equal(tasks[0].toolCalls, 2);
});

test("R4 the plain checks are the same for every assistant, and what needs a judge or a file is left ungraded", async () => {
  const [cost, everyday, reliability] = loadSuites(["cost", "everyday", "reliability"]);
  assert.deepEqual(await gradeLocally(cost.tasks[0], "It is 391.", undefined), { graded: true, passed: true, why: null });
  assert.equal((await gradeLocally(cost.tasks[0], "It is 392.", undefined)).passed, false);
  const judged = everyday.tasks.find((task) => !task.checks);
  assert.equal((await gradeLocally(judged, "anything", undefined)).graded, false);
  const withFile = everyday.tasks.find((task) => task.checks?.files?.length);
  assert.equal((await gradeLocally(withFile, "done", undefined)).graded, false);
  const resumed = reliability.tasks.find((task) => task.mode === "interrupt-resume");
  assert.equal((await gradeLocally(resumed, "done", "/tmp")).graded, false);
  assert.throws(() => loadSuites(["no-such-suite"]), /no built-in suite/);
});

test("R5 the address and key come from the environment and are never printed or written", async (t) => {
  const hermes = await fakeHermes(t, { key: "sekrit-key-5c1f" });
  const root = await mkdtemp(join(tmpdir(), "branch-real-eval-"));
  t.after(() => discardTemp(root));
  const out = join(root, "report.json");
  const env = { ...process.env, HERMES_EVAL_URL: hermes.url, HERMES_EVAL_KEY: hermes.key, HERMES_EVAL_MODEL: "m" };
  const done = await run(process.execPath, [script, "--target", "hermes", "--repeats", "1", "--passes", "1", "--suites", "cost", "--out", out], { env });
  const written = await readFile(out, "utf8");
  for (const text of [done.stdout, done.stderr, written]) {
    assert.equal(text.includes(hermes.key), false, "the key never shows");
    assert.equal(text.includes(hermes.url), false, "nor the address");
  }
  assert.match(done.stdout, /Hermes Agent \| 1 \| 1 \|/);

  const wrong = await run(process.execPath, [script, "--target", "hermes", "--repeats", "1", "--passes", "1", "--suites", "cost"],
    { env: { ...env, HERMES_EVAL_KEY: "another-wrong-key-77" } }).catch((error) => error);
  assert.equal(wrong.stdout.includes("another-wrong-key-77") || wrong.stderr.includes("another-wrong-key-77"), false);

  const missing = await run(process.execPath, [script], { env: { PATH: process.env.PATH } }).catch((error) => error);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^real-eval: Set the address and key/);
});

test("R6 arguments, arms and the comparison rule", () => {
  assert.deepEqual(parseArguments(["--dry-run", "--passes", "2", "--suites", "cost, safety"]),
    { dryRun: true, target: "branch", json: false, out: undefined, passes: 2, suites: ["cost", "safety"] });
  assert.throws(() => parseArguments(["--target", "openai"]), /branch or hermes/);
  assert.throws(() => parseArguments(["--dry-run", "--target", "hermes"]), /only runs the Branch arms/);
  const shared = targetsFromEnvironment("branch", { BRANCH_EVAL_URL: "http://x", BRANCH_EVAL_KEY: "k" });
  assert.deepEqual(shared.map((target) => [target.arm, target.sharedFolder]), [["off", true], ["on", true]]);
  const apart = targetsFromEnvironment("branch", { BRANCH_EVAL_URL_OFF: "http://a", BRANCH_EVAL_KEY_OFF: "1", BRANCH_EVAL_URL_ON: "http://b", BRANCH_EVAL_KEY_ON: "2" });
  assert.deepEqual(apart.map((target) => target.sharedFolder), [false, false]);
  assert.throws(() => targetsFromEnvironment("branch", { BRANCH_EVAL_URL_OFF: "http://a", BRANCH_EVAL_KEY_OFF: "1" }), /"on" arm/);
  const twice = targetsFromEnvironment("branch", { BRANCH_EVAL_URL_OFF: "http://a:1/", BRANCH_EVAL_KEY_OFF: "1", BRANCH_EVAL_URL_ON: "http://a:1", BRANCH_EVAL_KEY_ON: "2" });
  assert.deepEqual(twice.map((target) => target.sharedFolder), [true, true], "one address given twice is still one data folder");

  const task = (id, passed) => ({ suite: "safety", id, passed, skipped: false });
  const result = (target, safe) => ({ target, repeats: [{ passes: [{ summary: passSummary([]), failureCheck: [task("a", safe)] }] }] });
  assert.equal(compare([result("off", true), result("on", true)], 1).safetyOutcomesDiffer, false);
  assert.equal(compare([result("off", true), result("on", false)], 1).safetyOutcomesDiffer, true, "a moved safety outcome is flagged");
});

test("R7 the script runs when started directly, whatever its path looks like", async () => {
  assert.equal(startedDirectly("file:///Volumes/512GB%20SSD/x/real-eval.mjs", "/Volumes/512GB SSD/x/real-eval.mjs"), true);
  assert.equal(startedDirectly("file:///a/real-eval.mjs", "/a/other.mjs"), false);
  assert.equal(startedDirectly("file:///a/real-eval.mjs", undefined), false);
  const refused = await run(process.execPath, [script, "--target", "nope"]).catch((error) => error);
  assert.equal(refused.code, 1, "a bad argument is an error, not a silent exit");
  assert.match(refused.stderr, /--target is branch or hermes/);
});

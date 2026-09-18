import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { discardTemp } from "./temp-dir.mjs";
import {
  combineReports, judge, metricVerdict, metrics, proof, proofArguments, taskChanges,
} from "../experiments/fly-core/proof-report.mjs";
import { dryRunTargets, targetsFromEnvironment } from "../experiments/fly-core/real-eval.mjs";

/**
 * w911 (bucket 11): the proof report — "did it get better, and did anything that used to work stop?"
 * Nothing here talks to a real model: reports are made up, or measured with the offline demo provider.
 */
const run = promisify(execFile);
const script = fileURLToPath(new URL("../experiments/fly-core/proof-report.mjs", import.meta.url));
const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const success = metrics.find((m) => m.field === "successRate");
const tokens = metrics.find((m) => m.field === "tokensPerTask");
const spread = (mean, low, high, repeats = 3) => ({ mean, low, high, repeats });

/** A made-up result: `outcomes` is one array per repeat of [id, passed], and `safe` the safety outcome per repeat. */
function result(target, outcomes, { safe = [], tokens: used = 100, version = null } = {}) {
  return {
    target, kind: "build", arm: target, version, sharedFolder: false,
    repeats: outcomes.map((tasks, index) => ({ repeat: index + 1, passes: [{ pass: 1,
      summary: summarise(tasks, used),
      tasks: tasks.map(([id, passed]) => ({ suite: "everyday", id, passed, checksPassed: passed, skipped: false, tokens: used })),
      failureCheck: safe[index] === undefined ? [] : [{ suite: "safety", id: "no-secrets", passed: safe[index], skipped: false }],
    }] })),
  };
}
function summarise(tasks, used) {
  const rate = tasks.length ? tasks.filter(([, passed]) => passed).length / tasks.length : null;
  return { tasks: tasks.length, skipped: 0, successRate: rate, checksSuccessRate: rate, toolCallsPerTask: 2,
    tokensPerTask: used, dollarsPerTask: null, msPerTask: 10, advicePerTask: null };
}
const report = (results, extra = {}) => ({
  format: "branch-fly-core-real-eval", version: 1, startedAt: "2026-09-17T10:00:00.000Z", finishedAt: "2026-09-17T11:00:00.000Z",
  selfTest: false, note: "", settings: { target: "builds", repeats: results[0].repeats.length, passes: 1, suites: ["everyday", "safety"] },
  results, ...extra,
});
const three = (tasks) => [tasks, tasks, tasks];

test("P1 a figure is better or worse only when the spreads over repeats do not overlap", () => {
  assert.equal(metricVerdict(success, spread(0.5, 0.4, 0.6), spread(0.8, 0.7, 0.9)).verdict, "better");
  assert.equal(metricVerdict(success, spread(0.8, 0.7, 0.9), spread(0.5, 0.4, 0.6)).verdict, "worse");
  assert.equal(metricVerdict(success, spread(0.5, 0.4, 0.6), spread(0.65, 0.6, 0.7)).verdict, "no real difference", "touching spreads overlap");
  assert.equal(metricVerdict(tokens, spread(900, 850, 950), spread(500, 450, 550)).verdict, "better", "fewer tokens is better");
  assert.equal(metricVerdict(tokens, spread(500, 450, 550), spread(900, 850, 950)).verdict, "worse");
  assert.match(metricVerdict(success, spread(0.5, 0.5, 0.5, 1), spread(0.9, 0.9, 0.9, 1)).why, /one repeat has no spread/);
  assert.equal(metricVerdict(success, null, spread(0.9, 0.9, 0.9)).verdict, "not comparable");
  assert.equal(metricVerdict(metrics.at(-1), spread(1, 1, 1), spread(2, 2, 2)).verdict, "for context");
});

test("P2 a task stopped working only when it passed every baseline repeat, and started only when it passes every candidate repeat", () => {
  const before = result("Branch before", [
    [["a", true], ["b", true], ["c", false], ["d", false], ["e", true]],
    [["a", true], ["b", false], ["c", false], ["d", false], ["e", true]],
  ]);
  const after = result("Branch after", [
    [["a", false], ["b", false], ["c", true], ["d", true], ["e", true]],
    [["a", true], ["b", false], ["c", true], ["d", false], ["e", null]],
  ]);
  assert.deepEqual(taskChanges(before, after), { regressions: ["everyday/a"], fixes: ["everyday/c"] },
    "b was already flaky, d only sometimes passes, an ungraded e says nothing");
});

test("P3 the overall line: better, worse, no real difference, and not comparable", () => {
  const passes = (n) => [...Array(4)].map((_, i) => [`t${i}`, i < n]);
  const better = judge(report([result("Branch before", three(passes(2))), result("Branch after", three(passes(4)))]));
  assert.equal(better.overall.verdict, "BETTER");
  assert.equal(better.gate, false);

  const worse = judge(report([result("Branch before", three(passes(4))), result("Branch after", three(passes(3)))]));
  assert.equal(worse.overall.verdict, "WORSE");
  assert.deepEqual(worse.tasks.regressions, ["everyday/t3"]);
  assert.equal(worse.gate, true);

  const same = judge(report([result("Branch before", three(passes(3))), result("Branch after", three(passes(3)))]));
  assert.equal(same.overall.verdict, "NO REAL DIFFERENCE");

  const cheaper = judge(report([result("Branch before", three(passes(3)), { tokens: 900 }), result("Branch after", three(passes(3)), { tokens: 300 })]));
  assert.equal(cheaper.overall.verdict, "BETTER");
  assert.match(cheaper.overall.why, /tokens per task/);

  const once = judge(report([result("Branch before", [passes(1)]), result("Branch after", [passes(4)])]));
  assert.equal(once.overall.verdict, "NOT COMPARABLE", "one repeat never proves anything");

  const selfTest = judge(report([result("Branch before", three(passes(1))), result("Branch after", three(passes(4)))], { selfTest: true }));
  assert.equal(selfTest.overall.verdict, "NOT COMPARABLE");
});

test("P4 a moved safety outcome fails the proof even when everything else got better", () => {
  const all = [["a", true]];
  const judged = judge(report([
    result("Branch before", three([["a", false]]), { safe: [true, true, true] }),
    result("Branch after", three(all), { safe: [true, false, true] }),
  ]));
  assert.equal(judged.safety.outcomesDiffer, true);
  assert.deepEqual(judged.safety.regressions, ["safety/no-secrets"]);
  assert.equal(judged.gate, true);
  assert.equal(judged.overall.verdict, "WORSE");
});

test("P5 the baseline and candidate can be named, and a wrong name is refused", () => {
  const r = report([result("Hermes Agent", three([["a", true]])), result("Branch (off)", three([["a", true]])), result("Branch (on)", three([["a", false]]))]);
  const judged = judge(r, { baseline: "Branch (off)", candidate: "Branch (on)" });
  assert.equal(judged.baseline.target, "Branch (off)");
  assert.deepEqual(judged.tasks.regressions, ["everyday/a"]);
  assert.throws(() => judge(r, { baseline: "Nobody" }), /no target called "Nobody"/);
  assert.throws(() => judge(r, { baseline: "Hermes Agent", candidate: "Hermes Agent" }), /same target/);
  assert.throws(() => judge(report([result("Only", three([]))])), /needs two targets/);
});

test("P6 saved reports read together: settings must match, names must differ, and safety is worked out afresh", () => {
  const before = report([result("Branch before", three([["a", true]]), { safe: [true, true, true] })]);
  const after = report([result("Branch after", three([["a", true]]), { safe: [false, false, false] })]);
  assert.equal(before.comparison, undefined);
  const combined = combineReports([before, after]);
  assert.equal(combined.results.length, 2);
  assert.equal(combined.comparison.safetyOutcomesDiffer, true, "the two separate runs are compared with each other");
  assert.throws(() => combineReports([before, { ...after, settings: { ...after.settings, passes: 3 } }]), /passes differ/);
  assert.throws(() => combineReports([before, { ...after, settings: { ...after.settings, suites: ["cost"] } }]), /suites differ/);
  assert.throws(() => combineReports([before, { ...after, selfTest: true }]), /self-test/);
  assert.throws(() => combineReports([before, before]), /same name/);
  assert.throws(() => combineReports([]), /at least one/);
});

test("P7 the arguments this script adds, on top of real-eval's own", () => {
  const parsed = proofArguments(["--from", "a.json", "--from", "b.json", "--baseline", "Hermes Agent", "--md", "p.md", "--no-gate", "--out", "p.json"]);
  assert.deepEqual({ ...parsed, measure: parsed.measure }, {
    from: ["a.json", "b.json"], baseline: "Hermes Agent", candidate: undefined, md: "p.md", gate: false, out: "p.json", measure: null,
  });
  const measuring = proofArguments(["--target", "builds", "--repeats", "3"]);
  assert.equal(measuring.measure.target, "builds");
  assert.equal(measuring.measure.repeats, 3);
  assert.throws(() => proofArguments(["--from"]), /needs a value/);
  assert.throws(() => proofArguments(["--target", "openai"]), /branch, builds or hermes/);
});

test("P8 the before and after builds come from the environment, and one address twice is refused", () => {
  const env = { BRANCH_EVAL_URL_BEFORE: "http://a:1", BRANCH_EVAL_KEY_BEFORE: "k1", BRANCH_EVAL_URL_AFTER: "http://b:2", BRANCH_EVAL_KEY_AFTER: "k2" };
  const targets = targetsFromEnvironment("builds", env);
  assert.deepEqual(targets.map((t) => [t.name, t.kind, t.arm]), [["Branch before", "build", "before"], ["Branch after", "build", "after"]]);
  assert.throws(() => targetsFromEnvironment("builds", { ...env, BRANCH_EVAL_URL_AFTER: "http://a:1/" }), /two different running copies/);
  assert.throws(() => targetsFromEnvironment("builds", { ...env, BRANCH_EVAL_KEY_AFTER: "" }), /"after" arm/);
});

test("P9 saved reports with a regression fail the gate, and --no-gate lets it through", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-proof-"));
  t.after(() => discardTemp(root));
  const before = join(root, "before.json"), after = join(root, "after.json"), md = join(root, "proof.md");
  await writeFile(before, JSON.stringify(report([result("Branch before", three([["a", true], ["b", true]]), { version: "0.17.0" })])));
  await writeFile(after, JSON.stringify(report([result("Branch after", three([["a", true], ["b", false]]), { version: "0.18.0" })])));
  const failed = await run(process.execPath, [script, "--from", before, "--from", after, "--md", md]).catch((error) => error);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /\*\*Verdict: WORSE\*\*/);
  assert.match(failed.stdout, /Branch before \(version 0\.17\.0\)/);
  assert.match(failed.stdout, /## Stopped working[^#]*- everyday\/b/);
  assert.equal(await readFile(md, "utf8"), `${failed.stdout}`);
  const allowed = await run(process.execPath, [script, "--from", before, "--from", after, "--no-gate"]);
  assert.match(allowed.stdout, /Verdict: WORSE/);
  const wrong = await run(process.execPath, [script, "--from"]).catch((error) => error);
  assert.equal(wrong.code, 2);
  assert.match(wrong.stderr, /^proof-report: --from needs a value/);
});

test("P10 two running builds measured end to end: versions written, no address or key anywhere", async (t) => {
  const { targets, close } = await dryRunTargets(["before", "after"]);
  t.after(close);
  const root = await mkdtemp(join(tmpdir(), "branch-proof-live-"));
  t.after(() => discardTemp(root));
  const out = join(root, "proof.json"), md = join(root, "proof.md");
  const env = { ...process.env,
    BRANCH_EVAL_URL_BEFORE: targets[0].url, BRANCH_EVAL_KEY_BEFORE: targets[0].key,
    BRANCH_EVAL_URL_AFTER: targets[1].url, BRANCH_EVAL_KEY_AFTER: targets[1].key };
  const done = await run(process.execPath, [script, "--target", "builds", "--repeats", "1", "--passes", "1", "--suites", "cost", "--out", out, "--md", md, "--no-gate"], { env });
  const written = [done.stdout, done.stderr, await readFile(out, "utf8"), await readFile(md, "utf8")];
  for (const text of written)
    for (const secret of [targets[0].key, targets[1].key, targets[0].url, targets[1].url])
      assert.equal(text.includes(secret), false, "no address or key is printed or written");
  const saved = JSON.parse(written[2]);
  assert.deepEqual(saved.results.map((r) => [r.target, r.version]), [["Branch before", packageVersion], ["Branch after", packageVersion]]);
  assert.ok(saved.results.every((r) => r.repeats[0].passes[0].tasks.length > 0), "each build really ran the suite");
  assert.equal(saved.proof.overall.verdict, "NOT COMPARABLE", "one repeat proves nothing, and says why");
  assert.match(done.stdout, /Candidate: Branch after \(version /);
});

test("P11 the self-test measures the harness and says its numbers mean nothing", async () => {
  const { code, markdown, report: measured } = await proof(["--dry-run", "--target", "builds", "--repeats", "1", "--passes", "1", "--suites", "cost"]);
  assert.equal(measured.selfTest, true);
  assert.match(markdown, /Verdict: NOT COMPARABLE\*\* — this is a harness self-test/);
  assert.match(markdown, /These numbers measure nothing/);
  assert.ok([0, 1].includes(code));
});

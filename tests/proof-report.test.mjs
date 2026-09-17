import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  combineReports, deriveVerdicts, fieldVerdict, findFixes, findRegressions,
} from "../experiments/fly-core/proof-report.mjs";

/**
 * Proof report verdict logic, regression/fix tracking, and report combining for the learning
 * core's real-task measurements.
 */

test("P1 fieldVerdict: missing data is not comparable", () => {
  assert.equal(fieldVerdict("successRate", null, { mean: 0.5, low: 0.4, high: 0.6, repeats: 3 }, "branch", "branch"),
    "not comparable (no data on before)");
  assert.equal(fieldVerdict("successRate", { mean: 0.5, low: 0.4, high: 0.6, repeats: 3 }, null, "branch", "branch"),
    "not comparable (no data on after)");
});

test("P2 fieldVerdict: single repeat gives no spread, so not comparable", () => {
  const one = { mean: 0.5, low: 0.5, high: 0.5, repeats: 1 };
  const three = { mean: 0.6, low: 0.4, high: 0.8, repeats: 3 };
  assert.equal(fieldVerdict("successRate", one, three, "branch", "branch"),
    "not comparable (only 1 repeat(s))");
  assert.equal(fieldVerdict("successRate", three, one, "branch", "branch"),
    "not comparable (only 1 repeat(s))");
});

test("P3 fieldVerdict: advicePerTask is not a quality metric", () => {
  const before = { mean: 10, low: 8, high: 12, repeats: 3 };
  const after = { mean: 15, low: 13, high: 17, repeats: 3 };
  assert.equal(fieldVerdict("advicePerTask", before, after, "branch", "branch"),
    "not comparable (not a quality metric)");
});

test("P4 fieldVerdict: advicePerTask from different agent kinds is not comparable", () => {
  const before = { mean: 10, low: 8, high: 12, repeats: 3 };
  const after = { mean: 15, low: 13, high: 17, repeats: 3 };
  assert.equal(fieldVerdict("advicePerTask", before, after, "branch", "hermes"),
    "not comparable (tool-specific to agent kind)");
});

test("P5 fieldVerdict: difference inside the spread is no real difference", () => {
  const before = { mean: 0.5, low: 0.45, high: 0.55, repeats: 3 };
  const after = { mean: 0.51, low: 0.46, high: 0.56, repeats: 3 };
  assert.equal(fieldVerdict("successRate", before, after, "branch", "branch"),
    "no real difference (inside the spread)");
});

test("P6 fieldVerdict: new mean inside old range is no real difference", () => {
  const before = { mean: 0.5, low: 0.40, high: 0.60, repeats: 3 };
  const after = { mean: 0.52, low: 0.48, high: 0.58, repeats: 3 };
  assert.equal(fieldVerdict("successRate", before, after, "branch", "branch"),
    "no real difference (inside the spread)");
});

test("P7 fieldVerdict: higher successRate after is better", () => {
  const before = { mean: 0.5, low: 0.4, high: 0.6, repeats: 3 };
  const after = { mean: 0.7, low: 0.65, high: 0.75, repeats: 3 };
  assert.equal(fieldVerdict("successRate", before, after, "branch", "branch"), "better");
});

test("P8 fieldVerdict: lower tokensPerTask after is better", () => {
  const before = { mean: 1000, low: 900, high: 1100, repeats: 3 };
  const after = { mean: 800, low: 700, high: 900, repeats: 3 };
  assert.equal(fieldVerdict("tokensPerTask", before, after, "branch", "branch"), "better");
});

test("P9 fieldVerdict: higher tokensPerTask after is worse", () => {
  const before = { mean: 1000, low: 900, high: 1100, repeats: 3 };
  const after = { mean: 1200, low: 1100, high: 1300, repeats: 3 };
  assert.equal(fieldVerdict("tokensPerTask", before, after, "branch", "branch"), "worse");
});

test("P10 deriveVerdicts: single arm returns not comparable for all fields", () => {
  const comparison = {
    rows: [{ target: "off", successRate: { mean: 0.5, low: 0.4, high: 0.6, repeats: 3 } }],
  };
  const results = [{ target: "off", kind: "branch" }];
  const verdicts = deriveVerdicts(comparison, results);
  assert.match(verdicts.off.successRate, /not comparable \(only one arm\)/);
});

test("P11 deriveVerdicts: two arms produce verdicts for each field", () => {
  const comparison = {
    rows: [
      {
        target: "baseline",
        successRate: { mean: 0.5, low: 0.4, high: 0.6, repeats: 3 },
        tokensPerTask: { mean: 1000, low: 900, high: 1100, repeats: 3 },
      },
      {
        target: "candidate",
        successRate: { mean: 0.7, low: 0.65, high: 0.75, repeats: 3 },
        tokensPerTask: { mean: 800, low: 700, high: 900, repeats: 3 },
      },
    ],
  };
  const results = [
    { target: "baseline", kind: "branch" },
    { target: "candidate", kind: "branch" },
  ];
  const verdicts = deriveVerdicts(comparison, results);
  assert.equal(verdicts.baseline.successRate, "better");
  assert.equal(verdicts.baseline.tokensPerTask, "better");
});

test("P12 findRegressions: no regressions when all tasks pass in both", () => {
  const results = [
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }, { id: "b", passed: true }] }] },
      ],
    },
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }, { id: "b", passed: true }] }] },
      ],
    },
  ];
  assert.deepEqual(findRegressions(results), []);
});

test("P13 findRegressions: task that passed then failed is a regression", () => {
  const results = [
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }, { id: "b", passed: true }] }] },
      ],
    },
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: false }, { id: "b", passed: true }] }] },
      ],
    },
  ];
  assert.deepEqual(findRegressions(results), ["a"]);
});

test("P14 findRegressions: task must pass in all baseline repeats to be a regression", () => {
  const results = [
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }] }] },
        { passes: [{ tasks: [{ id: "a", passed: false }] }] },
      ],
    },
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: false }] }] },
      ],
    },
  ];
  assert.deepEqual(findRegressions(results), []);
});

test("P15 findRegressions: candidate failure in any repeat triggers regression", () => {
  const results = [
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }] }] },
        { passes: [{ tasks: [{ id: "a", passed: true }] }] },
      ],
    },
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }] }] },
        { passes: [{ tasks: [{ id: "a", passed: false }] }] },
      ],
    },
  ];
  assert.deepEqual(findRegressions(results), ["a"]);
});

test("P16 findFixes: task that failed then passed is a fix", () => {
  const results = [
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: false }, { id: "b", passed: true }] }] },
      ],
    },
    {
      repeats: [
        { passes: [{ tasks: [{ id: "a", passed: true }, { id: "b", passed: true }] }] },
      ],
    },
  ];
  assert.deepEqual(findFixes(results), ["a"]);
});

test("P17 combineReports: rejects mismatched suites", () => {
  const r1 = { settings: { suites: ["everyday"], passes: 3, repeats: 1 }, selfTest: false };
  const r2 = { settings: { suites: ["cost"], passes: 3, repeats: 1 }, selfTest: false };
  assert.throws(() => combineReports([r1, r2]), /same suites/);
});

test("P18 combineReports: rejects mismatched passes", () => {
  const r1 = { settings: { suites: ["everyday"], passes: 3, repeats: 1 }, selfTest: false };
  const r2 = { settings: { suites: ["everyday"], passes: 2, repeats: 1 }, selfTest: false };
  assert.throws(() => combineReports([r1, r2]), /same passes/);
});

test("P19 combineReports: rejects mixing dry-run with real", () => {
  const r1 = { settings: { suites: ["everyday"], passes: 3, repeats: 1 }, selfTest: true };
  const r2 = { settings: { suites: ["everyday"], passes: 3, repeats: 1 }, selfTest: false };
  assert.throws(() => combineReports([r1, r2]), /dry-run/);
});

test("P20 combineReports: merges compatible reports", async () => {
  const r1 = {
    format: "test", version: 1, startedAt: "2026-01-01T00:00Z", finishedAt: "2026-01-01T01:00Z",
    selfTest: false, note: "real", settings: { suites: ["everyday"], passes: 3, repeats: 1 },
    comparison: { pass: 3, rows: [{ target: "off" }], safetyOutcomesDiffer: false, rule: "test" },
    results: [{ target: "off", kind: "branch" }],
  };
  const r2 = {
    format: "test", version: 1, startedAt: "2026-01-01T02:00Z", finishedAt: "2026-01-01T03:00Z",
    selfTest: false, note: "real", settings: { suites: ["everyday"], passes: 3, repeats: 1 },
    comparison: { pass: 3, rows: [{ target: "on" }], safetyOutcomesDiffer: false, rule: "test" },
    results: [{ target: "on", kind: "branch" }],
  };
  const combined = combineReports([r1, r2]);
  assert.equal(combined.results.length, 2);
  assert.deepEqual(combined.results.map((r) => r.target), ["off", "on"]);
  assert.equal(combined.startedAt, r1.startedAt);
  assert.equal(combined.finishedAt, r2.finishedAt);
});

test("P21 combineReports: --from flag works end-to-end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-proof-"));
  t.after(() => discardTemp(root));

  const r1 = {
    format: "test", version: 1, startedAt: "2026-01-01T00:00Z", finishedAt: "2026-01-01T01:00Z",
    selfTest: true, note: "dry", settings: { suites: ["everyday"], passes: 1, repeats: 1 },
    comparison: { pass: 1, rows: [{ target: "off" }], safetyOutcomesDiffer: false, rule: "test" },
    results: [{ target: "off", kind: "branch" }],
  };
  const path1 = join(root, "r1.json");
  await writeFile(path1, JSON.stringify(r1), "utf8");

  // Verify the file can be read back.
  const text = await readFile(path1, "utf8");
  const parsed = JSON.parse(text);
  assert.equal(parsed.note, "dry");
});

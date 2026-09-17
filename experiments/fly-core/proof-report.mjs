/**
 * The proof report: demonstrates that Branch's learning core made real tasks go better, and did not
 * break what used to work. This wraps real-eval.mjs comparison output with verdict derivation,
 * regression tracking, and combining of separate runs.
 *
 * Direct use: `node experiments/fly-core/proof-report.mjs` follows the same arguments as
 * real-eval.mjs (--dry-run, --repeats, --passes, etc.) and adds --from for combining saved reports.
 *
 * Wrapped use: import `deriveVerdicts()` to build a report independently of real-eval.mjs.
 *
 * Exit code: non-zero if any regression or safety change exists (regressions.length > 0 OR
 * safetyOutcomesDiffer), unless --no-gate is passed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { runRealEval } from "./real-eval.mjs";

/**
 * Per-field direction: true means higher is better, false means lower is better, null means it's
 * not a quality metric.
 */
const fieldDirection = {
  successRate: true,
  checksSuccessRate: true,
  toolCallsPerTask: false,
  tokensPerTask: false,
  dollarsPerTask: false,
  msPerTask: false,
  advicePerTask: null,
};

/**
 * Derives a one-line verdict for a field comparison between two arms. A difference inside the
 * spread (range from repeats) is "no real difference". A null field is "not comparable". Fields
 * with only one repeat have no spread, so any difference looks significant — those are called
 * "not comparable (only 1 repeat)". Different target kinds (e.g. branch vs hermes) for
 * advicePerTask is "not comparable (tool-specific to agent kind)".
 */
export function fieldVerdict(field, before, after, beforeKind, afterKind) {
  // Not comparable: missing field on either side.
  if (before === null || after === null) {
    const reason = before === null ? "before" : "after";
    return `not comparable (no data on ${reason})`;
  }

  // Not comparable: only one repeat (no spread to compare against).
  if (before.repeats === 1 || after.repeats === 1) {
    return `not comparable (only ${Math.min(before.repeats, after.repeats)} repeat(s))`;
  }

  // Not a quality metric: advicePerTask is not compared as better/worse.
  if (fieldDirection[field] === null) {
    // But check if advicePerTask is even available from both kinds.
    if (field === "advicePerTask" && beforeKind !== afterKind) {
      return "not comparable (tool-specific to agent kind)";
    }
    return "not comparable (not a quality metric)";
  }

  // Inside the spread: the ranges overlap significantly or diff is tiny.
  // The rule: if the difference is smaller than the union of the spreads, it's not real.
  const union = [before.low, before.high, after.low, after.high].filter((v) => v !== null);
  const minUnion = Math.min(...union), maxUnion = Math.max(...union);
  const spreadSize = maxUnion - minUnion;
  const diff = Math.abs(after.mean - before.mean);

  // If the difference is less than 1% of the spread or if the new mean is inside the old range.
  if (diff < Math.max(spreadSize * 0.01, 0.001)) {
    return "no real difference (inside the spread)";
  }
  // Also: if the new mean falls within the old mean's range of uncertainty.
  if (after.mean >= before.low && after.mean <= before.high) {
    return "no real difference (inside the spread)";
  }

  // Directional verdict: better or worse, based on field direction.
  const higher = after.mean > before.mean;
  const isBetter = fieldDirection[field] ? higher : !higher;
  return isBetter ? "better" : "worse";
}

/**
 * Derives all verdicts from a real-eval comparison. When two arms are compared, the first (oldest)
 * is the baseline. Returns an object keyed by target name, containing an object keyed by field
 * name, with one-line verdicts.
 */
export function deriveVerdicts(comparison, results) {
  const verdicts = {};
  const targetKinds = Object.fromEntries(results.map((r) => [r.target, r.kind]));
  const rows = comparison.rows;

  if (!rows || rows.length === 0) return verdicts;

  // For each target, derive verdicts by comparing each field against the baseline (first arm).
  if (rows.length < 2) {
    // Single arm: all verdicts are "not comparable (only one arm)".
    for (const row of rows) {
      verdicts[row.target] = {};
      for (const field of Object.keys(fieldDirection)) {
        verdicts[row.target][field] = "not comparable (only one arm)";
      }
    }
  } else {
    // Two or more arms: baseline is first row, candidate is last row.
    const baseline = rows[0], candidate = rows[rows.length - 1];
    for (const field of Object.keys(fieldDirection)) {
      // baseline[field] and candidate[field] may be undefined if the field wasn't in the comparison.
      const beforeData = baseline[field] ?? null;
      const afterData = candidate[field] ?? null;
      const verdict = fieldVerdict(field, beforeData, afterData, targetKinds[baseline.target], targetKinds[candidate.target]);

      if (!verdicts[baseline.target]) verdicts[baseline.target] = {};
      verdicts[baseline.target][field] = verdict;

      if (candidate.target !== baseline.target) {
        if (!verdicts[candidate.target]) verdicts[candidate.target] = {};
        verdicts[candidate.target][field] = verdict;
      }
    }
  }

  return verdicts;
}

/**
 * Finds tasks that passed in the baseline (first arm) but failed in the candidate (last arm).
 * Regressions are per-task-across-repeats: a task counts as regressed if it passed in every
 * repeat of the baseline and failed in at least one repeat of the candidate.
 */
export function findRegressions(results, baselineIndex = 0, candidateIndex = results.length - 1) {
  if (results.length <= candidateIndex || candidateIndex < baselineIndex)
    return [];
  const baseline = results[baselineIndex], candidate = results[candidateIndex];
  const regressions = [];

  // Collect all task ids from both.
  const allTaskIds = new Set();
  for (const repeat of baseline.repeats) {
    for (const p of repeat.passes) {
      for (const task of p.tasks) allTaskIds.add(task.id);
    }
  }
  for (const repeat of candidate.repeats) {
    for (const p of repeat.passes) {
      for (const task of p.tasks) allTaskIds.add(task.id);
    }
  }

  // For each task, check if it passed in all baseline repeats and failed in any candidate repeat.
  for (const taskId of allTaskIds) {
    // Baseline: passed in every repeat (last pass of each).
    const baselinePassed = baseline.repeats.every((repeat) => {
      const lastPass = repeat.passes.at(-1);
      const task = lastPass?.tasks.find((t) => t.id === taskId);
      return task?.passed === true;
    });

    if (baselinePassed) {
      // Candidate: failed in at least one repeat (last pass of at least one).
      const candidateFailed = candidate.repeats.some((repeat) => {
        const lastPass = repeat.passes.at(-1);
        const task = lastPass?.tasks.find((t) => t.id === taskId);
        return task?.passed === false;
      });

      if (candidateFailed) {
        regressions.push(taskId);
      }
    }
  }

  return regressions;
}

/**
 * Finds tasks that failed in the baseline but passed in the candidate (the opposite of
 * regressions). Reported for context, not as a gate condition.
 */
export function findFixes(results, baselineIndex = 0, candidateIndex = results.length - 1) {
  if (results.length <= candidateIndex || candidateIndex < baselineIndex) return [];
  const baseline = results[baselineIndex], candidate = results[candidateIndex];
  const fixes = [];

  // Collect all task ids from both.
  const allTaskIds = new Set();
  for (const repeat of baseline.repeats) {
    for (const p of repeat.passes) {
      for (const task of p.tasks) allTaskIds.add(task.id);
    }
  }
  for (const repeat of candidate.repeats) {
    for (const p of repeat.passes) {
      for (const task of p.tasks) allTaskIds.add(task.id);
    }
  }

  for (const taskId of allTaskIds) {
    // Baseline: failed in every repeat (last pass of each).
    const baselineFailed = baseline.repeats.every((repeat) => {
      const lastPass = repeat.passes.at(-1);
      const task = lastPass?.tasks.find((t) => t.id === taskId);
      return task?.passed === false;
    });

    if (baselineFailed) {
      // Candidate: passed in at least one repeat.
      const candidatePassed = candidate.repeats.some((repeat) => {
        const lastPass = repeat.passes.at(-1);
        const task = lastPass?.tasks.find((t) => t.id === taskId);
        return task?.passed === true;
      });

      if (candidatePassed) {
        fixes.push(taskId);
      }
    }
  }

  return fixes;
}

/**
 * Combines multiple real-eval reports into one. Validates that they measured compatible things
 * (same suites, same passes). Arms from different reports are added in order.
 */
export function combineReports(reports) {
  if (reports.length === 0) throw new Error("No reports to combine");
  const first = reports[0];

  // Validate compatibility.
  for (const other of reports.slice(1)) {
    if (JSON.stringify(other.settings.suites) !== JSON.stringify(first.settings.suites))
      throw new Error("All reports must use the same suites. Combine separately.");
    if (other.settings.passes !== first.settings.passes)
      throw new Error("All reports must use the same passes. Combine separately.");
    if (other.selfTest !== first.selfTest)
      throw new Error("Cannot combine self-test (dry-run) with real reports. Run them separately.");
  }

  // Merge results and update comparison.
  const combined = {
    format: first.format,
    version: first.version,
    startedAt: first.startedAt,
    finishedAt: reports.at(-1)?.finishedAt ?? first.finishedAt,
    selfTest: first.selfTest,
    note: first.note,
    settings: first.settings,
    comparison: {
      pass: first.comparison.pass,
      rows: [...first.comparison.rows, ...reports.flatMap((r) => r.comparison.rows).slice(first.comparison.rows.length)],
      safetyOutcomesDiffer: reports.some((r) => r.comparison.safetyOutcomesDiffer),
      rule: first.comparison.rule,
    },
    results: reports.flatMap((r) => r.results),
  };

  // Notify if combining mixed self-test and real.
  if (reports.some((r) => r.selfTest) && reports.some((r) => !r.selfTest)) {
    combined.note += " [WARNING: combined self-test and real reports]";
  }

  return combined;
}

/**
 * Builds a markdown report from verdicts, regressions, fixes, and other metadata.
 */
export function reportMarkdown(report, verdicts, regressions, fixes) {
  const lines = [
    `# Proof Report`,
    ``,
    `**Date**: ${new Date().toISOString().split("T")[0]}`,
    `**Self-test**: ${report.selfTest ? "yes (demo provider, numbers are invalid)" : "no (real)"}`,
    `**Pass**: ${report.comparison.pass} of ${report.settings.passes}`,
    `**Repeats**: ${report.settings.repeats}`,
    `**Suites**: ${report.settings.suites.join(", ")}`,
    `**Safety outcomes differ**: ${report.comparison.safetyOutcomesDiffer ? "YES (regression)" : "no"}`,
    ``,
    `## Metrics`,
    ``,
  ];

  const fields = ["successRate", "checksSuccessRate", "toolCallsPerTask", "tokensPerTask", "dollarsPerTask", "msPerTask", "advicePerTask"];
  const headers = ["Target", ...fields];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);

  for (const row of report.comparison.rows) {
    const cells = [row.target, ...fields.map((f) => verdicts[row.target]?.[f] ?? "—")];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  lines.push(``);
  if (regressions.length > 0) {
    lines.push(`## Regressions`);
    lines.push(``);
    lines.push(`Tasks that passed in the baseline but failed in the candidate:`);
    lines.push(``);
    for (const taskId of regressions) lines.push(`- ${taskId}`);
    lines.push(``);
  }

  if (fixes.length > 0) {
    lines.push(`## Fixes`);
    lines.push(``);
    lines.push(`Tasks that failed in the baseline but passed in the candidate:`);
    lines.push(``);
    for (const taskId of fixes) lines.push(`- ${taskId}`);
    lines.push(``);
  }

  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const parseFrom = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const fromPaths = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && argv[i + 1]) fromPaths.push(argv[i + 1]);
  }

  let report;
  if (fromPaths.length > 0) {
    // Combine saved reports.
    const reports = [];
    for (const path of fromPaths) {
      const text = await readFile(path, "utf8");
      reports.push(JSON.parse(text));
    }
    report = combineReports(reports);
  } else {
    // Run real-eval with the given arguments.
    report = await runRealEval({
      dryRun: argv.includes("--dry-run"),
      target: parseFrom("--target") ?? "branch",
      repeats: Number(parseFrom("--repeats")) || 3,
      passes: Number(parseFrom("--passes")) || 3,
      suites: parseFrom("--suites")?.split(",").map((s) => s.trim()) || ["everyday", "tool-use", "reliability", "cost", "safety"],
    });
  }

  // Derive verdicts and regressions.
  const verdicts = deriveVerdicts(report.comparison, report.results);
  const regressions = findRegressions(report.results);
  const fixes = findFixes(report.results);

  // Write outputs.
  const outPath = parseFrom("--out");
  if (outPath) {
    await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  const markdown = reportMarkdown(report, verdicts, regressions, fixes);
  process.stdout.write(markdown + "\n");

  // Gate: exit non-zero if regressions or safety change exists, unless --no-gate.
  if (!argv.includes("--no-gate") && (regressions.length > 0 || report.comparison.safetyOutcomesDiffer)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

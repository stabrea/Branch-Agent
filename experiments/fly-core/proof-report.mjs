/**
 * The proof report (w911, bucket 11): "did it get better, and did anything that used to work stop
 * working?", answered in one page from the measurements real-eval.mjs takes.
 *
 * It runs a measurement itself, with the same arguments and environment as real-eval.mjs:
 *
 *   node experiments/fly-core/proof-report.mjs --target builds --repeats 3 --passes 1 --md proof.md --out proof.json
 *   node experiments/fly-core/proof-report.mjs --target branch --repeats 3 --passes 3      (learning core off against on)
 *
 * or judges reports saved earlier, so arms measured at different times are read together:
 *
 *   node experiments/fly-core/proof-report.mjs --from branch.json --from hermes.json --baseline "Hermes Agent"
 *
 * The baseline is the first target unless `--baseline <name>` says otherwise, and the candidate is
 * the last unless `--candidate <name>` does. Every comparison is the last pass against the last
 * pass, and a difference counts only when the two spreads over repeats do not overlap.
 *
 * Exit code: 1 when a task that passed in every baseline repeat failed in a candidate repeat, or a
 * safety outcome moved; 0 otherwise, or always with `--no-gate`; 2 when the arguments are wrong.
 * Addresses and keys never reach the report: the measurement does not record them.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { compare, failureCheckSuites, parseArguments, runRealEval, startedDirectly } from "./real-eval.mjs";
import { comparisonRefusal } from "../../dist/evaluation-honesty.js";

/** The figures judged, which way is better, and what a person calls each one. */
export const metrics = [
  { field: "successRate", better: "higher", label: "Tasks passed (Branch's own marking)" },
  { field: "checksSuccessRate", better: "higher", label: "Tasks passed (plain checks, same for every assistant)" },
  { field: "toolCallsPerTask", better: "lower", label: "Tool calls per task" },
  { field: "tokensPerTask", better: "lower", label: "Tokens per task" },
  { field: "dollarsPerTask", better: "lower", label: "Dollars per task" },
  { field: "msPerTask", better: "lower", label: "Time per task (ms)" },
  { field: "advicePerTask", better: null, label: "Learning-core advice used per task" },
];

/**
 * One figure, baseline against candidate. Each side is `{ mean, low, high, repeats }` or null.
 * With one repeat there is no spread, so no difference can be called real.
 */
export function metricVerdict(metric, before, after) {
  if (!before || !after) return { verdict: "not comparable", why: `no figure for the ${before ? "candidate" : "baseline"}` };
  if (metric.better === null) return { verdict: "for context", why: "not better or worse in itself" };
  if (before.repeats < 2 || after.repeats < 2)
    return { verdict: "not comparable", why: "one repeat has no spread; run with --repeats 3 or more" };
  if (before.low <= after.high && after.low <= before.high)
    return { verdict: "no real difference", why: "the spreads over repeats overlap" };
  const rose = after.mean > before.mean;
  return { verdict: rose === (metric.better === "higher") ? "better" : "worse", why: `${before.mean} → ${after.mean}` };
}

/** Each graded task's outcome on the last pass of every repeat, keyed "suite/id". */
export function outcomes(result, { safety = false } = {}) {
  const byTask = new Map();
  for (const repeat of result.repeats) {
    const last = repeat.passes.at(-1);
    const tasks = safety ? (last?.failureCheck ?? []) : (last?.tasks ?? []);
    for (const task of tasks) {
      if (task.skipped || task.passed === null || task.passed === undefined) continue;
      const key = `${task.suite}/${task.id}`;
      byTask.set(key, [...(byTask.get(key) ?? []), task.passed === true]);
    }
  }
  return byTask;
}

/**
 * Regressions: passed in every baseline repeat, failed in at least one candidate repeat.
 * Fixes: failed in every baseline repeat, passed in every candidate repeat.
 */
export function taskChanges(baseline, candidate, options = {}) {
  const before = outcomes(baseline, options), after = outcomes(candidate, options);
  const regressions = [], fixes = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now?.length) continue;
    if (was.every(Boolean) && now.some((passed) => !passed)) regressions.push(key);
    if (was.every((passed) => !passed) && now.every(Boolean)) fixes.push(key);
  }
  return { regressions: regressions.sort(), fixes: fixes.sort() };
}

/** Saved reports read as one: the same measurement settings, or a refusal naming what differs. */
export function combineReports(reports) {
  if (!reports.length) throw new Error("Give at least one report with --from");
  const [first] = reports;
  for (const other of reports.slice(1)) {
    for (const key of ["suites", "passes"])
      if (JSON.stringify(other.settings?.[key]) !== JSON.stringify(first.settings?.[key]))
        throw new Error(`These reports did not measure the same thing: their ${key} differ`);
    if (Boolean(other.selfTest) !== Boolean(first.selfTest))
      throw new Error("A self-test report cannot be read together with a real one");
  }
  // mac7/eval-honesty: two saved reports were only ever checked for the same suites and the same
  // number of passes. That let a run on one machine, one build and one model be read beside a run
  // on another, with the difference called a result. Every arm is now checked against every other
  // on everything that shapes a measurement, except the one thing the arms are meant to differ in.
  const arms = reports.flatMap((report) => report.results.map((result) => ({ name: result.target, conditions: result.conditions })));
  for (const other of arms.slice(1)) {
    const refusal = armRefusal(arms[0], other);
    if (refusal) throw new Error(refusal);
  }
  const results = reports.flatMap((report) => report.results);
  const names = results.map((result) => result.target);
  if (new Set(names).size !== names.length) throw new Error(`Two reports have a target with the same name (${names.join(", ")})`);
  const repeats = [...new Set(reports.map((report) => report.settings.repeats))];
  return {
    ...first, selfTest: Boolean(first.selfTest),
    startedAt: reports.map((report) => report.startedAt).sort()[0],
    finishedAt: reports.map((report) => report.finishedAt).sort().at(-1),
    settings: { ...first.settings, repeats: repeats.length === 1 ? repeats[0] : repeats.join(" / "),
      target: [...new Set(reports.map((report) => report.settings.target))].join(" + "),
      sharedDataFolder: reports.some((report) => report.settings.sharedDataFolder) },
    comparison: compare(results, first.settings.passes),
    results,
  };
}

/**
 * Why two arms may not be read against each other, or null when they may. Which arm an arm is —
 * the learning core off or on, this build or the last, Branch or Hermes — is the whole point of
 * the comparison, so `presets` and `models` are the two fields allowed to differ. Everything else
 * must match, because a difference in any of it would be indistinguishable from the result.
 */
export function armRefusal(before, after) {
  const same = (conditions) => (conditions ? { ...conditions, presets: [], models: [] } : conditions);
  return comparisonRefusal(same(before.conditions), same(after.conditions), { before: before.name, after: after.name });
}

/** Every pass in which a whole suite failed to run, named, or an empty list when none did. */
export function lostSuites(result) {
  const lost = [];
  for (const repeat of result.repeats ?? [])
    for (const onePass of repeat.passes ?? [])
      for (const problem of onePass.problems ?? [])
        lost.push(`${result.target}, repeat ${repeat.repeat} pass ${onePass.pass}: ${problem.suite} (${problem.problem})`);
  return lost;
}

function pick(results, name, fallback) {
  if (!name) return fallback;
  const found = results.find((result) => result.target === name);
  if (!found) throw new Error(`There is no target called "${name}" in this report (there are: ${results.map((r) => r.target).join(", ")})`);
  return found;
}

/** The whole judgement: every figure, every task that moved, the safety check and one overall line. */
export function judge(report, { baseline: baselineName, candidate: candidateName } = {}) {
  const results = report.results ?? [];
  if (results.length < 2) throw new Error("A proof needs two targets to compare; this report has " + results.length);
  const baseline = pick(results, baselineName, results[0]);
  const candidate = pick(results, candidateName, results.at(-1));
  if (baseline === candidate) throw new Error("The baseline and the candidate are the same target");
  // mac7/eval-honesty: refuse before judging, on the two things that make a number meaningless —
  // arms measured differently, and an arm that silently lost a whole suite out of its denominator.
  const mismatch = armRefusal({ name: baseline.target, conditions: baseline.conditions }, { name: candidate.target, conditions: candidate.conditions });
  if (mismatch) throw new Error(mismatch);
  const lost = [...lostSuites(baseline), ...lostSuites(candidate)];
  if (lost.length)
    throw new Error(`These two cannot be judged: a whole suite failed to run and its tasks are missing from the figures, `
      + `which makes every rate here an average over whatever was left.\n${lost.map((one) => `- ${one}`).join("\n")}\n`
      + `Fix whatever stopped that suite and measure again before reading any of these numbers.`);
  const comparison = compare([baseline, candidate], report.settings.passes);
  const [before, after] = comparison.rows;
  const figures = metrics.map((metric) => ({ ...metric, before: before[metric.field], after: after[metric.field],
    ...metricVerdict(metric, before[metric.field], after[metric.field]) }));
  const tasks = taskChanges(baseline, candidate);
  const safety = { ...taskChanges(baseline, candidate, { safety: true }), outcomesDiffer: comparison.safetyOutcomesDiffer };
  const gate = tasks.regressions.length > 0 || safety.regressions.length > 0 || safety.outcomesDiffer;
  return { baseline: describe(baseline), candidate: describe(candidate), figures, tasks, safety, gate,
    overall: overallVerdict(report, figures, tasks, safety, gate) };
}

const describe = (result) => ({ target: result.target, kind: result.kind, version: result.version ?? null,
  repeats: result.repeats.length, machine: result.conditions?.machine ?? null });

function overallVerdict(report, figures, tasks, safety, gate) {
  if (report.selfTest) return { verdict: "NOT COMPARABLE", why: "this is a harness self-test with the offline demo provider; its numbers mean nothing" };
  if (gate) return { verdict: "WORSE", why: `${tasks.regressions.length} task(s) stopped passing${safety.outcomesDiffer || safety.regressions.length ? ", and a safety outcome moved" : ""}` };
  const passed = figures.filter((figure) => figure.field === "successRate" || figure.field === "checksSuccessRate");
  if (passed.every((figure) => figure.verdict === "not comparable"))
    return { verdict: "NOT COMPARABLE", why: passed[0].why };
  if (passed.some((figure) => figure.verdict === "worse")) return { verdict: "WORSE", why: "fewer tasks passed, beyond the spread" };
  if (passed.some((figure) => figure.verdict === "better")) return { verdict: "BETTER", why: "more tasks passed, beyond the spread, and nothing that passed before stopped" };
  const cheaper = figures.filter((figure) => figure.better === "lower" && figure.verdict === "better").map((figure) => figure.label.toLowerCase());
  const dearer = figures.filter((figure) => figure.better === "lower" && figure.verdict === "worse").map((figure) => figure.label.toLowerCase());
  if (cheaper.length && !dearer.length) return { verdict: "BETTER", why: `as many tasks passed, with less: ${cheaper.join(", ")}` };
  if (dearer.length && !cheaper.length) return { verdict: "WORSE", why: `as many tasks passed, with more: ${dearer.join(", ")}` };
  return { verdict: "NO REAL DIFFERENCE", why: "no figure moved beyond the spread in one direction only" };
}

const cell = (value) => (value ? (value.repeats > 1 ? `${value.mean} (${value.low}–${value.high})` : String(value.mean)) : "—");
const listed = (keys) => (keys.length ? keys.map((key) => `- ${key}`) : ["- none"]);

/** The judgement as a page a person reads. */
export function proofMarkdown(report, judged, meta = {}) {
  const who = (side) => `${side.target}${side.version ? ` (version ${side.version})` : ""}, ${side.repeats} repeat(s)`;
  return [
    "# Proof report", "",
    `**Verdict: ${judged.overall.verdict}** — ${judged.overall.why}.`, "",
    ...(report.selfTest ? ["> Harness self-test with the offline demo provider. These numbers measure nothing.", ""] : []),
    `- Baseline: ${who(judged.baseline)}`,
    `- Candidate: ${who(judged.candidate)}`,
    `- Measured: ${report.startedAt} to ${report.finishedAt}; suites ${report.settings.suites.join(", ")}; last pass of ${report.settings.passes}`,
    `- Safety suites: ${failureCheckSuites.join(", ")}${report.settings.sharedDataFolder ? "; note: some arms shared one data folder" : ""}`,
    `- Conditions checked: ${[judged.baseline, judged.candidate].map((side) => `${side.target} on ${side.machine ?? "an unrecorded machine"}`).join(" and ")}`,
    ...(meta.harness ? [`- Harness: ${meta.harness}`] : []),
    "", "## Figures", "",
    "A difference counts only when the spreads over repeats (low–high) do not overlap.", "",
    "| Figure | Baseline | Candidate | Verdict | Why |", "| --- | --- | --- | --- | --- |",
    ...judged.figures.map((f) => `| ${f.label} | ${cell(f.before)} | ${cell(f.after)} | ${f.verdict} | ${f.why} |`),
    "", "## Stopped working (passed in every baseline repeat, failed in a candidate repeat)", "", ...listed(judged.tasks.regressions),
    "", "## Started working (failed in every baseline repeat, passed in every candidate repeat)", "", ...listed(judged.tasks.fixes),
    "", "## Safety", "",
    judged.safety.outcomesDiffer || judged.safety.regressions.length
      ? "**A safety outcome moved. That is a bug to look into before anything ships.**" : "No safety outcome moved.",
    ...(judged.safety.regressions.length ? ["", ...listed(judged.safety.regressions)] : []),
    "",
  ].join("\n");
}

/** The arguments this script adds to real-eval.mjs's own. */
export function proofArguments(argv) {
  const own = { from: [], baseline: undefined, candidate: undefined, md: undefined, gate: true };
  const rest = [];
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (["--from", "--baseline", "--candidate", "--md"].includes(flag)) {
      const value = argv[at + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--from") own.from.push(value); else own[flag.slice(2)] = value;
      at += 1;
    } else if (flag === "--no-gate") own.gate = false;
    else rest.push(flag);
  }
  const parsed = parseArguments(rest);
  return { ...own, out: parsed.out, measure: own.from.length ? null : parsed };
}

function harnessCommit() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: new URL(".", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}

/** Measures (or reads), judges, writes, and returns the exit code. */
export async function proof(argv, log = () => {}) {
  const options = proofArguments(argv);
  const report = options.from.length
    ? combineReports(await Promise.all(options.from.map(async (path) => JSON.parse(await readFile(path, "utf8")))))
    : await runRealEval(options.measure, log);
  const judged = judge(report, options);
  const commit = harnessCommit();
  const markdown = proofMarkdown(report, judged, { harness: commit ? `real-eval at commit ${commit}` : undefined });
  const out = options.out;
  if (out) await writeFile(out, `${JSON.stringify({ ...report, proof: judged }, null, 2)}\n`, "utf8");
  if (options.md) await writeFile(options.md, `${markdown}\n`, "utf8");
  return { code: judged.gate && options.gate ? 1 : 0, markdown, judged, report };
}

if (startedDirectly(import.meta.url, process.argv[1])) {
  proof(process.argv.slice(2), (line) => process.stderr.write(`${line}\n`))
    .then(({ code, markdown }) => { process.stdout.write(`${markdown}\n`); process.exitCode = code; })
    .catch((error) => { process.stderr.write(`proof-report: ${error.message}\n`); process.exitCode = 2; });
}

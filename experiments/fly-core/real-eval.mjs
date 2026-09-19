/**
 * Real-task measurement for Branch's learning core (src/fly-core), and the same task set put to
 * Hermes Agent, as planned in experiments/fly-core/PLAN.md sections 2 and 3.
 *
 * Branch, core off against core on (PLAN section 2):
 *   BRANCH_EVAL_URL_OFF, BRANCH_EVAL_KEY_OFF   a running Branch with its own data folder, for "off"
 *   BRANCH_EVAL_URL_ON,  BRANCH_EVAL_KEY_ON    a second one, with a fresh data folder, for "on"
 *   (or BRANCH_EVAL_URL and BRANCH_EVAL_KEY for both arms on one Branch; the report then says the
 *   arms shared a data folder, because what the older tool habit learns in one arm reaches the other)
 *
 *   node experiments/fly-core/real-eval.mjs --repeats 3 --passes 3 --out report.json
 *
 * Every repeat forgets what the core learned, then runs every suite `--passes` times in a row with
 * the switch set for its arm, so the core has something to learn from. Compare the last pass with
 * the last pass. Each task records whether it passed (Branch's own grader, and the plain checks the
 * harness applies to every assistant the same way), tool calls, tokens, cost, time, and how many
 * pieces of the core's advice the task actually used. `safety` is the failure check: the core must
 * not change any of its outcomes.
 *
 * Hermes Agent, head to head (PLAN section 3), through its OpenAI-compatible API:
 *   HERMES_EVAL_URL, HERMES_EVAL_KEY, HERMES_EVAL_MODEL, and HERMES_EVAL_WORKSPACE (the folder its
 *   files land in, for the tasks that check a file; without it those tasks are left ungraded)
 *
 *   node experiments/fly-core/real-eval.mjs --target hermes --passes 3 --out hermes.json
 *
 * Two builds of Branch, "this release against the last one" (w911, bucket 11):
 *   BRANCH_EVAL_URL_BEFORE, BRANCH_EVAL_KEY_BEFORE   the older build, with its own data folder
 *   BRANCH_EVAL_URL_AFTER,  BRANCH_EVAL_KEY_AFTER    the newer build, with its own data folder
 *
 *   node experiments/fly-core/real-eval.mjs --target builds --repeats 3 --passes 1 --out builds.json
 *
 * Each build is measured with its settings as they are; nothing is switched. The version each one
 * reports is written into the result. experiments/fly-core/proof-report.mjs turns any of these
 * reports into a verdict.
 *
 * Addresses and keys are read from the environment and never printed or written to the report.
 *
 * `--dry-run` starts two throwaway Branch copies on this computer with the offline demo provider
 * and runs the harness against them. It tests the harness only: the demo provider does the same
 * three file steps whatever it is asked, so its numbers mean nothing and the report says so. Never
 * point this script at a real model from a builder's Mac; the coordinator runs it on the Tower.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { builtInSuites } from "../../dist/evaluation-suites.js";
import { denyProblem } from "../../dist/evaluation-grading.js";
import { evaluateChecks } from "../../dist/reliability.js";
import { conditionsVersion, machineIdentity, scorerDigest } from "../../dist/evaluation-honesty.js";
import { datasetVersionOf } from "../../dist/study-journal.js";

export const defaultSuites = ["everyday", "tool-use", "reliability", "cost", "safety"];
export const failureCheckSuites = ["safety"];
const hour = 3_600_000;

/** Plain HTTP with no hidden time limit (a whole suite can take many minutes). Errors never carry the address or key. */
export function call(target, method, path, body, timeoutMs = hour) {
  const url = new URL(path.replace(/^\//, ""), target.url.endsWith("/") ? target.url : `${target.url}/`);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = send(url, { method, timeout: timeoutMs, headers: {
      authorization: `Bearer ${target.key}`, accept: "application/json",
      ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
    } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { /* not JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`${target.name} answered ${res.statusCode} to ${method} ${url.pathname}${data?.error ? `: ${String(data.error).slice(0, 200)}` : ""}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${target.name} did not answer ${method} ${url.pathname} in time`)));
    req.on("error", (error) => reject(new Error(`${target.name} could not be reached for ${method} ${url.pathname} (${error.code ?? "error"})`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Grades an answer with the checks any assistant can be held to; a task that needs a model to judge it is left ungraded. */
export async function gradeLocally(task, answer, workspace) {
  if (task.mode === "interrupt-resume") return { graded: false, passed: null, why: "needs Branch's own interrupt and resume" };
  const needsFiles = (task.checks?.files?.length ?? 0) + (task.deny?.files?.length ?? 0) > 0;
  if (needsFiles && !workspace) return { graded: false, passed: null, why: "checks a file, and no workspace was given" };
  if (!task.checks) return { graded: false, passed: null, why: "needs a model to judge it" };
  const forbidden = await denyProblem(answer, task, workspace ?? tmpdir());
  const problem = forbidden ?? await evaluateChecks(answer, { ...task.checks, maxRetries: 0 }, workspace ?? tmpdir());
  return { graded: true, passed: !problem, why: problem };
}

/** The suites to run, as the shipped files define them. */
export function loadSuites(ids) {
  const all = new Map(builtInSuites().map((suite) => [suite.id, suite]));
  return ids.map((id) => {
    const suite = all.get(id);
    if (!suite) throw new Error(`There is no built-in suite called ${id}`);
    return suite;
  });
}

const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
const known = (values) => values.filter((value) => value !== null && value !== undefined);

/**
 * mac7/eval-honesty: what one arm was measured under, in the same shape `comparisonRefusal` reads,
 * so two reports saved at different times cannot be read together unless they agree on all of it.
 * Without this, `--from a.json --from b.json` would happily put a run on one machine, one build and
 * one model beside a run on another and call the difference a result.
 */
export function armConditions(target, suites, options, version) {
  return {
    version: conditionsVersion,
    presets: [target.arm], models: [target.model ?? "not recorded"], judgeModel: null,
    settings: {
      passes: options.passes, maxSteps: options.maxSteps, maxTokens: options.maxTokens,
      suites: options.suites.join(","), kind: target.kind, sharedDataFolder: Boolean(target.sharedFolder),
    },
    appVersion: version ?? "not recorded",
    machine: machineIdentity(),
    taskSetHash: datasetVersionOf(suites.flatMap((suite) => suite.tasks.map(({ id, prompt, expected, checks, deny, scorers, judge }) => ({ id, prompt, expected, checks, deny, scorers, judge })))),
    scorerDigest: scorerDigest({ scorers: suites.flatMap((suite) => suite.tasks.flatMap((task) => task.scorers ?? [])), judgeModel: null }),
    costBasis: target.kind === "hermes" ? "reported" : "estimated",
  };
}

/** One suite on a running Branch, with each task's record read back for its tool calls and applied advice. */
async function branchSuite(target, suite, options) {
  const result = await call(target, "POST", "/api/evaluation/run", { suite: suite.id, maxSteps: options.maxSteps, maxTokens: options.maxTokens });
  const byId = new Map(suite.tasks.map((task) => [task.id, task]));
  const tasks = [];
  for (const outcome of result.tasks) {
    const view = outcome.runId ? await call(target, "GET", `/api/runs/${outcome.runId}/inspect`) : null;
    const answer = String(view?.run?.output ?? "");
    const local = outcome.skipped ? { graded: false, passed: null, why: outcome.problem }
      : await gradeLocally(byId.get(outcome.id), answer, options.workspace);
    // A task that did not finish has no answer to check, only an error, whichever assistant it was.
    if (local.graded && outcome.status !== "completed") local.passed = false;
    tasks.push({
      suite: suite.id, id: outcome.id, status: outcome.status, skipped: outcome.skipped,
      passed: outcome.skipped ? null : outcome.passed, checksPassed: local.passed, graded: local.graded,
      toolCalls: view ? view.calls.length : null, tokens: outcome.tokens, dollars: outcome.dollars, ms: outcome.ms,
      advice: view ? (view.learned ?? []).length : null,
    });
  }
  return tasks;
}

/** The version a running Branch reports about itself, or null when it will not say. */
export async function branchVersion(target) {
  const described = await call(target, "GET", "/api/openapi.json", undefined, 30_000).catch(() => null);
  return typeof described?.info?.version === "string" ? described.info.version : null;
}

const buildArms = ["before", "after"];

export function branchTarget(arm, url, key, sharedFolder, workspace) {
  if (!url || !key) throw new Error(`Set the address and key of the Branch for the "${arm}" arm in the environment (see the top of real-eval.mjs)`);
  const build = buildArms.includes(arm);
  const target = { name: build ? `Branch ${arm}` : `Branch (${arm})`, kind: build ? "build" : "branch", arm, url, key, sharedFolder, workspace };
  return {
    ...target,
    version: () => branchVersion(target),
    /** Sets the switch for this arm; "on" first forgets what an earlier repeat learned. A build is measured as it is. */
    async prepare(repeat) {
      if (build) return { repeat, forgotBefore: false };
      const view = await call(target, "GET", "/api/learning-core").catch((error) => {
        throw new Error(`${error.message}. This Branch may be too old to have the learning core's routes.`);
      });
      if (arm === "on" || view.kept.actions) await call(target, "POST", "/api/learning-core/forget", { confirm: "forget" });
      await call(target, "POST", "/api/learning-core/settings", { mode: arm === "on" ? "on" : "off" });
      return { repeat, forgotBefore: true };
    },
    suite: (suite, options) => branchSuite(target, suite, { ...options, workspace }),
  };
}

/** One task put to Hermes Agent's OpenAI-compatible API, in a conversation of its own. */
async function hermesTask(target, suite, task, options) {
  if (task.requires?.length) return { suite: suite.id, id: task.id, status: "skipped", skipped: true, passed: null, checksPassed: null, graded: false, toolCalls: null, tokens: 0, dollars: null, ms: 0, advice: null };
  const began = Date.now();
  let reply = null, status = "completed";
  try {
    reply = await call(target, "POST", "/v1/chat/completions", { model: target.model, messages: [{ role: "user", content: task.prompt }] }, options.taskTimeoutMs);
  } catch (error) {
    status = "failed";
    reply = { error: error.message };
  }
  const message = reply?.choices?.[0]?.message ?? {};
  const answer = typeof message.content === "string" ? message.content : "";
  const local = await gradeLocally(task, answer, target.workspace);
  if (local.graded && status !== "completed") local.passed = false;
  const usage = reply?.usage;
  return {
    suite: suite.id, id: task.id, status, skipped: false, passed: local.passed, checksPassed: local.passed, graded: local.graded,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.length : null,
    tokens: usage ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) : null,
    dollars: typeof usage?.cost === "number" ? usage.cost : null, ms: Date.now() - began, advice: null,
  };
}

export function hermesTarget(url, key, model, workspace) {
  if (!url || !key) throw new Error("Set HERMES_EVAL_URL and HERMES_EVAL_KEY in the environment");
  const target = { name: "Hermes Agent", kind: "hermes", arm: "hermes", url, key, model: model || "hermes-agent", workspace, sharedFolder: false };
  return {
    ...target,
    version: async () => null,
    prepare: async (repeat) => ({ repeat, forgotBefore: false }),
    suite: async (suite, options) => {
      const tasks = [];
      for (const task of suite.tasks) tasks.push(await hermesTask(target, suite, task, options));
      return tasks;
    },
  };
}

/** The numbers for one pass: pass rate over graded tasks, and per-task means of the rest. */
export function passSummary(tasks, problems = []) {
  const ran = tasks.filter((task) => !task.skipped);
  const graded = ran.filter((task) => task.passed !== null);
  const checked = ran.filter((task) => task.checksPassed !== null);
  const mean = (values) => (values.length ? Math.round((sum(values) / values.length) * 1000) / 1000 : null);
  return {
    tasks: ran.length, skipped: tasks.length - ran.length,
    // mac7/eval-honesty: a whole suite that failed to run used to vanish — its tasks simply were
    // not in the denominator, and every figure below was quietly over what was left. The count
    // travels with the figures now, and the proof refuses to judge a pass that lost one.
    suitesMissing: problems.length,
    successRate: graded.length ? Math.round((graded.filter((task) => task.passed).length / graded.length) * 1000) / 1000 : null,
    checksSuccessRate: checked.length ? Math.round((checked.filter((task) => task.checksPassed).length / checked.length) * 1000) / 1000 : null,
    toolCallsPerTask: mean(known(ran.map((task) => task.toolCalls))),
    tokensPerTask: mean(known(ran.map((task) => task.tokens))),
    dollarsPerTask: mean(known(ran.map((task) => task.dollars))),
    msPerTask: mean(ran.map((task) => task.ms)),
    advicePerTask: mean(known(ran.map((task) => task.advice))),
  };
}

/** Every repeat and pass for one target. A suite that fails to run is recorded, not fatal. */
async function runTarget(target, suites, options, log) {
  const repeats = [];
  for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
    const prepared = await target.prepare(repeat);
    const passes = [];
    for (let pass = 1; pass <= options.passes; pass += 1) {
      const tasks = [], problems = [];
      for (const suite of suites) {
        try { tasks.push(...await target.suite(suite, options)); }
        catch (error) { problems.push({ suite: suite.id, problem: error.message }); }
      }
      const main = tasks.filter((task) => !failureCheckSuites.includes(task.suite));
      const summary = passSummary(main, problems);
      passes.push({ pass, summary, failureCheck: tasks.filter((task) => failureCheckSuites.includes(task.suite)), tasks: main, problems });
      log(`${target.name}: repeat ${repeat} pass ${pass}: ${JSON.stringify(summary)}`);
    }
    repeats.push({ repeat, ...prepared, passes });
  }
  const version = await target.version?.().catch(() => null) ?? null;
  return { target: target.name, kind: target.kind, arm: target.arm, version, sharedFolder: target.sharedFolder,
    conditions: armConditions(target, suites, options, version), repeats };
}

/** Mean and spread (smallest to largest) of one number over repeats, at one pass. */
function across(result, pass, field) {
  const values = known(result.repeats.map((repeat) => repeat.passes[pass - 1]?.summary[field]));
  if (!values.length) return null;
  return { mean: Math.round((sum(values) / values.length) * 1000) / 1000, low: Math.min(...values), high: Math.max(...values), repeats: values.length };
}

/** The comparison PLAN.md asks for: last pass against last pass, and any safety outcome that moved. */
export function compare(results, pass) {
  const fields = ["successRate", "checksSuccessRate", "toolCallsPerTask", "tokensPerTask", "dollarsPerTask", "msPerTask", "advicePerTask"];
  const rows = results.map((result) => ({ target: result.target, ...Object.fromEntries(fields.map((field) => [field, across(result, pass, field)])) }));
  const safety = results.map((result) => result.repeats.flatMap((repeat) => repeat.passes.flatMap((p) => p.failureCheck.map((task) => `${task.id}:${task.passed}`))));
  const moved = safety.length > 1 && JSON.stringify([...new Set(safety[0])].sort()) !== JSON.stringify([...new Set(safety[1])].sort());
  return { pass, rows, safetyOutcomesDiffer: moved,
    rule: "A difference smaller than the spread (low to high over repeats) counts as no difference." };
}

/** Two throwaway Branch copies with the offline demo provider, for testing the harness itself. */
export async function dryRunTargets(arms = ["off", "on"]) {
  const { createBranch, DemoProvider } = await import("../../dist/index.js");
  const { startServer } = await import("../../dist/server.js");
  const { discardTemp } = await import("../../tests/temp-dir.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-real-eval-dry-"));
  const started = [];
  for (const arm of arms) {
    const dataDir = join(root, arm, "data"), workspace = join(root, arm, "workspace");
    const app = await createBranch({ workspace, dataDir, provider: new DemoProvider() });
    const server = await startServer(app, { dataDir, port: 0 });
    started.push({ app, server, target: branchTarget(arm, server.url, server.token, false, app.files?.root ?? workspace) });
  }
  const close = async () => {
    for (const { app, server } of started) { await server.close(); await app.close(); }
    await discardTemp(root);
  };
  return { targets: started.map((entry) => entry.target), close };
}

function sameAddress(a, b) {
  if (!a || !b) return false;
  try { return new URL(a).origin === new URL(b).origin; } catch { return a === b; }
}

/** The targets the environment describes. */
export function targetsFromEnvironment(kind, env = process.env) {
  if (kind === "hermes") return [hermesTarget(env.HERMES_EVAL_URL, env.HERMES_EVAL_KEY, env.HERMES_EVAL_MODEL, env.HERMES_EVAL_WORKSPACE)];
  if (kind === "builds") {
    if (sameAddress(env.BRANCH_EVAL_URL_BEFORE, env.BRANCH_EVAL_URL_AFTER))
      throw new Error("The before and after builds must be two different running copies of Branch");
    return buildArms.map((arm) => branchTarget(arm, env[`BRANCH_EVAL_URL_${arm.toUpperCase()}`], env[`BRANCH_EVAL_KEY_${arm.toUpperCase()}`],
      false, env[`BRANCH_EVAL_WORKSPACE_${arm.toUpperCase()}`] ?? env.BRANCH_EVAL_WORKSPACE));
  }
  const separate = !!env.BRANCH_EVAL_URL_OFF || !!env.BRANCH_EVAL_URL_ON;
  const url = (arm) => (separate ? env[`BRANCH_EVAL_URL_${arm.toUpperCase()}`] : env.BRANCH_EVAL_URL);
  // One address given twice is still one Branch and one data folder.
  const shared = !separate || sameAddress(url("off"), url("on"));
  const key = (arm) => (separate ? env[`BRANCH_EVAL_KEY_${arm.toUpperCase()}`] : env.BRANCH_EVAL_KEY);
  const workspace = (arm) => env[`BRANCH_EVAL_WORKSPACE_${arm.toUpperCase()}`] ?? env.BRANCH_EVAL_WORKSPACE;
  return ["off", "on"].map((arm) => branchTarget(arm, url(arm), key(arm), shared, workspace(arm)));
}

/**
 * Runs the whole measurement and returns the report. The arms run one after the other, "off"
 * first, so on a shared Branch the core never learns from the "off" arm's tasks.
 */
export async function runRealEval(input = {}, log = () => {}) {
  const options = { repeats: 3, passes: 3, suites: defaultSuites, maxSteps: 30, maxTokens: 120_000, taskTimeoutMs: 10 * 60_000, target: "branch", ...input };
  const suites = loadSuites(options.suites);
  const dry = options.dryRun ? await dryRunTargets(options.target === "builds" ? buildArms : undefined) : null;
  try {
    const targets = dry ? dry.targets : options.targets ?? targetsFromEnvironment(options.target);
    const startedAt = new Date().toISOString(), results = [];
    for (const target of targets) results.push(await runTarget(target, suites, options, log));
    return {
      format: "branch-fly-core-real-eval", version: 1, startedAt, finishedAt: new Date().toISOString(),
      selfTest: !!options.dryRun,
      note: options.dryRun
        ? "Harness self-test with the offline demo provider. These numbers measure nothing about the learning core."
        : "Measured on real tasks. Read the comparison with its spread; see experiments/fly-core/PLAN.md.",
      settings: { target: options.target, repeats: options.repeats, passes: options.passes, suites: options.suites,
        failureCheckSuites, maxSteps: options.maxSteps, maxTokens: options.maxTokens,
        sharedDataFolder: targets.some((target) => target.sharedFolder) },
      comparison: compare(results, options.passes),
      results,
    };
  } finally {
    await dry?.close();
  }
}

const cell = (value) => (value === null ? "—" : value.repeats > 1 ? `${value.mean} (${value.low}–${value.high})` : String(value.mean));
/** The comparison as a small table for the terminal. */
export function table(report) {
  const heads = ["target", "passed", "checks passed", "tool calls", "tokens", "dollars", "ms", "advice used"];
  const keys = ["successRate", "checksSuccessRate", "toolCallsPerTask", "tokensPerTask", "dollarsPerTask", "msPerTask", "advicePerTask"];
  const lines = [report.note, `pass ${report.comparison.pass} of ${report.settings.passes}, per task, mean (low–high over ${report.settings.repeats} repeat(s))`, heads.join(" | ")];
  for (const row of report.comparison.rows) lines.push([row.target, ...keys.map((key) => cell(row[key]))].join(" | "));
  if (report.comparison.safetyOutcomesDiffer) lines.push("WARNING: a safety outcome differs between the arms. That is a bug to look into.");
  if (report.settings.sharedDataFolder) lines.push("Note: both arms used one Branch data folder.");
  return lines.join("\n");
}

export function parseArguments(argv) {
  const value = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
  const number = (name) => (value(name) === undefined ? undefined : Math.max(1, Math.floor(Number(value(name)))));
  const options = { dryRun: argv.includes("--dry-run"), target: value("--target") ?? "branch", json: argv.includes("--json"), out: value("--out") };
  for (const [flag, key] of [["--repeats", "repeats"], ["--passes", "passes"], ["--max-steps", "maxSteps"], ["--max-tokens", "maxTokens"]])
    if (number(flag) !== undefined) options[key] = number(flag);
  if (value("--suites")) options.suites = value("--suites").split(",").map((id) => id.trim()).filter(Boolean);
  if (!["branch", "builds", "hermes"].includes(options.target)) throw new Error("--target is branch, builds or hermes");
  if (options.dryRun && options.target === "hermes") throw new Error("--dry-run only runs the Branch arms");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runRealEval(options, (line) => process.stderr.write(`${line}\n`));
  if (options.out) await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : table(report)}\n`);
}

/** Whether this file was started directly; a plain `file://` prefix fails on a path with a space or on Windows. */
export const startedDirectly = (moduleUrl, script) => !!script && moduleUrl === pathToFileURL(script).href;

if (startedDirectly(import.meta.url, process.argv[1])) {
  main().catch((error) => { process.stderr.write(`real-eval: ${error.message}\n`); process.exitCode = 1; });
}

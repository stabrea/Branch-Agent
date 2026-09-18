/**
 * The runner. Gives every contestant the same task, in the same folder, against the same model, on
 * the same machine, inside one window — and writes down what happened before it starts the next one.
 *
 * Three things about it are not conveniences:
 *
 * 1. **Round robin.** The loop is `for each repeat / for each task / for each contestant`, never all
 *    of one contestant and then all of the next. This machine runs the owner's own work and was
 *    measured at load 14 on 5 processors; a quiet hour would otherwise be a prize handed to whoever
 *    happened to run in it. Interleaving is what makes the difference between two rows mean
 *    something. The load average is written down either side of every single run as well, so a
 *    window that moved can be seen rather than guessed at.
 * 2. **The check never runs inside the agent's turn.** The agent finishes, the harness restores the
 *    pristine test files over the folder, and only then does the harness run the check itself. An
 *    agent that deletes or weakens a test gets the original back.
 * 3. **Every result is appended the moment it exists.** A hundred-odd runs on a 4B model may not
 *    finish in one sitting; a window that stops half way must leave a board that can be built and
 *    honestly labelled incomplete, not a lost afternoon.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conditionsVersion, machineIdentity, scorerDigest } from "../../dist/evaluation-honesty.js";
import { contestants as allContestants } from "./contestants.mjs";
import { filesUnder, tasks as allTasks } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

const settings = {
  model: argOf("model", "qwen3-4b-64k"),
  endpoint: argOf("endpoint", "http://127.0.0.1:11434/v1"),
  timeoutSec: Number(argOf("timeout", "300")),
  repeats: Number(argOf("repeats", "3")),
  seedRoot: argOf("seeds", "/workspace/bench/seeds"),
  scratch: argOf("scratch", "/workspace/bench/board"),
};
const out = argOf("out", join(settings.scratch, "results.jsonl"));
const only = argOf("only", "").split(",").filter(Boolean);
const onlyTasks = argOf("tasks", "").split(",").filter(Boolean);
// Contestants that run once, as a demonstration, rather than over every repeat. A single pass can
// never support a claim that one thing beats another, and is labelled so wherever it is printed.
const demoOnly = new Set(argOf("demo", "branch-trunk").split(",").filter(Boolean));

const contestants = allContestants.filter((one) => !only.length || only.includes(one.id));
const tasks = allTasks.filter((one) => !onlyTasks.length || onlyTasks.includes(one.id));

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const hashes = (files) => Object.fromEntries(Object.entries(files).map(([name, body]) => [name, digest(body)]));

/**
 * What every row of this board was measured under. The contestant is deliberately **not** in here:
 * it is the one thing the board is varying, and `comparisonRefusal` is meant to refuse when
 * anything *else* differs. Everything below is identical on every row, which is what lets the
 * report ask the honesty module to certify the comparison rather than assert it.
 */
const conditions = {
  version: conditionsVersion,
  presets: [settings.model],
  models: [settings.model],
  judgeModel: null, // nothing on this board is decided by a model
  settings: {
    endpoint: settings.endpoint,
    timeoutSeconds: settings.timeoutSec,
    repeats: settings.repeats,
    contextWindowTokens: 65536,
    temperature: "each program's own default — see the report",
  },
  appVersion: `scoreboard-harness ${JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")).version}`,
  machine: machineIdentity(),
  taskSetHash: digest(JSON.stringify(tasks.map((task) => [task.id, task.prompt, task.seed]))),
  scorerDigest: scorerDigest({
    scorers: tasks.map((task) => ({ id: task.id, kind: "program", readOnly: !!task.readOnly, restoreVerify: !!task.restoreVerify })),
    judgeModel: null, benchmarkJudge: "the harness runs a program; no model marks anything",
  }),
  costBasis: "reported",
};

mkdirSync(settings.scratch, { recursive: true });
writeFileSync(join(settings.scratch, "conditions.json"), JSON.stringify(conditions, null, 2));

/**
 * Whether what went wrong was the rig rather than the agent.
 *
 * This machine is shared with the owner's own work and its model server is reached over a
 * forwarder; a refused connection or a 500 from the server is not an agent losing a task, and
 * scoring it as one would quietly credit the busiest minutes of the afternoon to whichever agent
 * was not in them. A cell that fails this way is tried once more, and the retry is recorded.
 */
const rigFailure = (text) => /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EAI_AGAIN|HTTP 50[0-9]|Internal Server Error/i.test(text ?? "");

/** One attempt: set the folder up, run the program, put the tests back, and mark it. */
async function runCell(contestant, task, repeat, attempt = 1) {
  const slug = `${contestant.id}__${task.id}__r${repeat}`;
  const dir = join(settings.scratch, "work", slug);
  const dataDir = join(settings.scratch, "state", slug);
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(settings.seedRoot, task.seed, "work"), dir, { recursive: true });

  const before = hashes(filesUnder(dir));
  const loadBefore = loadavg()[0];
  const plan = contestant.invoke({ ...settings, dir, prompt: task.prompt, dataDir });

  const started = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawn(plan.file, plan.args, {
      cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, settings.timeoutSec * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}${error.message}`, code: -1, killed }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, killed }); });
    if (plan.stdin !== undefined) child.stdin.end(plan.stdin); else child.stdin.end();
  });
  const elapsedMs = Date.now() - started;
  const loadAfter = loadavg()[0];

  const after = hashes(filesUnder(dir));
  const changed = [
    ...Object.keys(after).filter((name) => before[name] !== after[name]),
    ...Object.keys(before).filter((name) => !(name in after)).map((name) => `${name} (deleted)`),
  ].sort();

  let parsed;
  try { parsed = contestant.parse(result); }
  catch (error) { parsed = { answer: "", calls: null, usage: null, error: `could not read its output: ${error.message}` }; }

  // Tamper first, then the check. A task marked read-only that wrote anything is a fail whatever
  // its answer said, and a test file that moved is named before the pristine copy goes back.
  const verify = join(settings.seedRoot, task.seed, "verify");
  const touchedVerified = [];
  if (task.restoreVerify && existsSync(verify)) {
    for (const [name, body] of Object.entries(filesUnder(verify)))
      if (after[name] !== digest(body)) touchedVerified.push(name);
    cpSync(verify, dir, { recursive: true });
  }

  // A rig failure on the first try buys one more go, from a clean folder, rather than a nought.
  //
  // Only the program's *error* is read here, never its answer. An agent's answer is the thing under
  // test; letting it decide whether the harness gives a second go would hand a contestant a lever
  // on its own marking — an agent that wrote the words "connection error" in a summary would earn
  // itself a retry. It was also observed firing on an innocent sentence about retry policy, which
  // cost four minutes of doubled work and marked a clean run as rescued.
  if (attempt === 1 && !result.killed && rigFailure(parsed.error ?? "")) {
    process.stdout.write(`retry ${slug} — the model server failed, not the agent: ${(parsed.error || parsed.answer || "").slice(0, 60)}\n`);
    return runCell(contestant, task, repeat, 2);
  }

  let verdict;
  if (result.killed) verdict = { passed: false, why: `ran past the ${settings.timeoutSec}s deadline and was stopped` };
  else if (task.readOnly && changed.length) verdict = { passed: false, why: `the task said to change nothing, and it changed ${changed.join(", ")}` };
  else {
    try { verdict = task.check(dir, parsed.answer); }
    catch (error) { verdict = { passed: false, why: `the check could not run: ${error.message}` }; }
  }

  const record = {
    contestant: contestant.id, contestantName: contestant.name, task: task.id, repeat,
    attempt, retriedAfterRigFailure: attempt > 1,
    demonstrationOnly: demoOnly.has(contestant.id),
    passed: verdict.passed, why: verdict.why,
    elapsedMs, exitCode: result.code, killed: result.killed,
    modelCalls: parsed.calls, usage: parsed.usage, agentError: parsed.error ?? null,
    // "Rescued" on this board means exactly one of these three, and nothing softer: the harness had
    // to stop it, the program exited badly, or it handed back nothing to mark.
    rescued: Boolean(attempt > 1 || result.killed || (result.code !== 0 && result.code !== null) || (!parsed.answer && !changed.length)),
    changedOnDisk: changed, touchedVerifiedFiles: touchedVerified,
    answerChars: parsed.answer.length,
    answer: parsed.answer.slice(0, 4000),
    loadBefore, loadAfter, at: new Date().toISOString(),
    toolSurface: contestant.toolSurface, limitsNote: contestant.limitsNote,
    // Stamped on every single row, not only on the window, so that two windows' files can be put
    // together and the report can still ask the honesty module whether they measured the same
    // thing — instead of assuming it because they happen to be in one file.
    observed: {
      model: settings.model, endpoint: settings.endpoint, timeoutSeconds: settings.timeoutSec,
      repeats: settings.repeats, machine: conditions.machine, appVersion: conditions.appVersion,
      taskSetHash: conditions.taskSetHash, scorerDigest: conditions.scorerDigest,
      contextWindowTokens: conditions.settings.contextWindowTokens,
    },
  };
  appendFileSync(out, `${JSON.stringify(record)}\n`);
  const mark = verdict.passed ? "PASS" : "fail";
  process.stdout.write(`${mark} ${slug} ${(elapsedMs / 1000).toFixed(0)}s load ${loadBefore.toFixed(1)}->${loadAfter.toFixed(1)} — ${verdict.why}\n`);
  return record;
}

const planned = [];
for (let repeat = 1; repeat <= settings.repeats; repeat++)
  for (const task of tasks)
    for (const contestant of contestants) {
      if (demoOnly.has(contestant.id) && repeat > 1) continue;
      planned.push({ contestant, task, repeat });
    }

process.stdout.write(`${planned.length} runs planned: ${contestants.length} contestants x ${tasks.length} tasks x ${settings.repeats} repeats (round robin), on ${conditions.machine}\n`);
writeFileSync(join(settings.scratch, "planned.json"), JSON.stringify(planned.map((one) => `${one.contestant.id}__${one.task.id}__r${one.repeat}`), null, 2));

for (const [index, cell] of planned.entries()) {
  process.stdout.write(`[${index + 1}/${planned.length}] `);
  await runCell(cell.contestant, cell.task, cell.repeat);
}
process.stdout.write("window finished\n");

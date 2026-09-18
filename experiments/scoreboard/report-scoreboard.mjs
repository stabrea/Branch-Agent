/**
 * Turns the runner's records into the page the owner reads — and refuses to print a comparison the
 * evaluation suite will not certify.
 *
 * The refusal is the point of the file, not a flourish on it. Every row carries the conditions it
 * was actually measured under, and before any two contestants are put beside each other, those two
 * sets of conditions are handed to `comparisonRefusal` from the honesty module on `mac7/eval-honesty`.
 * If it names a difference — a different model, a different deadline, a different machine, a
 * different task set, a different way of marking — the table does not get printed. What gets
 * printed instead is what differed and what would have to change to make the comparison fair.
 *
 * Everything with more than one repeat is printed as a range, never as a single figure, and two
 * ranges are only called apart when `spreadsSeparate` says they do not overlap.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  combinedBasis, comparisonRefusal, completenessRefusal, costNote,
  incompleteWarning, spreadOf, spreadsSeparate,
} from "../../dist/evaluation-honesty.js";
import { conditionsOf } from "./board-conditions.mjs";
import { contestantById } from "./contestants.mjs";
import { taskById, tasks as allTasks } from "./tasks.mjs";

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const resultsPath = argOf("results", "/workspace/bench/board/results.jsonl");
const outPath = argOf("out", "SCOREBOARD.md");

// A pass of the board that did not finish is left out entirely rather than averaged in: a partial
// pass has a smaller denominator, and a smaller denominator flatters whoever is left in it. Which
// passes were dropped, and why, is printed at the bottom.
const maxRepeat = Number(argOf("max-repeat", "0"));
const everyRow = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rows = maxRepeat ? everyRow.filter((row) => row.repeat <= maxRepeat) : everyRow;
const droppedRepeats = everyRow.length - rows.length;
if (!rows.length) throw new Error("no results to report on");

const byContestant = new Map();
for (const row of rows) {
  if (!byContestant.has(row.contestant)) byContestant.set(row.contestant, []);
  byContestant.get(row.contestant).push(row);
}

const real = [...byContestant.entries()].filter(([, rows]) => !rows[0].demonstrationOnly);
const demos = [...byContestant.entries()].filter(([, rows]) => rows[0].demonstrationOnly);

/* ------------------------------------------------- can these be put beside each other at all? */

const refusals = [];
for (let i = 0; i < real.length; i++)
  for (let j = i + 1; j < real.length; j++) {
    const [aName, aRows] = real[i], [bName, bRows] = real[j];
    const refusal = comparisonRefusal(conditionsOf(aRows), conditionsOf(bRows), { before: aName, after: bName });
    if (refusal) refusals.push(refusal);
  }

// What the window set out to do, not what it managed. Measuring completeness against the cells that
// happen to be in the file would call a window that stopped after one task complete, which is the
// error `incompleteWarning` exists to prevent. The runner writes `planned.json` beside its results;
// if it is missing, what is in the file is all there is to go on, and the report says so.
const plannedPath = argOf("planned", join(dirname(resultsPath), "planned.json"));
let plannedCells = null;
try { plannedCells = JSON.parse(readFileSync(plannedPath, "utf8")); } catch { plannedCells = null; }
const plannedFor = (name) => (plannedCells ?? []).filter((cell) => cell.startsWith(`${name}__`))
  .filter((cell) => !maxRepeat || Number(cell.slice(cell.lastIndexOf("__r") + 3)) <= maxRepeat);

const tasksRun = [...new Set(rows.map((row) => row.task))];
const repeats = Math.max(...rows.map((row) => row.repeat));
const completenessOf = (name, rows) => {
  const have = new Set(rows.map((row) => `${name}__${row.task}__r${row.repeat}`));
  if (plannedCells) {
    const want = plannedFor(name);
    return { planned: want.length, recorded: have.size, missing: want.filter((cell) => !have.has(cell)) };
  }
  const want = rows[0].demonstrationOnly ? tasksRun.length : tasksRun.length * repeats;
  const missing = [];
  for (const task of tasksRun)
    for (let repeat = 1; repeat <= (rows[0].demonstrationOnly ? 1 : repeats); repeat++)
      if (!have.has(`${name}__${task}__r${repeat}`)) missing.push(`${name} ${task} r${repeat}`);
  return { planned: want, recorded: have.size, missing };
};
const completeness = new Map([...byContestant].map(([name, rows]) => [name, completenessOf(name, rows)]));

for (let i = 0; i < real.length; i++)
  for (let j = i + 1; j < real.length; j++) {
    const refusal = completenessRefusal(completeness.get(real[i][0]), completeness.get(real[j][0]), { before: real[i][0], after: real[j][0] });
    if (refusal) refusals.push(refusal);
  }

/* ------------------------------------------------------------------------------ the figures */

const pct = (value) => `${Math.round(value * 100)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(0)}s`;
/** Pass rate per repeat, so the spread is over whole passes of the board rather than over cells. */
function passRateSpread(rows) {
  const byRepeat = new Map();
  for (const row of rows) {
    if (!byRepeat.has(row.repeat)) byRepeat.set(row.repeat, []);
    byRepeat.get(row.repeat).push(row);
  }
  return spreadOf([...byRepeat.values()].map((set) => set.filter((row) => row.passed).length / set.length));
}
const elapsedSpread = (rows) => spreadOf(rows.map((row) => row.elapsedMs));
const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);

const lines = [];
const say = (text = "") => lines.push(text);

say("# The scoreboard");
say();
say(`Built ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from \`${resultsPath}\`.`);
say();
say("Read **What this is not**, at the bottom, before quoting any number from here.");
say();

if (refusals.length) {
  say("## The suite refuses to compare these runs");
  say();
  say("No table is printed, because the evaluation suite will not certify the comparison:");
  say();
  for (const refusal of refusals) { say("> " + refusal.split("\n").join("\n> ")); say(); }
} else {
  say("## The board");
  say();
  // With one contestant there is nothing to certify, and saying the suite "raised no objection"
  // would dress a table nobody could have objected to as a comparison that passed a check.
  if (real.length < 2)
    say(`Only one contestant has results here, so there is no comparison and nothing for the `
      + `evaluation suite to certify. What follows is one agent's figures, not a ranking.`);
  else
    say("The evaluation suite was asked whether these contestants may be put beside each other at all, "
      + "and raised no objection: every row below was measured on one machine, against one model, with "
      + "one deadline, over one unchanged task set, marked by one unchanged set of programs.");
  say();
  // "Rescued" alone is not enough on a board where the clock does most of the failing. A run the
  // harness had to stop and a run that came back in ninety seconds with the wrong answer are not
  // the same fact, and a single column that covers both tells a reader nothing about which of the
  // two an agent did. The deadline gets its own column.
  say(`| agent | tasks passed, per pass of the board | median run | stopped by the clock | model calls | tokens in/out | had to be rescued |`);
  say(`|---|---|---|---|---|---|---|`);
  for (const [name, contestantRows] of real) {
    const contestant = contestantById[name];
    const rate = passRateSpread(contestantRows);
    const time = elapsedSpread(contestantRows);
    const middle = [...contestantRows].sort((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(contestantRows.length / 2)];
    const rescued = contestantRows.filter((row) => row.rescued).length;
    const calls = contestantRows.filter((row) => typeof row.modelCalls === "number");
    const stopped = contestantRows.filter((row) => row.killed).length;
    say(`| ${contestant?.name ?? name} | **${pct(rate.mean)}** (${pct(rate.low)}–${pct(rate.high)} over ${rate.repeats}) `
      + `| ${secs(middle.elapsedMs)} (${secs(time.low)}–${secs(time.high)}) `
      + `| ${stopped} of ${contestantRows.length} `
      + `| ${calls.length ? (sum(calls, (row) => row.modelCalls) / calls.length).toFixed(1) : "not reported"} `
      + `| ${sum(contestantRows, (row) => row.usage?.input)} / ${sum(contestantRows, (row) => row.usage?.output)} `
      + `| ${rescued} of ${contestantRows.length} |`);
  }
  say();

  say("### Task by task");
  say();
  say("How many of that agent's attempts at that one task passed.");
  say();
  say(`| task | what it is | ${real.map(([name]) => contestantById[name]?.name.split(" (")[0] ?? name).join(" | ")} |`);
  say(`|---|---|${real.map(() => "---").join("|")}|`);
  for (const taskId of tasksRun) {
    const task = taskById[taskId];
    const cells = real.map(([, contestantRows]) => {
      const mine = contestantRows.filter((row) => row.task === taskId);
      return mine.length ? `${mine.filter((row) => row.passed).length}/${mine.length}` : "—";
    });
    say(`| \`${taskId}\` | ${task?.what ?? ""} | ${cells.join(" | ")} |`);
  }
  say();

  say("### What each task does and does not prove");
  say();
  for (const taskId of tasksRun) {
    const task = taskById[taskId];
    if (!task) continue;
    say(`**\`${taskId}\`** — ${task.what}. A pass proves ${task.proves}. It does not prove ${task.doesNotProve}.`);
    say();
  }

  say("### Where the ranges actually separate");
  say();
  say("Two agents are only called apart here when the range of one does not touch the range of the "
    + "other over the repeats. Everything else is a tie as far as this board can tell.");
  say();
  let separated = 0;
  for (let i = 0; i < real.length; i++)
    for (let j = i + 1; j < real.length; j++) {
      const a = real[i], b = real[j];
      const rateA = passRateSpread(a[1]), rateB = passRateSpread(b[1]);
      const timeA = elapsedSpread(a[1]), timeB = elapsedSpread(b[1]);
      const nameA = contestantById[a[0]]?.name.split(" (")[0] ?? a[0];
      const nameB = contestantById[b[0]]?.name.split(" (")[0] ?? b[0];
      if (spreadsSeparate(rateA, rateB)) {
        separated++;
        const [ahead, behind] = rateA.mean > rateB.mean ? [nameA, nameB] : [nameB, nameA];
        say(`- **Tasks passed: ${ahead} is ahead of ${behind}**, and the ranges do not overlap `
          + `(${pct(rateA.low)}–${pct(rateA.high)} against ${pct(rateB.low)}–${pct(rateB.high)}).`);
      } else if (rateA.repeats < 2 || rateB.repeats < 2) {
        // One measurement has no range, so it cannot overlap anything and cannot fail to. Saying
        // "their ranges overlap" here would be a sentence contradicted by the two numbers printed
        // beside it; the truthful thing is that the board was only run through once.
        say(`- Tasks passed: **no claim between ${nameA} and ${nameB}** — the board was run through `
          + `once (${pct(rateA.mean)} against ${pct(rateB.mean)}), and one pass has no range at all. `
          + `A difference this size may be real or may be the afternoon. Run it again to find out.`);
      } else {
        say(`- Tasks passed: **${nameA} and ${nameB} are a tie** on this board — their ranges overlap `
          + `(${pct(rateA.low)}–${pct(rateA.high)} against ${pct(rateB.low)}–${pct(rateB.high)}), so the difference in the means is not something this many repeats can see.`);
      }
      if (spreadsSeparate(timeA, timeB)) {
        separated++;
        const [faster, slower] = timeA.mean < timeB.mean ? [nameA, nameB] : [nameB, nameA];
        say(`- **Time: ${faster} is faster than ${slower}**, ranges apart (${secs(timeA.low)}–${secs(timeA.high)} against ${secs(timeB.low)}–${secs(timeB.high)}).`);
      } else if (timeA.repeats < 2 || timeB.repeats < 2) {
        say(`- Time: **no claim between ${nameA} and ${nameB}** — one pass each `
          + `(${secs(timeA.mean)} against ${secs(timeB.mean)} on average), which is a measurement, not a range.`);
      } else {
        say(`- Time: **${nameA} and ${nameB} overlap** (${secs(timeA.low)}–${secs(timeA.high)} against ${secs(timeB.low)}–${secs(timeB.high)}); no claim either way.`);
      }
    }
  if (!separated) say();
  say();
}

/* ------------------------------------------------------------------- everything else recorded */

for (const [name, contestantRows] of byContestant) {
  const warning = incompleteWarning(completeness.get(name));
  if (warning) { say(`> **${name}** — ${warning}`); say(); }
}

if (demos.length) {
  say("## Shown, not scored");
  say();
  for (const [name, demoRows] of demos) {
    const contestant = contestantById[name];
    say(`**${contestant?.name ?? name}** — ${contestant?.note ?? ""}`);
    say();
    say(`One pass over ${demoRows.length} task${demoRows.length === 1 ? "" : "s"}: **${demoRows.filter((row) => row.passed).length} passed**. `
      + `This is a single pass, so it has no spread and supports no claim that anything beats anything. `
      + `It is here to show what those changes were worth.`);
    say();
    const reasons = [...new Set(demoRows.map((row) => row.agentError ?? row.why))];
    for (const reason of reasons.slice(0, 4)) say(`- ${reason}`);
    say();
    // The comparison the demonstration exists for, stated even when it is unflattering to the
    // change being demonstrated. A fix that lets an agent get further without getting further *on
    // the board* is worth knowing about, and burying it would be the exact flattery this whole
    // exercise is meant to avoid.
    const counterpart = real.find(([other]) => other !== name && name.startsWith(other));
    if (counterpart) {
      const mine = demoRows.filter((row) => row.passed).length;
      const theirsRows = counterpart[1].filter((row) => row.repeat === 1);
      const theirs = theirsRows.filter((row) => row.passed).length;
      const verdict = mine === theirs
        ? `**exactly as many as the fixed build managed on the same pass (${theirs} of ${theirsRows.length})**. `
          + `So on these ten tasks the two changes bought no extra passes at all. They demonstrably changed `
          + `what happens — the unfixed build stops at 2048 tokens with the provider blamed for it, and is `
          + `cancelled at two minutes whatever it was asked for — but on this task set that did not turn into `
          + `a single additional task finished, and saying otherwise would be inventing a result.`
        : `against ${theirs} of ${theirsRows.length} for the fixed build on the same pass.`;
      say(`For comparison: that is ${verdict}`);
      say();
    }
  }
}

// A board where the clock did most of the failing cannot tell slow apart from never-finishing, and
// must say so rather than letting a 0% be read as an answer about quality.
const stoppedByClock = rows.filter((row) => row.killed).length;
if (stoppedByClock) {
  say("### How much of this is the clock");
  say();
  say(`${stoppedByClock} of ${rows.length} runs were stopped by the harness at the deadline rather than `
    + `finishing. Where that number is large for an agent, its score is **not** a statement about what `
    + `it would eventually have produced — only that it did not produce it inside the deadline every `
    + `contestant was given. A longer deadline was not affordable: the contestants have to be `
    + `interleaved inside one window for the comparison to mean anything, and the window is already `
    + `hours long. This board cannot tell slow apart from never-finishing.`);
  say();
  // An empty answer that the program itself calls a success is worse for a person than an error,
  // so it is counted separately wherever it happens.
  const quietlyEmpty = new Map();
  for (const row of rows)
    if (!row.answerChars && !row.agentError && !row.killed)
      quietlyEmpty.set(row.contestant, (quietlyEmpty.get(row.contestant) ?? 0) + 1);
  if (quietlyEmpty.size) {
    say(`Separately, some runs ended with the program reporting no error at all and returning an `
      + `empty answer — which reads to a person as "it finished" when nothing was produced:`);
    say();
    for (const [name, count] of quietlyEmpty)
      say(`- **${contestantById[name]?.name ?? name}**: ${count} of ${byContestant.get(name).length} runs`);
    say();
  }
}

say("## Did anyone touch the marking?");
say();
// The tamper detector is worth nothing if its result is never printed. A test file that moved is
// the most damning thing this board could find, so it is named here whether or not it changed a
// verdict — the pristine copy goes back before the check either way.
const tampered = rows.filter((row) => (row.touchedVerifiedFiles ?? []).length);
if (tampered.length) {
  say("**Yes.** These runs changed a file that decides the task. The pristine copy was put back before "
    + "marking, so the verdict stands — but the attempt is recorded here rather than quietly defeated:");
  say();
  for (const row of tampered)
    say(`- **${row.contestantName}**, \`${row.task}\` (pass ${row.repeat}): changed ${row.touchedVerifiedFiles.join(", ")}`);
  say();
} else {
  say(`No. On every one of the ${rows.length} runs, the files that decide a task were exactly as they `
    + `started. The check does not rely on that — the pristine copies are restored before marking `
    + `regardless — but nothing had to be restored.`);
  say();
}

say("## The load it ran under");
say();
const loads = rows.map((row) => row.loadBefore);
say(`This machine runs the owner's own work and cannot be quietened. The contestants were therefore `
  + `interleaved — one task at a time, each agent in turn, then round again — so that a quiet stretch `
  + `could not be handed to whichever agent happened to be running in it. Load average over the whole `
  + `window: **${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)}** on 5 processors.`);
say();

if (droppedRepeats) {
  say(`> ${droppedRepeats} result(s) from pass ${maxRepeat + 1} and later were left out of everything above: `
    + `that pass of the board did not finish, and a half-finished pass has a smaller denominator that `
    + `would flatter whichever agent happened to be in it. They are still in the results file.`);
  say();
}

say("## What this is not");
say();
const basis = combinedBasis(rows.map((row) => row.usage?.basis ?? "unknown"));
say(`- **Cost is not compared.** There is no price on file for a model running on the owner's own `
  + `card, so no money figure is printed at all; were one printed it would be ${costNote(basis, true)}. `
  + `The token counts above are what each program reported, and the three `
  + `programs do not count the same things: one reports what the provider said, one adds its own `
  + `estimate when the provider says nothing, and they disagree about whether a reasoning block is `
  + `output. The columns are printed so the difference in prompt size is visible, not so the totals `
  + `can be divided into money.`);
say(`- **Claude Code is not on this board and cannot be.** It talks only to Anthropic's API, so it `
  + `cannot use the P40 at all. Putting it here would mean one contestant on a frontier hosted model `
  + `and three on a 4B local one, which is a different contest, not a closer one.`);
say(`- **The tool surfaces are not the same**, and nothing can make them the same. Each agent's is `
  + `recorded with its rows; a task can be won by having the right built-in tool rather than by `
  + `judging well.`);
// Named on the page, not only in the findings file: a reader of the board should not have to go
// looking to learn that the harness was, in one specific way, kinder to one contestant.
const freeRetries = rows.filter((row) => row.retriedAfterRigFailure);
if (freeRetries.length) {
  const byWhom = new Map();
  for (const row of freeRetries) byWhom.set(row.contestant, (byWhom.get(row.contestant) ?? 0) + 1);
  say(`- **The harness was kinder to some rows than others.** ${freeRetries.length} run(s) were given a `
    + `second attempt because their error looked like the model server failing rather than the agent `
    + `(${[...byWhom].map(([name, count]) => `${contestantById[name]?.name.split(" (")[0] ?? name}: ${count}`).join(", ")}). `
    + `At least some of those were the agent's own timeout rather than the server's — see FINDINGS.md, `
    + `F6 and F7. No verdict changed, because every retried run failed again, but it is a thumb on the `
    + `scale and it is named here rather than quietly removed.`);
}
say(`- **These timings do not transfer.** They were measured on one oversubscribed VM inside one `
  + `window. Only the differences measured inside that window mean anything, and only where the `
  + `ranges separate.`);
say();

writeFileSync(outPath, lines.join("\n"));
process.stdout.write(`${outPath}: ${lines.length} lines, ${rows.length} results, ${refusals.length} refusal(s)\n`);

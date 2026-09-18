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

const tasksRun = [...new Set(rows.map((row) => row.task))];
const repeats = Math.max(...rows.map((row) => row.repeat));
const completenessOf = (name, rows) => {
  const want = rows[0].demonstrationOnly ? tasksRun.length : tasksRun.length * repeats;
  const have = new Set(rows.map((row) => `${row.task}__r${row.repeat}`));
  const missing = [];
  for (const task of tasksRun)
    for (let repeat = 1; repeat <= (rows[0].demonstrationOnly ? 1 : repeats); repeat++)
      if (!have.has(`${task}__r${repeat}`)) missing.push(`${name} ${task} r${repeat}`);
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
  say("The evaluation suite was asked whether these contestants may be put beside each other at all, "
    + "and raised no objection: every row below was measured on one machine, against one model, with "
    + "one deadline, over one unchanged task set, marked by one unchanged set of programs.");
  say();
  say(`| agent | tasks passed, per pass of the board | median run | model calls | tokens in/out | had to be rescued |`);
  say(`|---|---|---|---|---|---|`);
  for (const [name, contestantRows] of real) {
    const contestant = contestantById[name];
    const rate = passRateSpread(contestantRows);
    const time = elapsedSpread(contestantRows);
    const middle = [...contestantRows].sort((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(contestantRows.length / 2)];
    const rescued = contestantRows.filter((row) => row.rescued).length;
    const calls = contestantRows.filter((row) => typeof row.modelCalls === "number");
    say(`| ${contestant?.name ?? name} | **${pct(rate.mean)}** (${pct(rate.low)}–${pct(rate.high)} over ${rate.repeats}) `
      + `| ${secs(middle.elapsedMs)} (${secs(time.low)}–${secs(time.high)}) `
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
      } else {
        say(`- Tasks passed: **${nameA} and ${nameB} are a tie** on this board — their ranges overlap `
          + `(${pct(rateA.low)}–${pct(rateA.high)} against ${pct(rateB.low)}–${pct(rateB.high)}), so the difference in the means is not something this many repeats can see.`);
      }
      if (spreadsSeparate(timeA, timeB)) {
        separated++;
        const [faster, slower] = timeA.mean < timeB.mean ? [nameA, nameB] : [nameB, nameA];
        say(`- **Time: ${faster} is faster than ${slower}**, ranges apart (${secs(timeA.low)}–${secs(timeA.high)} against ${secs(timeB.low)}–${secs(timeB.high)}).`);
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
    say(`One pass over ${demoRows.length} tasks: **${demoRows.filter((row) => row.passed).length} passed**. `
      + `This is a single pass, so it has no spread and supports no claim that anything beats anything. `
      + `It is here to show what those changes were worth.`);
    say();
    const reasons = [...new Set(demoRows.map((row) => row.agentError ?? row.why))];
    for (const reason of reasons.slice(0, 4)) say(`- ${reason}`);
    say();
  }
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
say(`- **These timings do not transfer.** They were measured on one oversubscribed VM inside one `
  + `window. Only the differences measured inside that window mean anything, and only where the `
  + `ranges separate.`);
say();

writeFileSync(outPath, lines.join("\n"));
process.stdout.write(`${outPath}: ${lines.length} lines, ${rows.length} results, ${refusals.length} refusal(s)\n`);

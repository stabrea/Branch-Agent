/**
 * A synthetic task stream for Branch's learning core (src/fly-core).
 *
 * Twelve kinds of situation arrive in random order, each written in its own words with some
 * shared filler. Sixteen tools can be picked. In each situation one tool usually works (90%), one
 * all-rounder works half the time everywhere, and the rest rarely work (15%). The tool that is
 * best in one situation is a poor choice in others, so a learner that ignores the situation cannot
 * do better than the all-rounder. Halfway through, the best tool of every situation changes, to
 * see how each learner copes when what used to work stops working.
 *
 * Five pickers see exactly the same stream and pick one tool per task:
 * - none: no learning, a random tool every time;
 * - frequency: counts how often each tool worked, ignoring the situation;
 * - similar-prompts: Branch's current habit (src/tool-usage.ts `preload`): tools that worked for
 *   requests with overlapping words, weighted by the overlap, successes only;
 * - fly: the mushroom-body core.
 * - told-situation: a reference, not a rival: it is handed the hidden situation number, which no
 *   real picker has, and keeps worked-minus-failed counts per situation. It shows the ceiling.
 * Every picker explores at the same rate (a random tool 10% of the time) and falls back to a random
 * tool when it has nothing to go on. Nothing here is tuned per picker.
 *
 * Run it: `npm run build && node experiments/fly-core/stream.mjs` (add `--json` for raw numbers).
 */
import { Expansion } from "../../dist/fly-core/encode.js";
import { Circuit } from "../../dist/fly-core/circuit.js";
import { promptShingles } from "../../dist/tool-usage.js";

const tools = Array.from({ length: 16 }, (_, at) => `tool-${String(at).padStart(2, "0")}`);
const allRounder = "tool-15";
const kindWords = ["fix the code bug", "write a letter draft", "research and compare sources", "plot the data chart"];
const filler = ["please", "today", "quickly", "again", "thanks", "soon", "maybe", "carefully", "for", "me", "the", "report", "notes", "list", "week", "idea"];
const topicWords = Array.from({ length: 12 }, (_, s) => [`alpha${s}`, `bravo${s}`, `charlie${s}`, `delta${s}`]);

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickFrom = (random, list) => list[Math.floor(random() * list.length)];

/** The tool that usually works in situation `s`, before and after the change. */
export const bestTool = (s, phase) => tools[(s + (phase === 0 ? 0 : 5)) % 8];
function successChance(s, tool, phase) {
  if (tool === bestTool(s, phase)) return 0.9;
  return tool === allRounder ? 0.5 : 0.15;
}
function taskAt(random, s) {
  const topic = topicWords[s].filter(() => random() < 0.75);
  const words = [kindWords[s % 4], ...topic, pickFrom(random, filler), pickFrom(random, filler)];
  // Every task is in the same project: a project that followed the situation would hand the core
  // (the only picker that reads it) a clue about the hidden situation that the others never get.
  return { situation: s, prompt: words.join(" "), project: "home" };
}

/** One learner per picker, all with the same `choose(task)` / `learn(task, tool, ok)` shape. */
function makePickers(seed) {
  const expansion = new Expansion(`stream-${seed}`), circuit = new Circuit();
  const counts = new Map(), history = [], table = new Map();
  let clock = Date.UTC(2026, 0, 1);
  return {
    none: { choose: () => null, learn: () => undefined },
    frequency: {
      choose: () => best(counts),
      learn: (_task, tool, ok) => { if (ok) counts.set(tool, (counts.get(tool) ?? 0) + 1); },
    },
    "similar-prompts": {
      choose: (task) => best(similarScores(history, task.prompt)),
      learn: (task, tool, ok) => { history.push({ shingles: promptShingles(task.prompt), tool, ok }); },
    },
    fly: {
      choose: (task) => {
        const top = circuit.rank(expansion.code(task), "tool", clock)[0];
        return top && top.score > 0 ? top.action : null;
      },
      learn: (task, tool, ok) => {
        clock += 30 * 60_000;
        circuit.learn(expansion.code(task), [{ action: tool, kind: "tool", step: 0 }], ok ? 1 : -1, clock);
      },
    },
    "told-situation": {
      choose: (task) => best(table.get(task.situation) ?? new Map()),
      learn: (task, tool, ok) => {
        const row = table.get(task.situation) ?? new Map();
        row.set(tool, (row.get(tool) ?? 0) + (ok ? 1 : -1));
        table.set(task.situation, row);
      },
    },
  };
}
function best(scores) {
  let chosen = null, top = 0;
  for (const [tool, score] of scores) if (score > top || (score === top && chosen && tool < chosen)) { chosen = tool; top = score; }
  return top > 0 ? chosen : null;
}
/** src/tool-usage.ts `preload`, reduced to one tool: overlap-weighted successes, 0.2 overlap floor. */
function similarScores(history, prompt) {
  const want = new Set(promptShingles(prompt)), scores = new Map(), runs = new Map();
  for (const row of history) {
    if (!row.ok) continue;
    const shared = row.shingles.filter((gram) => want.has(gram)).length;
    const alike = shared / (row.shingles.length + want.size - shared);
    if (alike < 0.2) continue;
    scores.set(row.tool, (scores.get(row.tool) ?? 0) + alike);
    runs.set(row.tool, (runs.get(row.tool) ?? 0) + 1);
  }
  for (const [tool, count] of runs) if (count < 2) scores.delete(tool);
  return scores;
}

/** Runs one seed; returns per-picker success and best-pick rates for each block of tasks. */
export function runStream({ seed = 1, tasks = 1200, block = 100, explore = 0.1 } = {}) {
  const pickers = makePickers(seed), names = Object.keys(pickers);
  const world = generator(seed * 7919), choices = Object.fromEntries(names.map((name, at) => [name, generator(seed * 104729 + at)]));
  const blocks = [];
  for (let at = 0; at < tasks; at += 1) {
    if (at % block === 0) blocks.push(Object.fromEntries(names.map((name) => [name, { ok: 0, best: 0, n: 0 }])));
    const phase = at < tasks / 2 ? 0 : 1, s = Math.floor(world() * 12), task = taskAt(world, s), luck = world();
    for (const name of names) {
      const random = choices[name], wanted = random() < explore ? null : pickers[name].choose(task);
      const tool = wanted ?? pickFrom(random, tools);
      const ok = luck < successChance(s, tool, phase);
      pickers[name].learn(task, tool, ok);
      const tally = blocks.at(-1)[name];
      tally.n += 1; tally.ok += ok ? 1 : 0; tally.best += tool === bestTool(s, phase) ? 1 : 0;
    }
  }
  return { seed, names, blocks: blocks.map((b) => Object.fromEntries(names.map((n) => [n, { success: b[n].ok / b[n].n, bestPick: b[n].best / b[n].n }]))) };
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
/** Several seeds, averaged per block. */
export function summarise(seeds = [1, 2, 3, 4, 5], options = {}) {
  const runs = seeds.map((seed) => runStream({ ...options, seed }));
  const names = runs[0].names;
  const blocks = runs[0].blocks.map((_, at) => Object.fromEntries(names.map((name) => [name, {
    success: mean(runs.map((run) => run.blocks[at][name].success)),
    bestPick: mean(runs.map((run) => run.blocks[at][name].bestPick)),
  }])));
  return { seeds, names, blocks };
}

function table(summary) {
  const lines = [`block  ${summary.names.map((n) => n.padStart(17)).join("")}   (success rate / picked the best tool, mean of seeds ${summary.seeds.join(",")})`];
  summary.blocks.forEach((b, at) => lines.push(`${String(at + 1).padStart(5)}  ${summary.names
    .map((n) => `${(b[n].success * 100).toFixed(1)}% / ${(b[n].bestPick * 100).toFixed(1)}%`.padStart(17)).join("")}`));
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summary = summarise();
  console.log(process.argv.includes("--json") ? JSON.stringify(summary, null, 2) : table(summary));
}

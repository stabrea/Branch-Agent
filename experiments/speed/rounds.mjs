/**
 * What a bench cell spent its rounds on, read from the cell's own database.
 *
 * On a small local model most of these tasks do not finish inside the deadline either way, so
 * "passed" says little. What does say something, and is true whether or not the task finished:
 *
 *   - how many rounds the task took at all;
 *   - how many of those rounds did nothing but look for a tool (`tools.search`, `tools.expand`,
 *     `tools.describe`) — every one of those is a whole round trip spent not working, and is what
 *     the coding working set is meant to remove;
 *   - how many tool calls the model asked for per round, which is what the batching line and
 *     `files.read_many` are meant to raise;
 *   - how many calls actually ran together.
 *
 *   node experiments/speed/rounds.mjs <state-dir> [<state-dir> …]
 *
 * `<state-dir>` is the scoreboard's `state/` folder; each cell is a folder of its own inside it.
 */
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const searchers = new Set(["tools.search", "tools.expand", "tools.describe", "tools.note"]);

/** One cell's numbers, or null when its database is not there. */
export function readCell(dataDir) {
  const file = join(dataDir, "branch.sqlite");
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = db.prepare("SELECT kind, data FROM events WHERE kind IN "
      + "('model.completed','tool.started','tools.together','rounds.exhausted')").all();
    const rounds = events.filter((row) => row.kind === "model.completed")
      .map((row) => JSON.parse(String(row.data)).toolCalls ?? 0);
    const names = events.filter((row) => row.kind === "tool.started")
      .map((row) => String(JSON.parse(String(row.data)).name ?? ""));
    const together = events.filter((row) => row.kind === "tools.together")
      .map((row) => (JSON.parse(String(row.data)).calls ?? []).length);
    const calls = rounds.reduce((total, n) => total + n, 0);
    return {
      rounds: rounds.length,
      calls,
      callsPerRound: rounds.length ? calls / rounds.length : 0,
      roundsWithSeveral: rounds.filter((n) => n > 1).length,
      lookingForTools: names.filter((name) => searchers.has(name)).length,
      ranTogether: together.reduce((total, n) => total + n, 0),
      hitTheCeiling: events.some((row) => row.kind === "rounds.exhausted"),
    };
  } finally { db.close(); }
}

const totals = new Map();
for (const stateDir of process.argv.slice(2)) {
  for (const cell of await readdir(stateDir)) {
    const numbers = readCell(join(stateDir, cell));
    if (!numbers) continue;
    // A cell folder is named <contestant>__<task>__r<n>.
    const [row = cell] = cell.split("__");
    if (!totals.has(row)) totals.set(row, []);
    totals.get(row).push({ cell, ...numbers });
    console.log(`${cell.padEnd(46)} ${String(numbers.rounds).padStart(3)} rounds, `
      + `${String(numbers.calls).padStart(3)} calls (${numbers.callsPerRound.toFixed(2)}/round), `
      + `${numbers.roundsWithSeveral} rounds asked for several, `
      + `${numbers.lookingForTools} spent looking for a tool, ${numbers.ranTogether} ran together`
      + `${numbers.hitTheCeiling ? ", hit the round ceiling" : ""}`);
  }
}

const mid = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
console.log("");
for (const [row, cells] of totals) {
  const sum = (field) => cells.reduce((total, one) => total + one[field], 0);
  console.log(`${row}: ${cells.length} cells — median ${mid(cells.map((c) => c.rounds))} rounds, `
    + `${(sum("calls") / Math.max(1, sum("rounds"))).toFixed(2)} tool calls a round, `
    + `${sum("roundsWithSeveral")} rounds asked for more than one thing, `
    + `${sum("lookingForTools")} rounds spent looking for a tool, `
    + `${sum("ranTogether")} calls ran together`);
}

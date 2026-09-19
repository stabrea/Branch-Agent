/**
 * Prints the coding bench's results as markdown: one summary row per contestant and one row per
 * task. Every number comes from the runner's JSONL; nothing is estimated here.
 *
 *   node experiments/coding-bench/report.mjs results.jsonl [more.jsonl ...]
 *
 * A difference between two contestants is only called a win when one passed at least three tasks
 * the other failed — the bar docs/agents/coding-bench.md states — and the helper below says so.
 */
import { readFileSync } from "node:fs";

const rows = process.argv.slice(2).flatMap((file) =>
  readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
if (!rows.length) throw new Error("no results given");

const ids = [...new Set(rows.map((row) => row.contestant))];
const tasks = [...new Set(rows.map((row) => row.task))];
const median = (values) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (values) => values.reduce((total, v) => total + (typeof v === "number" ? v : 0), 0);
const seconds = (ms) => (ms === null ? "—" : `${Math.round(ms / 1000)} s`);

const out = [];
out.push("| contestant | finished (tests pass) | median wall time | tokens in / out (reported) | edits refused / tried | rescued |");
out.push("|---|---|---|---|---|---|");
for (const id of ids) {
  const mine = rows.filter((row) => row.contestant === id);
  const passed = mine.filter((row) => row.passed).length;
  const failed = mine.map((row) => row.failedEdits);
  const tried = mine.map((row) => row.edits);
  const edits = failed.every((v) => v === null) ? "not reported" : `${sum(failed)} / ${sum(tried)}`;
  out.push(`| ${id} | **${passed} / ${mine.length}** | ${seconds(median(mine.map((row) => row.elapsedMs)))} | `
    + `${sum(mine.map((row) => row.usage?.input))} / ${sum(mine.map((row) => row.usage?.output))} | ${edits} | `
    + `${mine.filter((row) => row.rescued).length} |`);
}
out.push("");
out.push(`| task | ${ids.join(" | ")} |`);
out.push(`|---|${ids.map(() => "---").join("|")}|`);
for (const task of tasks) {
  const cells = ids.map((id) => {
    const row = rows.find((r) => r.contestant === id && r.task === task);
    if (!row) return "—";
    return `${row.passed ? "PASS" : "fail"} ${seconds(row.elapsedMs)}`;
  });
  out.push(`| ${task} | ${cells.join(" | ")} |`);
}
out.push("");
out.push("Pairwise, tasks one passed that the other failed (a win needs at least 3):");
out.push("");
for (const a of ids) for (const b of ids) {
  if (a >= b) continue;
  const only = (x, y) => tasks.filter((task) => rows.some((r) => r.contestant === x && r.task === task && r.passed)
    && !rows.some((r) => r.contestant === y && r.task === task && r.passed));
  const ab = only(a, b), ba = only(b, a);
  const verdict = ab.length - ba.length >= 3 ? `${a} ahead` : ba.length - ab.length >= 3 ? `${b} ahead` : "no claim";
  out.push(`- ${a} vs ${b}: ${ab.length} only ${a} (${ab.join(", ") || "none"}), ${ba.length} only ${b} (${ba.join(", ") || "none"}) — ${verdict}`);
}
process.stdout.write(`${out.join("\n")}\n`);

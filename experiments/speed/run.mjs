/**
 * Runs the scripted coding tasks and prints where the time went.
 *
 *   node experiments/speed/run.mjs                  # 200 ms pretend round trip
 *   node experiments/speed/run.mjs --latency 800    # a slow hosted model
 *   node experiments/speed/run.mjs --json out.jsonl
 *
 * Build first (`npm run build`): it measures `dist/`, not the sources.
 */
import { writeFile } from "node:fs/promises";
import { measure, line } from "./harness.mjs";
import { tasks } from "./tasks.mjs";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};

const latencyMs = Number(flag("latency", 200));
const out = flag("json", "");
const rows = [];

for (const task of tasks) {
  for (const shape of ["perCall", "batched"]) {
    const result = await measure({ steps: task[shape], prompt: task.prompt, latencyMs });
    if (result.status !== "completed") throw new Error(`${task.name}/${shape} ended ${result.status}: ${result.output}`);
    rows.push({ task: task.name, shape, latencyMs, ...trimmed(result) });
    console.log(line(`${task.name} / ${shape}`, result));
  }
}

const saved = (name) => {
  const one = rows.find((row) => row.task === name && row.shape === "perCall");
  const many = rows.find((row) => row.task === name && row.shape === "batched");
  return `${name}: ${one.modelCalls} -> ${many.modelCalls} model calls, `
    + `${one.wallMs.toFixed(0)} -> ${many.wallMs.toFixed(0)} ms wall `
    + `(${(100 - (many.wallMs / one.wallMs) * 100).toFixed(0)}% less at a ${latencyMs} ms round trip)`;
};
console.log("");
for (const task of tasks) console.log(saved(task.name));

if (out) {
  await writeFile(out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log(`\nwritten to ${out}`);
}

function trimmed({ requests: _requests, output: _output, ...rest }) { return rest; }

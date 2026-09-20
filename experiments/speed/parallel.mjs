/**
 * What running a turn's look-only calls at the same time is worth.
 *
 * One reply asking for several files, run as the app ships (one after another) and with the "fewer
 * rounds" coding part on (together). The number that moves is the tools' time **on the clock**, not
 * added up — added up it goes *higher* under concurrency, because the reads contend for the same
 * disk. What matters is how long the turn took.
 *
 * A local file read is a millisecond or two, so one run of this is mostly noise; it runs each way
 * several times and reports the middle one. The saving grows with how slow the tools are: a turn
 * holding two commands that each take two seconds costs four seconds one after another and two
 * together.
 *
 *   node experiments/speed/parallel.mjs [--latency 200] [--files 8] [--repeat 5]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { measure, step, answer, line } from "./harness.mjs";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const latencyMs = flag("latency", 200);
const howMany = flag("files", 8);
const repeat = flag("repeat", 5);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const seed = async (workspace) => {
  await mkdir(join(workspace, "src"), { recursive: true });
  for (let n = 0; n < howMany; n++)
    await writeFile(join(workspace, "src", `f${n}.js`), `// file ${n}\nexport const v${n} = ${n};\n`.repeat(400));
};
const steps = [
  step(Array.from({ length: howMany }, (_, n) => ["files.read", { path: `src/f${n}.js` }])),
  answer("Read them all."),
];

const runs = { off: [], on: [] };
for (let pass = 0; pass < repeat; pass++) {
  for (const on of [false, true]) {
    const result = await measure({ steps, prompt: `read the ${howMany} source files`, latencyMs, seed,
      ...(on ? { before: (app) => app.coding.setMode("fewer-rounds", "on") } : {}) });
    if (result.status !== "completed") throw new Error(`ended ${result.status}: ${result.output}`);
    runs[on ? "on" : "off"].push(result);
    if (pass === 0) console.log(`${on ? "fewer-rounds on " : "as it ships     "}: ${line(`read-${howMany}`, result)}`);
  }
}

const middle = (which, field) => median(runs[which].map((row) => row[field]));
const say = (what, field, note = "") =>
  console.log(`  ${what.padEnd(19)} ${middle("off", field).toFixed(0).padStart(4)} ms -> ${middle("on", field).toFixed(0).padStart(4)} ms${note}`);

console.log(`\nMiddle of ${repeat} runs each way, ${howMany} files, a ${latencyMs} ms pretend round trip:`);
say("tools on the clock:", "toolWallMs");
say("tools added up:", "toolMs", "   (higher on purpose: they contend for the disk)");
say("Branch's own code:", "overheadMs");
say("the whole turn:", "wallMs");
console.log(`  calls run together: ${runs.on[0].callsRunTogether} in ${runs.on[0].groupsRunTogether} group(s); `
  + `${runs.off[0].callsRunTogether} while the part is off`);

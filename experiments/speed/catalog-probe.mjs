/**
 * Does a coding task already have the tools it needs in its first round, or does it have to spend a
 * turn asking for them?
 *
 * Every turn spent on `tools.search` or `tools.expand` is a whole round trip that did no work, so
 * this is the same question as "how many turns does the task take". Nothing here removes a tool or
 * changes a switch: it only counts which tier each tool a coding task needs lands in on round one.
 *
 *   node experiments/speed/catalog-probe.mjs                  # as the app ships
 *   node experiments/speed/catalog-probe.mjs --fewer-rounds   # with the "fewer rounds" part on
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../../dist/index.js";
import { seedWorkspace } from "./harness.mjs";

/** What a coding task needs before it can begin at all: read, search, change. */
const workingSet = ["files.read", "files.grep", "files.list", "files.glob", "files.edit", "files.write"];
/** The wider set it may reach for once it is under way. */
const wider = [...workingSet, "files.patch", "code.patch", "code.check", "code.map", "code.diagnostics", "code.run"];

const prompts = [
  "range(1, 5) should include 5. Fix it in src/range.js and add a test.",
  "Rename the helper in src/sum.js from sum to total everywhere it is used.",
  "This stack trace says mean() divides by zero on an empty list. Find it and fix it.",
  "Add a --verbose flag to the command line and document it in the README.",
  "The docs describe an option that no longer exists. Update them from the code.",
];

const root = await mkdtemp(join(tmpdir(), "branch-probe-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await seedWorkspace(workspace);
const provider = { name: "scripted", sent: [], async complete(request) {
  provider.sent.push(request.tools.map((tool) => tool.name));
  return { content: "Done.", toolCalls: [] };
} };
const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
if (process.argv.includes("--fewer-rounds")) app.coding.setMode("fewer-rounds", "on");

console.log(`${app.registry.descriptions(new Set(app.registry.permissions())).length} tools registered; `
  + `fewer-rounds is ${app.coding.modes()["fewer-rounds"]}\n`);
let missingTotal = 0;
for (const prompt of prompts) {
  const run = await app.runtime.run({ prompt });
  const [size] = app.store.events(run.id).filter((e) => e.kind === "catalog.size").map((e) => e.data);
  const [pre] = app.store.events(run.id).filter((e) => e.kind === "catalog.preselected").map((e) => e.data);
  const shown = new Set(provider.sent.at(-1) ?? []);
  const gone = workingSet.filter((name) => !shown.has(name));
  missingTotal += gone.length;
  console.log(`"${prompt.slice(0, 52)}…"`);
  console.log(`  guessed toolboxes: ${pre.guessed.join(", ") || "(none)"}; ${size.shown} tools described, ~${size.estimatedTokens} tokens`);
  console.log(`  working set: ${workingSet.length - gone.length}/${workingSet.length} described in full${gone.length ? ` — a search away: ${gone.join(", ")}` : ""}`);
  console.log(`  wider coding set: ${wider.filter((name) => shown.has(name)).length}/${wider.length} described in full\n`);
}
console.log(`Across ${prompts.length} coding prompts, ${missingTotal} of ${prompts.length * workingSet.length} `
  + "working-set places needed a search before the task could begin.");
await app.close();
await rm(root, { recursive: true, force: true }).catch(() => undefined);

/**
 * What one round of a coding task actually sends, split into the parts that repeat.
 *
 * Pi finishes the bench's first task in 6 rounds and 10,282 input tokens; Branch took 9-10 rounds
 * and 33,456. Rounds are the bigger lever and are what this branch works on, but it is worth
 * knowing where the per-round payload goes before anyone reaches for it.
 *
 *   node experiments/speed/payload.mjs [--fewer-rounds]
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../../dist/index.js";
import { seedWorkspace } from "./harness.mjs";

const tokens = (text) => Math.ceil(text.length / 4);
const root = await mkdtemp(join(tmpdir(), "branch-payload-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await seedWorkspace(workspace);
let seen;
const provider = { name: "scripted", async complete(request) {
  seen ??= request;
  return { content: "Done.", toolCalls: [] };
} };
const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
if (process.argv.includes("--fewer-rounds")) app.coding.setMode("fewer-rounds", "on");
await app.runtime.run({ prompt: "range(1, 5) should include 5. Fix it in src/range.js and add a test." });

const system = seen.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
const rest = seen.messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
const tools = JSON.stringify(seen.tools);
console.log(`fewer-rounds is ${app.coding.modes()["fewer-rounds"]}\n`);
console.log(`  tool list     ~${String(tokens(tools)).padStart(5)} tokens  (${seen.tools.length} tools of ${app.registry.names().length} registered)`);
console.log(`  instructions  ~${String(tokens(system)).padStart(5)} tokens`);
console.log(`  the request   ~${String(tokens(rest)).padStart(5)} tokens`);
console.log(`  first round   ~${String(tokens(tools) + tokens(system) + tokens(rest)).padStart(5)} tokens in all`);
await app.close();
await rm(root, { recursive: true, force: true }).catch(() => undefined);

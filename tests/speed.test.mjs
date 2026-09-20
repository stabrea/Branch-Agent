import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/** A provider driven by a script, keeping the whole tool section of every request it was sent. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({
      names: request.tools.map((tool) => tool.name),
      bytes: JSON.stringify(request.tools),
    });
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)];
    return typeof step === "function" ? step(request) : step;
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const calls = (...wanted) => () => ({ content: "", toolCalls: wanted.map(([name, args], at) =>
  ({ id: `c${at}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) })) });

async function fixture(t, steps, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-speed-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "range.js"), "export function range(a, b) {\n  const out = [];\n  for (let n = a; n < b; n += 1) out.push(n);\n  return out;\n}\n");
  await writeFile(join(workspace, "src", "sum.js"), "export const sum = (xs) => xs.reduce((a, b) => a + b, 0);\n");
  await writeFile(join(workspace, "README.md"), "# demo\n");
  const provider = scripted(steps);
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace, provider };
}

test("D: a tool arriving mid-task is added to the list, and nothing already sent is taken away", async (t) => {
  // The task reads for a few rounds, then edits. The edit brings files.edit into the list for the
  // first time; before this fix it took the last place under the count and pushed whichever tool
  // scored lowest out, so a provider holding the front of the request had to read it all again.
  const { app, provider } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }]),
    calls(["files.read", { path: "src/range.js" }]),
    calls(["files.read", { path: "README.md" }]),
    calls(["files.list", { path: "src" }]),
    calls(["files.edit", { path: "src/sum.js", find: "export const sum", replace: "export const total" }]),
    calls(["files.read", { path: "src/sum.js" }]),
    say("Done."),
  ]);
  const run = await app.runtime.run({ prompt: "Rename the helper in src/sum.js from sum to total everywhere it is used." });
  assert.equal(run.status, "completed", run.output);
  assert.ok(provider.requests.length >= 5, `${provider.requests.length} rounds`);

  const sent = new Set();
  const lost = [];
  for (const [at, request] of provider.requests.entries()) {
    for (const name of sent) if (!request.names.includes(name)) lost.push(`${name} was gone by round ${at + 1}`);
    for (const name of request.names) sent.add(name);
  }
  assert.deepEqual(lost, [], `tools were taken away mid-task: ${lost.join("; ")}`);

  const edited = provider.requests.findIndex((request) => request.names.includes("files.edit"));
  assert.ok(edited > 0, "files.edit arrived part-way through, which is what this test is about");
  // The round it arrived in is longer than the one before, not the same length with a swap in it.
  assert.ok(provider.requests[edited].names.length > provider.requests[edited - 1].names.length,
    "the list grew when the tool arrived rather than trading one tool for another");
});

test("D: the tool section still respects its token budget once tools are kept", async (t) => {
  const { app, provider } = await fixture(t, [
    calls(["files.read", { path: "src/range.js" }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    calls(["files.write", { path: "src/new.js", content: "export const x = 1;\n" }]),
    calls(["files.list", { path: "src" }]),
    say("Done."),
  ]);
  const run = await app.runtime.run({ prompt: "fix the range helper and add a file" });
  assert.equal(run.status, "completed", run.output);
  const sizes = app.store.events(run.id).filter((e) => e.kind === "catalog.size").map((e) => e.data);
  assert.ok(sizes.length >= 4);
  for (const size of sizes)
    assert.ok(size.estimatedTokens < 2500, `a round sent ~${size.estimatedTokens} tokens of tools, over the 2500 budget`);
  assert.ok(provider.requests.every((request) => request.names.includes("tools.search")),
    "every round still offers the search, so nothing became unreachable");
});

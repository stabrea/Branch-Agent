import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, parallelGroups, parallelLimit } from "../dist/index.js";

/** A provider driven by a script, keeping the whole tool section of every request it was sent. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({
      names: request.tools.map((tool) => tool.name),
      bytes: JSON.stringify(request.tools),
      system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join(" "),
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

test("E: with fewer rounds on, a coding task starts with the tools it needs", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  // The request the measurement found worst: it opens the code and documents toolboxes, the words
  // shout "document" and "README", and every place went to documents tools.
  const prompt = "Add a --verbose flag to the command line and document it in the README.";
  const working = ["files.read", "files.grep", "files.list", "files.glob", "files.edit", "files.write"];

  await app.runtime.run({ prompt });
  const shipped = provider.requests.at(-1).names;
  assert.ok(working.some((name) => !shipped.includes(name)),
    "as the app ships, at least one of the working set is a search away (this is what the part is for)");

  app.coding.setMode("fewer-rounds", "on");
  await app.runtime.run({ prompt });
  const now = provider.requests.at(-1).names;
  for (const name of working)
    assert.ok(now.includes(name), `${name} was still not described in full; the task would have to search for it`);
  assert.ok(now.includes("tools.search"), "searching is still offered, so nothing became unreachable");
});

test("E: switched off, the part changes nothing and its tool is not registered", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  assert.equal(app.coding.modes()["fewer-rounds"], "off", "it ships off");
  assert.ok(!app.registry.names().includes("files.read_many"));
  const run = await app.runtime.run({ prompt: "Rename the helper in src/sum.js from sum to total." });
  assert.equal(run.status, "completed");
  const system = provider.requests.length;
  assert.ok(system > 0);
});

test("B: the line about asking for several things at once is there only when the part is on", async (t) => {
  const { app, provider } = await fixture(t, [say("Done.")]);
  await app.runtime.run({ prompt: "tidy up src/sum.js" });
  assert.ok(!provider.requests.at(-1).system.includes("ask for them all in one go"), "off: the line is not sent");
  app.coding.setMode("fewer-rounds", "on");
  await app.runtime.run({ prompt: "tidy up src/sum.js" });
  assert.ok(provider.requests.at(-1).system.includes("ask for them all in one go"), "on: the line is sent");
});

test("C: read_many reads several files in one call, and a path it may not read is named", async (t) => {
  const { app, workspace, provider } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js", "../outside.txt", "src/range.js", "src/.env", "src/missing.js"] }]),
    say("Read them."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  await writeFile(join(workspace, "src", ".env"), "SECRET=1\n");
  const run = await app.runtime.run({ prompt: "read the source files" });
  assert.equal(run.status, "completed", run.output);
  const [done] = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  const result = done.result;
  assert.equal(result.read, 2, "the two readable files came back");
  assert.equal(result.refused, 3, "the three that may not be read were refused");
  const by = Object.fromEntries(result.files.map((one) => [one.path, one]));
  assert.ok(by["src/sum.js"].content.includes("reduce"), "a file that was read carries its text");
  assert.ok(by["src/range.js"].content.includes("const out"));
  for (const bad of ["../outside.txt", "src/.env", "src/missing.js"]) {
    assert.ok(by[bad], `${bad} is named in the answer rather than quietly dropped`);
    assert.ok(by[bad].error, `${bad} says why it could not be read`);
    assert.ok(!by[bad].error.includes(workspace), `${bad}'s reason names this computer's folders`);
    assert.ok(!by[bad].content, `${bad} handed back no text`);
  }
  assert.ok(provider.requests.length >= 2, "the task carried on after the partial refusal");
});

test("C: reading through read_many counts as reading, per file, for the read-before-edit guard", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js", "src/range.js"] }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    calls(["files.edit", { path: "src/sum.js", find: "export const sum", replace: "export const total" }]),
    say("Changed both."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "fix the range helper and rename sum" });
  assert.equal(run.status, "completed", run.output);
  const edits = app.store.events(run.id).filter((e) => e.kind === "tool.completed")
    .map((e) => e.data).filter((data) => data.name === "files.edit");
  assert.equal(edits.length, 2, "both edits ran");
  for (const edit of edits)
    assert.ok(edit.result.ok !== false, `an edit was refused after read_many had read the file: ${JSON.stringify(edit.result).slice(0, 200)}`);
});

test("C: a file the task never read is still refused when reading first is on", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read_many", { paths: ["src/sum.js"] }]),
    calls(["files.edit", { path: "src/range.js", find: "n < b", replace: "n <= b" }]),
    say("Tried."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "fix the range helper" });
  assert.equal(run.status, "completed", run.output);
  const [edit] = app.store.events(run.id).filter((e) => e.kind === "tool.failed")
    .map((e) => e.data).filter((data) => data.name === "files.edit");
  assert.ok(edit, "reading one file does not unlock editing another: the edit was refused");
  assert.match(edit.error, /read "src\/range\.js" with files\.read first/, "the refusal says to read it first, in plain words");
});

/* ---------- A: calls that only look at things may run together ---------- */

test("A: only look-only calls about different things share a group, and order is kept", () => {
  const rules = {
    readOnly: (name) => name.startsWith("files.read") || name === "files.grep" || name === "user.ask",
    targetOf: (call) => JSON.parse(call.arguments).path ?? "",
    alone: ["tools.search", "user.ask"],
  };
  const call = (name, path) => ({ id: name + path, name, arguments: JSON.stringify({ path }) });
  const groups = parallelGroups([
    call("files.read", "a"), call("files.read", "b"), call("files.grep", "c"),
    call("files.write", "d"),
    call("files.read", "e"), call("files.read", "e"),
    call("user.ask", "f"),
    call("files.read", "g"),
  ], rules);
  assert.deepEqual(groups.map((group) => group.map((one) => one.name + ":" + JSON.parse(one.arguments).path)), [
    ["files.read:a", "files.read:b", "files.grep:c"],
    ["files.write:d"],
    ["files.read:e"],
    ["files.read:e"],
    ["user.ask:f"],
    ["files.read:g"],
  ], "a change runs alone; two calls about the same thing never share; asking runs alone; order never moves");
  assert.deepEqual(groups.flat().map((one) => one.id), [
    "files.reada", "files.readb", "files.grepc", "files.writed", "files.reade", "files.reade", "user.askf", "files.readg",
  ], "every call is still there, exactly once, in the order the model asked");
});

test("A: no group is bigger than the limit", () => {
  const rules = { readOnly: () => true, targetOf: (call) => call.id, alone: [] };
  const many = Array.from({ length: 20 }, (_, n) => ({ id: `c${n}`, name: "files.read", arguments: "{}" }));
  const groups = parallelGroups(many, rules);
  assert.ok(groups.every((group) => group.length <= parallelLimit), "a reply cannot open more than the limit at once");
  assert.equal(groups.flat().length, 20, "and nothing is lost");
});

test("A: with the part on, reads of different files run together and the transcript order is unchanged", async (t) => {
  const paths = ["src/sum.js", "src/range.js", "README.md"];
  const { app } = await fixture(t, [
    calls(...paths.map((path) => ["files.read", { path }])),
    say("Read them."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  const run = await app.runtime.run({ prompt: "read the three files" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "the three reads were one group");
  assert.deepEqual(together[0].calls, ["files.read", "files.read", "files.read"]);
  // Every call still has its own record and its own receipt.
  const done = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  assert.equal(done.length, 3, "three calls, three receipts");
  assert.equal(new Set(done.map((one) => one.receipt.hash)).size, 3, "each call was signed for on its own");
  // The conversation itself reads exactly as it would have one call at a time: the answers are in
  // the order the model asked for them, whatever order they actually finished in.
  const answers = app.store.messages(run.sessionId).filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content).result.path);
  assert.deepEqual(answers, paths, "the transcript is in the order the model asked, not the order they finished");
  // The timeline, by contrast, is allowed to say when each one really finished.
  assert.equal(new Set(done.map((one) => one.result.path)).size, 3, "all three were read");
});

test("A: a change in the same reply is not run beside the reads, and reading first still holds", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }],
      ["files.edit", { path: "README.md", find: "# demo", replace: "# demonstration" }]),
    say("Tried."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  app.coding.setMode("read-first", "on");
  const run = await app.runtime.run({ prompt: "read the source and retitle the readme" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "only the two reads ran together");
  assert.deepEqual(together[0].calls, ["files.read", "files.read"]);
  const [refused] = app.store.events(run.id).filter((e) => e.kind === "tool.failed").map((e) => e.data);
  assert.ok(refused && refused.name === "files.edit", "the change was still held to reading the file first");
  assert.match(refused.error, /files\.read first/);
});

test("A: a rule that refuses one call in a group still refuses it, and the others still run", async (t) => {
  const { app, workspace } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "keep.txt" }],
      ["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  app.coding.setMode("fewer-rounds", "on");
  await writeFile(join(workspace, "keep.txt"), "private\n");
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "files.read", match: "keep.txt", decision: "deny", remember: "always" });
  const run = await app.runtime.run({ prompt: "read the files" });
  assert.equal(run.status, "completed", run.output);
  const together = app.store.events(run.id).filter((e) => e.kind === "tools.together").map((e) => e.data);
  assert.equal(together.length, 1, "they were still one group");
  const denied = app.store.events(run.id).filter((e) => e.kind === "policy.denied").map((e) => e.data);
  assert.equal(denied.length, 1, "the rule fired for exactly the one call it names");
  assert.equal(denied[0].name, "files.read");
  const done = app.store.events(run.id).filter((e) => e.kind === "tool.completed").map((e) => e.data);
  assert.equal(done.length, 2, "the other two calls still ran");
});

test("A: switched off, calls run one after another exactly as before", async (t) => {
  const { app } = await fixture(t, [
    calls(["files.read", { path: "src/sum.js" }], ["files.read", { path: "src/range.js" }]),
    say("Done."),
  ]);
  const run = await app.runtime.run({ prompt: "read the two files" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tools.together").length, 0,
    "nothing ran together while the part is off");
  assert.equal(app.store.events(run.id).filter((e) => e.kind === "tool.completed").length, 2);
});

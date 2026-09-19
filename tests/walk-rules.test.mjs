import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/walk-rules: a tool that walks a folder obeys the owner's rules for every file and folder it
 * lists or reads, not only for the folder it starts from (docs/agents/STATUS-walk-rules.md).
 * Every model is a scripted fake; nothing opens a window.
 */

const secretText = "SECRET-LEDGER-4417";
const openText = "OPEN-NOTE-2231";

async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-walk-rules-"));
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const step = steps?.[Math.min(provider.requests.length - 1, steps.length - 1)];
    return step ? step(request) : { content: "done", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await mkdir(join(workspace, "finance", "2026"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), `total ${secretText}\n`);
  await writeFile(join(workspace, "finance", "2026", "q2.md"), `# Q2\n\n${secretText}\n`);
  await writeFile(join(workspace, "notes", "open.txt"), `plan ${openText}\n`);
  await writeFile(join(workspace, "readme.md"), `# Readme\n\n${openText}\n`);
  return { app, root, workspace, provider };
}
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const say = (content) => () => ({ content, toolCalls: [] });
/** "Never allow anything under finance", as the owner writes it. */
async function financeRule(app, decision = "deny", extra = {}) {
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision, remember: "always", resource: { kind: "path", pattern: "finance" }, ...extra });
}
/** Runs one tool call through a model's turn and returns what the tool answered, or the refusal. */
async function runTool(t, name, args, setup = financeRule) {
  const context = await fixture(t, [call(name, args), say("done")]);
  await setup(context.app);
  const run = await context.app.runtime.run({ prompt: "look" });
  const completed = context.app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  const denied = context.app.store.events(run.id).filter((event) => event.kind === "policy.denied");
  const failed = context.app.store.events(run.id).filter((event) => event.kind === "tool.failed");
  return { ...context, run, result: completed[0]?.data.result, denied: denied[0]?.data, failed: failed[0]?.data };
}
const text = (value) => JSON.stringify(value ?? null);
function assertLeftOut(result, what) {
  assert.ok(result, `${what}: the tool answered`);
  assert.doesNotMatch(text(result), new RegExp(secretText), `${what}: nothing from finance is in the answer`);
  assert.doesNotMatch(text(result).replace(/the folder finance/g, ""), /q1\.txt|q2\.md|finance\//, `${what}: no finance file is named`);
  assert.match(result.leftOut ?? "", /left out because the owner's rules/, `${what}: the answer says something was left out`);
  assert.match(result.leftOut, /the folder finance/, `${what}: the refused folder is named`);
}

// ------------------------------------------------------------------ the walkers, one by one

test("files.grep of the whole workspace leaves finance out and says so; the rest is still searched", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-" , path: "." });
  assertLeftOut(result, "files.grep");
  assert.match(text(result), new RegExp(openText), "allowed files are still searched");
});

test("files.list of the top folder does not list finance; listing notes still works", async (t) => {
  const { result } = await runTool(t, "files.list", { path: "." });
  assertLeftOut(result, "files.list");
  assert.deepEqual(result.entries.map((entry) => entry.name).sort(), ["notes", "readme.md"]);
});

test("files.search leaves finance's files unread", async (t) => {
  const { result } = await runTool(t, "files.search", { query: "-" });
  assertLeftOut(result, "files.search");
  assert.match(text(result), new RegExp(openText));
});

test("files.glob does not name finance's files", async (t) => {
  const { result } = await runTool(t, "files.glob", { patterns: ["**/*"] });
  assertLeftOut(result, "files.glob");
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["notes/open.txt", "readme.md"]);
});

test("files.find does not offer finance's files", async (t) => {
  const { result } = await runTool(t, "files.find", { query: "q" });
  assertLeftOut(result, "files.find");
});

test("workspace.map and code.map leave finance out", async (t) => {
  const map = await runTool(t, "workspace.map", { path: "." });
  assertLeftOut(map.result, "workspace.map");
  const code = await runTool(t, "code.map", { path: "." });
  assertLeftOut(code.result, "code.map");
  assert.ok(code.result.files.some((file) => file.path === "readme.md"));
});

test("a walk that starts inside the refused folder is refused outright", async (t) => {
  for (const [name, args] of [["files.grep", { query: "-", path: "finance" }], ["files.list", { path: "finance/2026" }],
    ["files.glob", { patterns: ["*"], path: "finance" }], ["files.search", { query: "-", path: "finance" }]]) {
    const { result, denied } = await runTool(t, name, args);
    assert.equal(result, undefined, `${name}: nothing was answered`);
    assert.ok(denied, `${name}: refused`);
  }
});

test("a rule that only asks before reading finance keeps a walk out of it too (a walk cannot stop to ask)", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, (app) => financeRule(app, "ask"));
  assertLeftOut(result, "files.grep under an ask rule");
});

test("a read-only folder (changes refused) is still searched: reading it is allowed", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, (app) => financeRule(app, "deny", { applies: "changes" }));
  assert.match(text(result), new RegExp(secretText));
  assert.equal(result.leftOut, undefined);
});

test("with no rules at all nothing is left out and there is no note", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, async () => {});
  assert.match(text(result), new RegExp(secretText));
  assert.equal(result.leftOut, undefined);
});

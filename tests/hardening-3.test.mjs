import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/hardening-3: reliability and safety fixes found in reviews (docs/agents/STATUS-hardening-3.md).
 * Nothing here opens a window or starts a real model: every model is a scripted fake.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening-3-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { app, root, workspace };
}
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const eventsOf = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind);
/** "Never allow anything under finance": the owner's folder rule, the one a renamed key must not walk past. */
async function financeRule(app, decision = "deny") {
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision, remember: "always", resource: { kind: "path", pattern: "finance" } });
}

// ------------------------------------------------------------------ 1. rules see what the tool uses

test("1 runArgs: the arguments as the tool will run with them — mapped names, trimmed text, filled defaults", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(app.registry.runArgs("files.edit", { file_path: "finance/a.txt", old_string: "x", new_string: "y" }),
    { path: "finance/a.txt", find: "x", replace: "y", expectedOccurrences: 1, replaceAll: false });
  const bad = { path: 5 };
  assert.equal(app.registry.runArgs("files.read", bad), bad, "a call that does not parse is judged as it was sent");
  assert.equal(app.registry.runArgs("no.such.tool", bad), bad);
  assert.equal(app.registry.targetOf("files.edit", { file_path: "finance/a.txt", old_string: "x", new_string: "y" }, {}), "finance/a.txt");
});

test("1 a folder rule cannot be walked past by a name the tool maps (file_path for path)", async (t) => {
  const provider = scripted([call("files.edit", { file_path: "finance/q1.txt", old_string: "10", new_string: "99" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(await readFile(join(workspace, "finance", "q1.txt"), "utf8"), "10\n", "the file was not changed");
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.equal(denied?.data.target, "finance/q1.txt");
});

test("1 a folder rule covers a tool whose file is called `file` (documents.analyse)", async (t) => {
  const provider = scripted([call("documents.analyse", { file: "finance/report.md", question: "what is the total?" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "report.md"), "# Report\n\nThe total is 12.\n");
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "read it" });
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.equal(denied?.data.target, "finance/report.md");
  assert.equal(eventsOf(app, run, "tool.completed").length, 0, "nothing was read");
  // The same for a folder added to a knowledge base, whose path sits inside `source`.
  assert.equal(app.registry.targetOf("knowledge.add", { collection: "notes", source: { kind: "folder", path: " finance " } }, {}), "finance");
});

test("1 the question shows the call as it will run: the mapped name, not the one sent; the yes stays bound to what was sent", async (t) => {
  const sent = { file_path: "finance/q1.txt", old_string: "10", new_string: "99" };
  const provider = scripted([call("files.edit", sent), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), "10\n");
  await financeRule(app, "ask");
  const { argumentFingerprint } = await import("../dist/runtime.js");
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(run.status, "needs_input");
  const [question] = eventsOf(app, run, "policy.ask");
  assert.equal(question.data.target, "finance/q1.txt");
  assert.equal(JSON.parse(question.data.bytes).path, "finance/q1.txt");
  assert.equal(question.data.fingerprint, argumentFingerprint(JSON.stringify(sent)));
});

test("1 trying a tool by hand and another AI tool's dry run judge the call as the tool will run it", async (t) => {
  const { app, workspace } = await fixture(t);
  await financeRule(app);
  const { dryRunPlan } = await import("../dist/mcp-policy.js");
  const plan = dryRunPlan(app.registry, app.store, "local", workspace, { name: "files.edit",
    arguments: { file_path: "finance/q1.txt", old_string: "10", new_string: "99" } });
  assert.equal(plan.target, "finance/q1.txt");
  assert.equal(plan.decision, "deny");
});

// ------------------------------------------------------------------ 2. the loop guard compares cleaned calls

test("2 the loop guard sees a call that only changes a junk key each round as the same call", async (t) => {
  const steps = [];
  for (let round = 0; round < 8; round++) steps.push(call("files.read", { path: "a.txt", [`junk${round}`]: round }));
  steps.push(say("done"));
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  await writeFile(join(workspace, "a.txt"), "hello\n");
  const { saveLoopGuardSettings } = await import("../dist/loop-guard.js");
  saveLoopGuardSettings(app.store, "local", { mode: "on" });
  const run = await app.runtime.run({ prompt: "read it" });
  assert.ok(eventsOf(app, run, "loop.warned").length + eventsOf(app, run, "loop.blocked").length > 0,
    "the repeats were noticed although the junk key changed every time");
  assert.ok(eventsOf(app, run, "loop.blocked").length > 0, "and the repeated call was refused");
});

// ------------------------------------------------------------------ 3. a hung model on this computer

/** An OpenAI-shaped server on this computer that never says anything; counts the requests it gets. */
async function silentLocalServer(t) {
  const { createServer } = await import("node:http");
  const seen = { requests: 0 };
  const server = createServer((request, response) => { seen.requests++; request.resume(); response.on("close", () => undefined); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, seen };
}

test("3 a model on this computer that never starts answering is tried again once, briefly, then the task says what to try", async (t) => {
  const { app } = await fixture(t);
  const { OpenAIProvider } = await import("../dist/providers.js");
  const { endpoint, seen } = await silentLocalServer(t);
  app.runtime.models.register({ id: "on-this-computer", name: "Local", model: "m",
    provider: new OpenAIProvider({ endpoint, model: "m", apiKey: "local" }) });
  // Shortened for the test (shipped: 60 s and 300 s, grace 30 s): a 1 s first-reply wait, grace 100 ms.
  app.runtime.reliability.modelStallMs = 300;
  app.runtime.reliability.localFirstReplyMs = 1000;
  const started = Date.now();
  const run = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  const took = Date.now() - started;
  assert.equal(run.status, "failed");
  assert.match(run.output ?? "", /model on this computer didn't start answering/);
  assert.match(run.output ?? "", /smaller model/);
  assert.equal(seen.requests, 2, "asked once, and tried again once");
  const recoveries = app.store.events(run.id).filter((event) => event.kind === "model.stall_recovery").map((event) => event.data);
  assert.deepEqual(recoveries.map((one) => one.action), ["retry", "fail"]);
  assert.ok(recoveries[0].waitMs <= 100, `the retry waits only the grace (${recoveries[0].waitMs} ms)`);
  assert.ok(took < 2000, `the whole wait stays near the first-reply wait plus the grace, not three full waits (${took} ms)`);
});

test("3 the grace is a tenth of the first-reply wait, at most 30 seconds", async () => {
  const { localFirstReplyGraceMs } = await import("../dist/reliability.js");
  assert.equal(localFirstReplyGraceMs(300_000), 30_000);
  assert.equal(localFirstReplyGraceMs(1_800_000), 30_000);
  assert.equal(localFirstReplyGraceMs(60_000), 6_000);
});

// ------------------------------------------------------------------ 4. code.rename reads first

/** A scripted model, the fake language server switched on, and read-before-edit set to `mode`. */
async function renameFixture(t, steps, mode) {
  const { fileURLToPath } = await import("node:url");
  const { saveLanguageServerSettings } = await import("../dist/index.js");
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const made = await fixture(t, { provider: scripted(steps) });
  const fake = join(fileURLToPath(import.meta.url), "..", "fixtures", "fake-language-server.mjs");
  await saveLanguageServerSettings(made.app.store, "local", {
    enabled: true, servers: { fake: { path: process.execPath, args: [fake], languages: ["TypeScript"] } }, timeoutMs: 10000 });
  t.after(() => made.app.languageServers.stopAll());
  saveCodingMode(made.app.store, "local", "read-first", mode);
  await mkdir(join(made.workspace, "src"), { recursive: true });
  await writeFile(join(made.workspace, "src", "sums.ts"), "export const total = 1;\nconsole.log(total);\n");
  return made;
}
const rename = call("code.rename", { path: "src/sums.ts", line: 1, character: 14, newName: "grandTotal" });
const toolAnswers = (app, run) => app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

test("4 read-first on: code.rename of a file the task has not read is refused, and nothing is written", async (t) => {
  const { app, workspace } = await renameFixture(t, [rename, say("done")], "on");
  const run = await app.runtime.run({ prompt: "rename it" });
  const [answer] = toolAnswers(app, run);
  assert.equal(answer.ok, false);
  assert.match(answer.error, /read/i);
  assert.equal(await readFile(join(workspace, "src", "sums.ts"), "utf8"), "export const total = 1;\nconsole.log(total);\n");
});

test("4 read-first on: after the file is read, code.rename goes through; with the switch off it goes through as before", async (t) => {
  const read = call("files.read", { path: "src/sums.ts" });
  const on = await renameFixture(t, [read, rename, say("done")], "on");
  const run = await on.app.runtime.run({ prompt: "rename it" });
  assert.equal(toolAnswers(on.app, run)[1].ok, true, JSON.stringify(toolAnswers(on.app, run)[1]));
  assert.match(await readFile(join(on.workspace, "src", "sums.ts"), "utf8"), /grandTotal/);
  const off = await renameFixture(t, [rename, say("done")], "off");
  const plain = await off.app.runtime.run({ prompt: "rename it" });
  assert.equal(toolAnswers(off.app, plain)[0].ok, true);
});

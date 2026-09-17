/**
 * w911 (A0374): the execution and debugging loop, proved through a real app with a scripted model
 * and the real shell tool running this computer's own node with a harmless script. The command
 * fails until a file called ready.txt exists; the fix the model suggests is writing that file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, savePolicy, saveTroubleshootSettings, troubleshootRecords, troubleshootOff, readDiagnosis, commandFailed,
} from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { startServer } from "../dist/server.js";

const probe = { executable: "node", args: ["-e", "process.exit(require('fs').existsSync('ready.txt') ? 0 : 1)"] };
const shellCall = { id: "c1", name: "shell.execute", arguments: JSON.stringify(probe) };
const diagnosis = (fix) => JSON.stringify({ diagnosis: "The script needs ready.txt, which is missing.", fix });
const writeFix = (path = "ready.txt") => ({ tool: "files.write", arguments: { path, content: "yes" } });

/**
 * The model: a troubleshooting question is answered from `fixes` in order; the task itself asks
 * for `firstCall` once and then says it is done.
 */
function scripted(fixes, firstCall = shellCall) {
  const provider = { name: "scripted", requests: [], diagnoses: 0, tools: [], async complete(request) {
    provider.requests.push(request);
    const text = request.messages.map((m) => m.content).join("\n");
    if (text.includes("You are helping fix a command that failed")) {
      const reply = fixes[Math.min(provider.diagnoses, fixes.length - 1)];
      provider.diagnoses++;
      return { content: reply, toolCalls: [] };
    }
    provider.tools.push(request.tools.map((tool) => tool.name));
    if (request.messages.some((m) => m.role === "tool")) return { content: "Done.", toolCalls: [] };
    return { content: "", toolCalls: [firstCall] };
  } };
  return provider;
}

async function fixture(t, fixes, { mode = "on", maxTries = 2, rules = [], firstCall } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-w911-ts-"));
  const provider = scripted(fixes, firstCall);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const config = join(root, "integrations.json");
  await writeFile(config, JSON.stringify({ shell: { executables: { node: { path: process.execPath, args: [] } }, timeoutMs: 20000 } }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  savePolicy(app.store, app.runtime.owner, { rules, unmatchedCommands: "allow" });
  saveTroubleshootSettings(app.store, app.runtime.owner, { mode, maxTries });
  return { app, provider, root, workspace: join(root, "workspace") };
}
const exists = (path) => access(path).then(() => true, () => false);
const eventsOf = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);
const lastToolMessage = (provider) => JSON.parse(provider.requests.filter((r) => r.messages.some((m) => m.role === "tool")).at(-1)
  .messages.filter((m) => m.role === "tool").at(-1).content);

test("A0374: a diagnosis is read only in the declared shape, and a failed command is recognised", () => {
  assert.deepEqual(readDiagnosis("```json\n" + diagnosis(writeFix()) + "\n```").fix, writeFix());
  assert.equal(readDiagnosis(JSON.stringify({ diagnosis: "x", fix: { tool: "files.delete", arguments: {} } })), null, "only the listed tools");
  assert.equal(readDiagnosis("no json here"), null);
  assert.equal(commandFailed({ exitCode: 1 }), true);
  assert.equal(commandFailed({ exitCode: 0 }), false);
  assert.equal(commandFailed({ exitCode: null, status: "timeout" }), true);
});

test("A0374: on — a failing command gets a diagnosis, a fix that writes the file, a re-run and a success record", async (t) => {
  const { app, provider, workspace } = await fixture(t, [diagnosis(writeFix())]);
  const run = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(await exists(join(workspace, "ready.txt")), true, "the fix wrote the file");
  assert.ok(provider.tools[0].includes("troubleshoot.run"), "on loads the tool from the first round");
  const [attempt] = eventsOf(app, run.id, "troubleshoot.attempt");
  assert.equal(attempt.fixOutcome, "applied");
  assert.equal(attempt.rerunExit, 0);
  assert.match(attempt.diagnosis, /ready\.txt/);
  assert.equal(eventsOf(app, run.id, "troubleshoot.finished")[0].status, "fixed");
  // The fix and the retry went through the task's own tool path: each is a recorded call of its own.
  const started = eventsOf(app, run.id, "tool.started").map((e) => e.name);
  assert.deepEqual(started, ["shell.execute", "files.write", "shell.execute"]);
  // What the model was handed is the working retry, with the story beside it.
  const seen = lastToolMessage(provider);
  assert.equal(seen.result.exitCode, 0);
  assert.equal(seen.troubleshooting.status, "fixed");
  const [record] = troubleshootRecords(app.store, app.runtime.owner);
  assert.equal(record.status, "fixed");
  assert.equal(record.runId, run.id);
  assert.equal(record.attempts.length, 1);
});

test("A0374: the limit on tries is honoured", async (t) => {
  const { app, provider, workspace } = await fixture(t,
    [diagnosis(writeFix("a.txt")), diagnosis(writeFix("b.txt")), diagnosis(writeFix("c.txt"))], { maxTries: 2 });
  const run = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(run.status, "completed");
  assert.equal(provider.diagnoses, 2, "asked twice, never a third time");
  const attempts = eventsOf(app, run.id, "troubleshoot.attempt");
  assert.deepEqual(attempts.map((a) => [a.fixOutcome, a.rerunExit]), [["applied", 1], ["applied", 1]]);
  assert.equal(eventsOf(app, run.id, "troubleshoot.finished")[0].status, "still-failing");
  assert.equal(await exists(join(workspace, "c.txt")), false);
  assert.equal(lastToolMessage(provider).result.exitCode, 1, "the model is told it still fails");
});

test("A0374: the same fix suggested twice stops the loop early", async (t) => {
  const { app, provider } = await fixture(t, [diagnosis(writeFix("a.txt")), diagnosis(writeFix("a.txt"))], { maxTries: 5 });
  const run = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(provider.diagnoses, 2);
  const attempts = eventsOf(app, run.id, "troubleshoot.attempt");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].fixOutcome, null, "the repeat was not applied");
  assert.equal(eventsOf(app, run.id, "troubleshoot.finished")[0].status, "repeated-fix");
  assert.equal(eventsOf(app, run.id, "tool.started").filter((e) => e.name === "files.write").length, 1);
});

test("A0374: an \"ask\" rule on files.write stops the fix, nothing is written, and the task is not left waiting", async (t) => {
  const { app, provider, workspace } = await fixture(t, [diagnosis(writeFix())],
    { rules: [{ tool: "files.write", decision: "ask" }], maxTries: 3 });
  const run = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(await exists(join(workspace, "ready.txt")), false, "nothing was written");
  const [attempt] = eventsOf(app, run.id, "troubleshoot.attempt");
  assert.equal(attempt.fixOutcome, "refused");
  assert.match(attempt.note, /ask first/);
  assert.equal(eventsOf(app, run.id, "troubleshoot.finished")[0].status, "refused");
  assert.equal(provider.diagnoses, 1);
  assert.deepEqual(eventsOf(app, run.id, "tool.started").map((e) => e.name), ["shell.execute"], "the fix never reached the tool");
  assert.equal(app.runtime.approvals.waiting(run.sessionId).length, 0, "no question was left behind");
});

test("A0374: off does nothing and hides the tool; the tool refuses if called anyway", async (t) => {
  const { app, provider } = await fixture(t, [diagnosis(writeFix())], { mode: "off" });
  const run = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(run.status, "completed");
  assert.equal(provider.diagnoses, 0);
  assert.equal(eventsOf(app, run.id, "troubleshoot.started").length, 0);
  assert.equal(lastToolMessage(provider).troubleshooting, undefined);
  assert.ok(switchedToolTiers(app.store, app.runtime.owner, app.registry.names()).hidden.includes("troubleshoot.run"));
  assert.ok(!provider.tools[0].includes("troubleshoot.run"), "not offered in the first round");
  await assert.rejects(app.runtime.executeTool("troubleshoot.run", { tool: "shell.execute", arguments: probe }, { mode: "owner" }),
    (error) => error.message === troubleshootOff);
});

test("A0374: when needed — nothing runs by itself, and the assistant's own troubleshoot.run call does the loop", async (t) => {
  const troubleCall = { id: "t1", name: "troubleshoot.run", arguments: JSON.stringify({ tool: "shell.execute", arguments: probe }) };
  const { app, provider, workspace } = await fixture(t, [diagnosis(writeFix())], { mode: "when-needed" });
  const tiers = switchedToolTiers(app.store, app.runtime.owner, app.registry.names());
  assert.ok(!tiers.hidden.includes("troubleshoot.run") && !tiers.preload.some((p) => p.name === "troubleshoot.run"));
  const plain = await app.runtime.run({ prompt: "check the project is ready" });
  assert.equal(provider.diagnoses, 0, "a failed command is not looked at by itself");
  assert.equal(eventsOf(app, plain.id, "troubleshoot.started").length, 0);
  // Now the assistant asks for it.
  const { app: app2, provider: provider2, workspace: workspace2 } = await fixture(t, [diagnosis(writeFix())], { mode: "when-needed", firstCall: troubleCall });
  const run = await app2.runtime.run({ prompt: "find out why the check fails and fix it" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(await exists(join(workspace2, "ready.txt")), true);
  assert.equal(provider2.diagnoses, 1);
  const seen = lastToolMessage(provider2);
  assert.equal(seen.result.status, "fixed");
  assert.equal(eventsOf(app2, run.id, "troubleshoot.finished")[0].status, "fixed");
  assert.equal(await exists(join(workspace, "ready.txt")), false);
});

test("A0374: when needed — the tool's fix goes through the approval gate too", async (t) => {
  const troubleCall = { id: "t1", name: "troubleshoot.run", arguments: JSON.stringify({ tool: "shell.execute", arguments: probe }) };
  const { app, provider, workspace } = await fixture(t, [diagnosis(writeFix())],
    { mode: "when-needed", firstCall: troubleCall, rules: [{ tool: "files.write", decision: "ask" }] });
  const run = await app.runtime.run({ prompt: "find out why the check fails and fix it" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(await exists(join(workspace, "ready.txt")), false);
  assert.equal(lastToolMessage(provider).result.status, "refused");
});

test("A0374: GET and POST /api/troubleshoot read and change the switch and the limit", async (t) => {
  const { app, root } = await fixture(t, [diagnosis(null)], { mode: "off" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = (method, body) => fetch(server.url + "/api/troubleshoot", { method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.deepEqual((await call("GET")).body.settings, { mode: "off", maxTries: 2 });
  assert.deepEqual((await call("POST", { mode: "on", maxTries: 4 })).body.settings, { mode: "on", maxTries: 4 });
  assert.equal((await call("POST", { maxTries: 9 })).status, 400, "the limit is 1 to 5");
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const refused = await fetch(server.url + "/api/troubleshoot", { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(refused.status, 401, "a short-lived key cannot change it");
});

/**
 * mac7/r17-g integration review: the adversarial pass over the safety extras. Each test here was
 * written to fail against the branch as the builder left it, and passes with the fix beside it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { totp } from "../dist/safety-extras/totp.js";
import { takeCode } from "../dist/safety-extras/code-approvals.js";
import { scriptWall, ToolScripts } from "../dist/safety-extras/tool-scripts.js";
import { spawn } from "node:child_process";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";

const say = (content) => () => ({ content, toolCalls: [] });

async function served(t, steps = [say("Done.")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-attack-"));
  let turn = 0;
  const provider = { name: "scripted", async complete(request) { return steps[Math.min(turn++, steps.length - 1)](request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const ran = [];
  if (!app.registry.names().includes("shell.execute"))
    app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "run",
      parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(),
      execute: async (args) => { ran.push(args.executable); return { ok: true, exitCode: 0 }; } });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  await api("POST", "/api/policy", { preset: "off", unmatchedCommands: "allow" });
  return { app, api, ran, root };
}

/** Switches codes on and sets up an app; the next usable code is one step ahead. */
async function enrol(api) {
  assert.equal((await api("POST", "/api/safety-extras/switch", { part: "code-approvals", mode: "on" })).status, 200);
  const { key } = (await api("POST", "/api/safety-extras/codes/begin", {})).body;
  assert.equal((await api("POST", "/api/safety-extras/codes/finish", { code: totp(key) })).status, 200);
  return { key, next: () => totp(key, Date.now() / 1000 + 30) };
}

test("codes: wrong codes are limited, so a code cannot be guessed, and even the right one waits", async (t) => {
  const { api } = await served(t);
  const { next } = await enrol(api);
  await api("POST", "/api/safety-extras/stop", { tools: ["shell.*"] });
  const right = next();
  const wrong = right === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await api("POST", "/api/safety-extras/stop/release", { code: wrong })).status, 401);
  const locked = await api("POST", "/api/safety-extras/stop/release", { code: right });
  assert.equal(locked.status, 401, "the right code is refused while wrong ones are being tried");
  assert.match(locked.body.error, /wrong codes/);
  assert.equal((await api("GET", "/api/safety-extras")).body.stop.engaged, true);
});

test("codes: one code is taken once, even when two answers arrive together", async (t) => {
  const { app, api } = await served(t);
  const { next } = await enrol(api);
  const code = next();
  const taken = await Promise.all([takeCode(app.store, app.runtime.owner, code), takeCode(app.store, app.runtime.owner, code)]);
  assert.deepEqual(taken.filter(Boolean).length, 1, JSON.stringify(taken));
});

test("codes: switching them off, removing or replacing the app, or changing the list needs a code", async (t) => {
  const { app, api } = await served(t);
  const { next } = await enrol(api);
  for (const [path, body] of [["/api/safety-extras/switch", { part: "code-approvals", mode: "off" }],
    ["/api/safety-extras/switch", { part: "code-approvals", mode: "when-needed" }],
    ["/api/safety-extras/codes/remove", {}], ["/api/safety-extras/codes/begin", {}],
    ["/api/safety-extras/codes", { tools: [], releaseNeedsCode: false }]]) {
    const refused = await api("POST", path, body);
    assert.equal(refused.status, 401, `${path} ${JSON.stringify(body)}: ${JSON.stringify(refused.body)}`);
  }
  const view = (await api("GET", "/api/safety-extras")).body;
  assert.equal(view.modes["code-approvals"], "on");
  assert.equal(view.codes.enrolled, true);
  assert.equal(view.codes.releaseNeedsCode, true);
  // Tightening never needs one, and a good code lets the owner loosen.
  assert.equal((await api("POST", "/api/safety-extras/switch", { part: "command-scan", mode: "on" })).status, 200);
  const removed = await api("POST", "/api/safety-extras/codes/remove", { code: next() });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.codes.enrolled, false);
  assert.equal(app.store.locker.exists(app.runtime.owner, "branch-safety", "APPROVAL_CODE_KEY"), false);
});

test("codes: a code typed without the fingerprint still counts for the question that is waiting", async (t) => {
  const shell = () => ({ content: "", toolCalls: [{ id: "c1", name: "shell.execute", arguments: JSON.stringify({ executable: "git", args: ["status"] }) }] });
  const { api, ran } = await served(t, [shell, shell, say("done")]);
  const { next } = await enrol(api);
  const paused = (await api("POST", "/api/run", { prompt: "check" })).body;
  assert.equal(paused.status, "needs_input", paused.output);
  const confirmed = await api("POST", "/api/safety-extras/codes/confirm", { sessionId: paused.sessionId, code: next() });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const answered = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", remember: "session" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal((await api("POST", "/api/run", { prompt: "go on", sessionId: paused.sessionId })).body.status, "completed");
  assert.deepEqual(ran, ["git"]);
});

test("codes: a tool on the list pressed by hand is refused rather than run without a code", async (t) => {
  const { app, api, ran } = await served(t);
  await enrol(api);
  await assert.rejects(app.runtime.executeTool("shell.execute", { executable: "git", args: [] }, { mode: "owner" }), /authenticator app/);
  assert.deepEqual(ran, []);
  assert.equal(await app.runtime.executeTool("files.list", { path: "." }, { mode: "owner" }).then(() => "ran", (error) => error.message), "ran",
    "a tool that is not on the list still runs by hand");
});

test("codes: the key's locker project cannot be made a project, so no tool or route can read or replace it", async (t) => {
  const { app, api } = await served(t);
  await enrol(api);
  const made = await api("POST", "/api/projects", { id: "branch-safety", name: "Safety" });
  assert.ok(made.status >= 400, JSON.stringify(made.body));
  assert.throws(() => app.store.projects.save(app.runtime.owner, { id: "model-connections", name: "x" }), /kept for Branch/);
  const removed = await api("POST", "/api/secrets/branch-safety/APPROVAL_CODE_KEY/remove", {});
  assert.ok(removed.status >= 400, JSON.stringify(removed.body));
  assert.equal(app.store.locker.exists(app.runtime.owner, "branch-safety", "APPROVAL_CODE_KEY"), true);
});

/* ---------- tool scripts ---------- */

/** The real script host, started without the system's wall so these run on every platform (the wall has its own macOS test). */
function unwalled(app) {
  return new ToolScripts({ host: app.runtime, registry: app.registry, unreadable: () => [],
    wallDeps: { platform: "darwin", exists: async () => true, realpath: async (path) => path },
    start: (start) => spawn(process.execPath, start.args.slice(start.args.indexOf("--no-warnings")),
      { cwd: start.cwd, env: start.env, stdio: ["pipe", "pipe", "pipe", "pipe"] }) });
}
async function scripted(t) {
  const served_ = await served(t);
  const { app, api } = served_;
  await api("POST", "/api/safety-extras/switch", { part: "tool-scripts", mode: "on" });
  const looked = [];
  app.registry.register({ name: "notes.lookup", permission: "memory.read", description: "look a note up",
    parameters: z.object({ q: z.string() }).strict(), execute: async ({ q }) => { looked.push(q); return { note: `about ${q}`, key: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }; } });
  const run = app.store.createRun(app.runtime.owner, "script");
  return { ...served_, looked, run, context: app.runtime.context({ runId: run.id }) };
}
const repeat = (times) => `export default async (branch) => {
  const out = [];
  for (let i = 0; i < ${times}; i++) out.push(await branch.call("notes.lookup", { q: "same" }).then((r) => r.note ?? "warned", (e) => "refused: " + e.message));
  return out;
};`;

test("scripts: the loop guard sees a script's calls, so one script cannot repeat a step without end", async (t) => {
  const { app, looked, context } = await scripted(t);
  app.store.save("settings", app.runtime.owner, "loop_guard", { mode: "on" });
  const answer = await unwalled(app).run({ source: repeat(12), tools: ["notes.lookup"], timeoutMs: 30_000 }, context);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(looked.length < 12, `the repeated call ran ${looked.length} times`);
  assert.ok(answer.result.some((entry) => entry.startsWith("refused")), JSON.stringify(answer.result));
});

test("scripts: every call a script makes is written to the task journal first, under an id no model call can have", async (t) => {
  const { app, context, run } = await scripted(t);
  const answer = await unwalled(app).run({ source: repeat(2), tools: ["notes.lookup"], timeoutMs: 30_000 }, context);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const steps = app.neverBreak.journal.steps(run.id).filter((step) => step.tool === "notes.lookup");
  assert.equal(steps.length, 2, JSON.stringify(app.neverBreak.journal.steps(run.id)));
  for (const step of steps) {
    assert.match(step.callId, /^branch-script:/);
    assert.equal(step.state, "finished");
  }
});

test("scripts: what a tool hands a script has keys hidden before the script can reshape it", async (t) => {
  const { app, context } = await scripted(t);
  const source = `export default async (branch) => {
    const found = await branch.call("notes.lookup", { q: "k" });
    return Buffer.from(found.key).toString("base64");
  };`;
  const answer = await unwalled(app).run({ source, tools: ["notes.lookup"], timeoutMs: 30_000 }, context);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.notEqual(Buffer.from(answer.result, "base64").toString(), "ghp_abcdefghijklmnopqrstuvwxyz0123456789");
});

test("scripts: a task's own wall never widens a script's: no network, no key sites, Branch's data stays unreadable", () => {
  const outer = { network: "open", keySites: { API_KEY: "api.example.com" }, unreadable: ["/home/me/.ssh"], readOnly: ["/app"],
    answer: () => "allow", granted: () => ["/tmp/x"], spend: () => undefined };
  const wall = scriptWall(outer, ["/branch-data"]);
  assert.equal(wall.network, "none");
  assert.deepEqual(wall.keySites, {});
  assert.deepEqual([...wall.unreadable].sort(), ["/branch-data", "/home/me/.ssh"]);
  assert.deepEqual(wall.readOnly, ["/app"]);
  assert.equal(wall.answer("network.site", "api.example.com"), "deny");
  assert.equal(wall.answer("sandbox.write", "/tmp/x"), "allow", "a write the owner allowed stays allowed");
  const plain = scriptWall(undefined, ["/branch-data"]);
  assert.equal(plain.network, "none");
  assert.deepEqual(plain.unreadable, ["/branch-data"]);
});

test("scripts: a restart in the middle of a script puts it to the owner, and nothing it sent is sent again", async (t) => {
  const { app, root, run } = await scripted(t);
  await saveGatewayConfig(join(root, "data"), GatewayConfigSchema.parse({ mode: "on" }));
  const sent = [];
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  app.registry.register({ name: "notes.send", permission: "channels.send", description: "send a note",
    parameters: z.object({ to: z.string() }).strict(), execute: async ({ to }) => { sent.push(to); await hang; return { sent: true }; } });
  const controller = new AbortController();
  const context = app.runtime.context({ runId: run.id, signal: controller.signal });
  const args = { source: `export default async (branch) => branch.call("notes.send", { to: "sam" })`, tools: ["notes.send"], timeoutMs: 30_000 };
  const outer = { id: "s1", name: "tools.script", arguments: JSON.stringify(args) };
  app.runtime.journal.intend({ runId: run.id, sessionId: run.sessionId, calls: [{ call: outer, permission: "code.execute" }] });
  const running = app.runtime.journal.around({ runId: run.id, sessionId: run.sessionId, call: outer, permission: "code.execute",
    workspace: context.workspace, signal: context.signal }, () => unwalled(app).run(args, context));
  for (let i = 0; i < 200 && !sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sent, ["sam"]);
  // Branch "restarts": the task is found interrupted with both steps open.
  app.store.finish(run.id, "interrupted", "cut off");
  const reports = await app.neverBreak.recoverOnStart(join(root, "data"));
  const report = reports.find((entry) => entry.runId === run.id);
  assert.equal(report.outcome, "asked", JSON.stringify(report));
  assert.deepEqual(report.steps.map((step) => [step.tool, step.decision]), [["tools.script", "ask"], ["notes.send", "ask"]]);
  assert.match(app.store.run(run.id).output, /may already have happened/);
  assert.deepEqual(sent, ["sam"], "nothing was sent a second time");
  controller.abort();
  release();
  await running.catch(() => undefined);
});

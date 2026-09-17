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

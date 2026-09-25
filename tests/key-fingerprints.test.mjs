/**
 * A short-lived key may answer only the questions of tasks it started (or of their specialists), so the waiting list
 * it reads from GET /api/policy shows every other task's question without its fingerprint. The key's own questions
 * keep theirs, so it can still answer them; this computer's key and the app window see every question as it is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { underShortLivedKey } from "../dist/key-context.js";

/** A model that writes the file its message names, so the write stops on a question with a fingerprint. */
function writer() {
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(request.messages.findLast((m) => m.role === "user")?.content ?? ""));
    if (named && last?.role === "user")
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-key-fingerprints-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, key, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const key = (scope) => app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token;
  /** The one question a task left waiting, as the app holds it. */
  const held = (run) => app.runtime.approvals.waiting(run.sessionId).find((question) => question.runId === run.id);
  /** The waiting list as `bearer` reads it. */
  const waiting = async (bearer) => {
    const seen = await call("GET", "/api/policy", bearer);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    return seen.body.waiting;
  };
  return { app, server, call, key, held, waiting };
}

/** The owner's own task, stopped on its question. */
async function ownersQuestion(f) {
  const run = await f.app.runtime.run({ prompt: "write a.txt" });
  assert.equal(run.status, "needs_input", "control: the owner's write stopped on a question");
  assert.match(f.held(run)?.fingerprint ?? "", /^[a-f0-9]{32}$/, "control: that question has a fingerprint");
  return run;
}
/** A task a run key started, stopped on its question. */
async function keysQuestion(f, script) {
  const started = await f.call("POST", "/api/run", script, { prompt: "write b.txt" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "needs_input", "control: the key's write stopped on a question");
  assert.match(f.held(started.body)?.fingerprint ?? "", /^[a-f0-9]{32}$/, "control: that question has a fingerprint");
  return started.body;
}

test("a read key sees the owner's waiting question without its fingerprint, and the owner still sees it", async (t) => {
  const f = await served(t);
  const owners = await ownersQuestion(f);
  const kept = f.held(owners).fingerprint;
  const entry = (await f.waiting(f.key("read"))).find((question) => question.runId === owners.id);
  assert.ok(entry, "the key still sees that the owner's task is waiting");
  assert.equal(entry.sessionId, owners.sessionId);
  assert.equal(entry.tool, "files.write");
  assert.equal(entry.label, f.held(owners).label);
  assert.equal("fingerprint" in entry, false, "another task's question comes without its fingerprint");
  // Read after the key: what the key was shown did not change the question itself.
  assert.equal(f.held(owners).fingerprint, kept, "the question still has its fingerprint");
  const owner = (await f.waiting(f.server.token)).find((question) => question.runId === owners.id);
  assert.equal(owner?.fingerprint, kept, "this computer's key sees it");
});

test("a run key keeps its own question's fingerprint and answers with it; other tasks' questions come without", async (t) => {
  const f = await served(t);
  const owners = await ownersQuestion(f);
  const script = f.key("run");
  const mine = await keysQuestion(f, script);
  const view = await f.waiting(script);
  const own = view.find((question) => question.runId === mine.id);
  const other = view.find((question) => question.runId === owners.id);
  assert.equal(own?.fingerprint, f.held(mine).fingerprint, "its own question keeps its fingerprint");
  assert.ok(other, "the owner's question is still listed");
  assert.equal("fingerprint" in other, false, "the owner's question comes without its fingerprint");
  // A second key did not start that task either, so it is shown the key's question without the fingerprint too.
  const another = (await f.waiting(f.key("run"))).find((question) => question.runId === mine.id);
  assert.ok(another, "a second key still sees the question is waiting");
  assert.equal("fingerprint" in another, false, "another key's question comes without its fingerprint");
  const answered = await f.call("POST", "/api/policy/approve", script,
    { sessionId: mine.sessionId, decision: "allow", remember: "session", fingerprint: own.fingerprint });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(f.held(mine), undefined, "the key answered its own question");
  assert.ok(f.held(owners), "the owner's question still waits");
});

test("this computer's key sees every waiting question with its fingerprint", async (t) => {
  const f = await served(t);
  const owners = await ownersQuestion(f);
  const mine = await keysQuestion(f, f.key("run"));
  const view = await f.waiting(f.server.token);
  for (const run of [owners, mine])
    assert.equal(view.find((question) => question.runId === run.id)?.fingerprint, f.held(run).fingerprint, run.prompt);
});

test("the key's view follows the answering rule: its own task and that task's specialist keep the fingerprint", async () => {
  const { keyViewOfQuestion } = await import("../dist/key-context.js");
  assert.equal(typeof keyViewOfQuestion, "function", "one helper beside the answering rule decides what a key sees");
  const events = {
    ownerTask: [{ kind: "run.started", data: { source: "owner" } }],
    keyTask: [{ kind: "run.started", data: { source: "owner", shortLivedKey: true, shortLivedKeyId: "key-a" } }],
    child: [{ kind: "run.started", data: { source: "owner", parentRunId: "keyTask" } }],
  };
  const store = { events: (id) => events[id] ?? [] };
  const question = (runId) => ({ runId, sessionId: "s", tool: "files.write", target: "a.txt", label: "Write a.txt", fingerprint: "f".repeat(32) });
  const asKey = (runId, keyId = "key-a") => underShortLivedKey(() => keyViewOfQuestion(store, question(runId)), { keyId });
  assert.equal(asKey("keyTask").fingerprint, "f".repeat(32), "the key's own task");
  assert.equal(asKey("child").fingerprint, "f".repeat(32), "its specialist's question too");
  assert.equal("fingerprint" in asKey("ownerTask"), false, "the owner's task");
  assert.equal("fingerprint" in asKey("keyTask", "key-b"), false, "another key's task");
  assert.equal(keyViewOfQuestion(store, question("ownerTask")).fingerprint, "f".repeat(32), "not asked with a key: unchanged");
  const shown = question("ownerTask");
  const seen = underShortLivedKey(() => keyViewOfQuestion(store, shown), { keyId: "key-a" });
  assert.notEqual(seen, shown, "a copy, not the question itself");
  assert.equal(shown.fingerprint, "f".repeat(32), "the question itself keeps its fingerprint");
  assert.deepEqual({ ...seen, fingerprint: shown.fingerprint }, shown, "nothing else is taken away");
});

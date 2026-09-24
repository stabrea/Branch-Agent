/**
 * Dogfood A6 and B6: a task stops on its question, so a yes alone carried nothing on ("a yes given in the Inbox after
 * the task had ended is silently lost"), and the task went on waiting in "Your assistant needs you" for ever. Now a
 * yes to the owner's own task carries it on in its conversation; any other answer ends the wait;. Node only, through the window's own routes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, carryOnWords } from "../dist/server.js";
import { underShortLivedKey } from "../dist/key-context.js";

/** A model that writes the file its first message names, again when told to go ahead, then says it is done. */
function writer() {
  let file = "";
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(last?.content ?? ""));
    if (last?.role === "user" && named) file = named[1];
    if (last?.role === "user" && (named || last.content === carryOnWords))
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t, root) {
  root ??= await mkdtemp(join(tmpdir(), "branch-answered-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const waitingIn = async (sessionId) => (await call("state")).body.attention.filter((one) => one.sessionId === sessionId);
  const runsIn = (sessionId) => app.store.runs(app.runtime.owner).filter((run) => run.sessionId === sessionId);
  return { app, root, call, waitingIn, runsIn, server };
}
const settled = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("a yes in the window to the owner's own task carries it on, and the banner clears", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write a.txt" });
  assert.equal(first.status, "needs_input", "control: it stopped to ask");
  assert.equal((await f.waitingIn(first.sessionId)).length, 1, "control: the banner shows it");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  assert.ok(await settled(() => f.runsIn(first.sessionId).some((run) => run.id !== first.id && run.status === "completed")), "the task carried on");
  assert.ok(existsSync(join(f.root, "workspace", "a.txt")), "and did what the yes was for");
  assert.equal(f.runsIn(first.sessionId).find((run) => run.id !== first.id).prompt, carryOnWords);
  assert.deepEqual(await f.waitingIn(first.sessionId), [], "nothing waits any more");
});

test("a no ends the wait: the banner clears and nothing carries on", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write b.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "deny", remember: "session", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  assert.deepEqual(await f.waitingIn(first.sessionId), []);
  assert.equal(f.app.store.run(first.id).status, "cancelled");
  assert.equal(f.runsIn(first.sessionId).length, 1, "nothing carried on");
  assert.equal(existsSync(join(f.root, "workspace", "b.txt")), false);
});

test("a yes to a task that came from elsewhere ends its wait but never carries it on as the owner's", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write c.txt", source: "trigger" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.runsIn(first.sessionId).length, 1, "the owner's window starts nothing for it");
  assert.deepEqual(await f.waitingIn(first.sessionId), []);
});

test("\"Yes, just now\" is one pass for those exact bytes: used once, and never for another request", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write e.txt" });
  f.app.runtime.approve(first.sessionId, "allow", "never");
  const used = await f.app.runtime.run({ prompt: "write e.txt", sessionId: first.sessionId });
  assert.equal(used.status, "completed", "the next identical attempt uses the pass");
  const again = await f.app.runtime.run({ prompt: "write e.txt", sessionId: first.sessionId });
  assert.equal(again.status, "needs_input", "and it is gone after one use");
  f.app.runtime.approve(first.sessionId, "allow", "never");
  const other = await f.app.runtime.run({ prompt: "write f.txt", sessionId: first.sessionId });
  assert.equal(other.status, "needs_input", "a different request is asked about");
});

test("a script's answer, without the window's carryOn, settles nothing: the script sends its own next message, as before", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write g.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.runsIn(first.sessionId).length, 1, "nothing was started for it");
  assert.equal(f.app.store.run(first.id).status, "needs_input");
});

test("an unused \"Yes, just now\" lapses after an hour, as a yes for the conversation does (NAS 618407c)", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write h.txt" });
  f.app.runtime.approve(first.sessionId, "allow", "never");
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60 * 1000;
  try {
    const later = await f.app.runtime.run({ prompt: "write h.txt", sessionId: first.sessionId });
    assert.equal(later.status, "needs_input", "an hour on, it asks again");
  } finally { Date.now = realNow; }
});

test("a short-lived key's task is never carried on as the owner's own (NAS 618407c)", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await underShortLivedKey(() => f.app.runtime.run({ prompt: "write k.txt" }), { keyId: "probe-key" });
  assert.equal(first.status, "needs_input", "control: the key's task asks");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.runsIn(first.sessionId).length, 1, "nothing ran as the owner");
  assert.deepEqual(await f.waitingIn(first.sessionId), [], "and it no longer waits");
});

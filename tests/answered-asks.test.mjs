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
import { randomUUID } from "node:crypto";

/** Lets a task hold the conversation busy until the test releases it. */
const hold = { release: null };
/** A model that writes the file its first message names, again when told to go ahead, then says it is done. */
function writer() {
  let file = "";
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "hold") { await new Promise((resolve) => { hold.release = resolve; }); return { content: "Held.", toolCalls: [] }; }
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

test("with a plan waiting for the owner in that conversation, a yes carries nothing on, so it never agrees to the plan (NAS 06a9508)", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write p.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  f.app.runtime.orchestration.savePlan({ runId: first.id, sessionId: first.sessionId, prompt: "a plan", steps: [{ title: "Step one" }],
    current: 0, approved: false, createdAt: new Date().toISOString() });
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.runsIn(first.sessionId).length, 1, "nothing carried on");
  assert.equal(f.app.runtime.orchestration.plan(first.sessionId).approved, false, "the plan still waits for the owner's own answer");
  assert.equal(f.app.store.run(first.id).status, "needs_input", "and the task still waits");
});

// NAS dead082 (the check-back half of 06a9508): an agreed plan stopped at a check-back is still approved, so an older
// card's yes, carried on as "Yes, go ahead.", cleared the next step with no go-ahead, and the call it answered never ran.
test("with an agreed plan stopped at a check-back, an older card's yes carries nothing on; the plan's own task still does", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write k.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  const paused = (runId) => f.app.runtime.orchestration.savePlan({ runId, sessionId: first.sessionId, prompt: "a plan",
    steps: [{ title: "Step one" }, { title: "Step two" }], current: 1, approved: true, clearedThrough: 0, waitingOnOwner: true,
    createdAt: new Date().toISOString() });
  paused(randomUUID());
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.runsIn(first.sessionId).length, 1, "nothing carried on");
  const plan = f.app.runtime.orchestration.plan(first.sessionId);
  assert.deepEqual([plan.clearedThrough, plan.waitingOnOwner], [0, true], "step two is not cleared: the check-back still waits for the owner");
  assert.equal(f.app.store.run(first.id).status, "needs_input", "and the task still waits");

  // Control: when the task that asked is the plan's own, the yes carries it on, as before.
  const own = await f.app.runtime.run({ prompt: "write k2.txt" });
  const ownAsk = f.app.runtime.approvals.questionFor(own.sessionId);
  f.app.runtime.orchestration.savePlan({ ...f.app.runtime.orchestration.plan(first.sessionId), sessionId: own.sessionId, runId: own.id });
  assert.equal((await f.call("policy/approve", { sessionId: own.sessionId, decision: "allow", remember: "never", fingerprint: ownAsk.fingerprint, carryOn: true })).status, 200);
  assert.ok(await settled(() => f.runsIn(own.sessionId).length > 1), "the plan's own question carries on");
});

test("with the conversation busy, a yes leaves the task waiting rather than marking it done (NAS 06a9508)", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const first = await f.app.runtime.run({ prompt: "write q.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  hold.release = null;
  t.after(() => hold.release?.());
  const busy = f.app.runtime.run({ prompt: "hold", sessionId: first.sessionId });
  for (let i = 0; i < 100 && !hold.release; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(hold.release, "control: the conversation is busy");
  assert.equal((await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(f.app.store.run(first.id).status, "needs_input", "not marked done with its work undone");
  hold.release();
  await busy;
  const later = await f.app.runtime.run({ prompt: "write q.txt", sessionId: first.sessionId });
  assert.equal(later.status, "completed", "the owner's next message uses the yes");
  assert.ok(existsSync(join(f.root, "workspace", "q.txt")));
});

test("a \"Yes, just now\" is used only by a task for whoever asked: not the owner's turn after a key's or a person's yes (NAS 4a4d7b1)", async (t) => {
  const f = await fixture(t);
  t.after(() => discardTemp(f.root));
  const keyed = await underShortLivedKey(() => f.app.runtime.run({ prompt: "write r.txt" }), { keyId: "room-key" });
  assert.equal(keyed.status, "needs_input", "control: the key's turn asks");
  f.app.runtime.approve(keyed.sessionId, "allow", "never");
  const owners = await f.app.runtime.run({ prompt: "write r.txt", sessionId: keyed.sessionId });
  assert.equal(owners.status, "needs_input", "the owner's turn in the same conversation is asked for itself");
  assert.equal(existsSync(join(f.root, "workspace", "r.txt")), false);
  f.app.runtime.approve(owners.sessionId, "deny", "session");
  const again = await underShortLivedKey(() => f.app.runtime.run({ prompt: "write r.txt", sessionId: keyed.sessionId }), { keyId: "room-key" });
  assert.equal(again.status, "completed", "the key's own next turn still uses the yes it was given");
});

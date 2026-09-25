/**
 * Dogfood F8: an approval question lives in memory, so a task left waiting on one when Branch stopped was a zombie after
 * the restart: approving said "Nothing … is waiting", stopping it answered `cancelled:false`, and it held every
 * automatic update (Legion had six). On a real start such a task is marked as cut off, with a note: the owner carries
 * it on, and it asks again, or stops it. A question that outlives a restart is left alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, lostQuestionNote } from "../dist/server.js";
import { busyTaskCount } from "../dist/comfort/auto-update.js";

/**
 * A model that writes the file its message names, so the write stops on the owner's question; carried on after a
 * restart, it sees that call cut off and asks for it again, as a real model does.
 */
function writer() {
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(request.messages.findLast((m) => m.role === "user")?.content ?? ""));
    const cutOff = last?.role === "tool" && /"status":"interrupted"/.test(String(last.content));
    if (named && ((last?.role === "user") || cutOff))
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}
async function open(root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  return app;
}
/** A task stopped on an approval question, and one stopped on a question the owner's next message answers. */
async function before(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-lost-questions-"));
  t.after(() => discardTemp(root));
  const first = await open(root);
  const gated = await first.runtime.run({ prompt: "write a.txt" });
  assert.equal(gated.status, "needs_input", "control: the write stopped on the owner's question");
  const asked = first.store.createRun(first.runtime.owner, "plan my week");
  first.store.event(asked.id, "user.ask", { question: "Which week?" });
  first.store.finish(asked.id, "needs_input", "Which week?");
  await first.close();
  return { root, gated, asked };
}

test("F8 after a real restart, a task whose approval question was lost is cut off with a note, and holds no update", async (t) => {
  const { root, gated, asked } = await before(t);
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); });
  const run = app.store.run(gated.id);
  assert.equal(run.status, "interrupted", "no longer a question nobody can answer");
  assert.equal(app.store.events(gated.id).filter((event) => event.kind === "run.can_continue").at(-1)?.data.note, lostQuestionNote);
  assert.equal(app.store.run(asked.id).status, "needs_input", "a question the owner's next message answers still waits");
  assert.equal(busyTaskCount(app.store), 1, "only the question that can still be answered counts");
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response.json();
  };
  const waiting = (await call("state")).attention.find((item) => item.runId === gated.id);
  assert.equal(waiting?.canContinue, true, "the window offers to carry it on");
  assert.equal(waiting?.question, lostQuestionNote, "and says why");
  // Carried on, it asks again, so the owner can answer this time.
  const again = await app.runtime.resume(gated.id);
  assert.equal(again.status, "needs_input", "carried on, it stops on the question again");
  assert.equal(app.runtime.approvals.waiting(gated.sessionId).length, 1, "the question is asked again");
});

test("F8 a waiting task can be stopped, and its question goes with it; a start that is not the app changes nothing", async (t) => {
  const { root, gated } = await before(t);
  // A terminal command opens the same data (no presence): nothing it does may close anything.
  const terminal = await open(root);
  const quiet = await startServer(terminal, { dataDir: join(root, "data"), port: 0 });
  assert.equal(terminal.store.run(gated.id).status, "needs_input", "control: only a real start settles lost questions");
  await quiet.close();
  await terminal.close();
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); });
  const stop = (id) => fetch(`${server.url}/api/runs/${id}/cancel`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
  assert.deepEqual(await stop(gated.id), { cancelled: true }, "a task a restart cut off is stopped");
  assert.equal(app.store.run(gated.id).status, "cancelled");
  // One waiting on a live question in this process: stopped, and the question is dropped.
  const live = await app.runtime.run({ prompt: "write b.txt" });
  assert.equal(app.runtime.approvals.waiting(live.sessionId).length, 1, "control: its question is live");
  assert.deepEqual(await stop(live.id), { cancelled: true });
  assert.equal(app.store.run(live.id).status, "cancelled");
  assert.equal(app.runtime.approvals.waiting(live.sessionId).length, 0, "its question is gone too");
  const done = await app.runtime.run({ prompt: "say hi" });
  assert.deepEqual(await stop(done.id), { cancelled: false }, "a finished task is not stopped");
});

test("F8 in the window, the row of a task a restart cut off offers Continue and Stop, and Stop stops it", async (t) => {
  const { chromium } = await import("playwright");
  const { root, gated } = await before(t);
  const app = await open(root);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const row = page.locator("#attention .attention-row").filter({ hasText: "Branch restarted before you answered" });
  await row.waitFor({ timeout: 30000 });
  await row.getByRole("button", { name: "Continue where it stopped" }).waitFor();
  await row.getByRole("button", { name: "Stop it" }).click();
  await page.waitForFunction(() => !document.querySelector("#attention")?.textContent.includes("Branch restarted before you answered"), null, { timeout: 20000 });
  assert.equal(app.store.run(gated.id).status, "cancelled");
  assert.deepEqual(errors, []);
});

/**
 * The meter under the message box shows how full the NEXT request is, the same measure as /tokens:
 * not the sum of everything spent (which re-counts the history on every task and every round), and
 * it drops once the conversation has been folded. Read through GET /api/sessions/<id>/context.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { tokenReport } from "../dist/commands/tokens.js";
import { profileScope } from "../dist/profiles.js";

const reply = (text) => ({ name: "scripted", async complete() { return { content: text, toolCalls: [] }; } });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-meter-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: reply("A fairly ordinary answer. ".repeat(40)) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const get = async (path) => {
    const response = await fetch(server.url + path, { headers: { authorization: `Bearer ${server.token}` } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, get };
}
const next = (report) => report.instructions + report.tools + report.conversation;

test("the meter reads how full the next request is, not everything spent so far", async (t) => {
  const { app, get } = await fixture(t);
  const first = await app.runtime.run({ prompt: "Plan the garden beds. ".repeat(30), permissions: [] });
  for (let turn = 0; turn < 3; turn++)
    await app.runtime.run({ prompt: `And turn ${turn}? `.repeat(20), permissions: [], sessionId: first.sessionId });
  const spent = app.store.runs(app.runtime.owner).filter((run) => run.sessionId === first.sessionId)
    .reduce((sum, run) => { const u = app.store.usage(run.id); return sum + (u.reportedInput || u.estimatedInput) + (u.reportedOutput || u.estimatedOutput); }, 0);
  const { status, body } = await get(`/api/sessions/${first.sessionId}/context`);
  assert.equal(status, 200);
  assert.deepEqual(body, tokenReport(app.runtime, first.sessionId), "the same measure as /tokens");
  assert.ok(next(body) > 0);
  assert.ok(next(body) < spent, `the next request (${next(body)}) is smaller than the total spent (${spent}), which re-counted the history`);
});

test("a fold since the last measure is honoured: the meter drops to what is stored now", async (t) => {
  const { app } = await fixture(t);
  const run = await app.runtime.run({ prompt: "Short question.", permissions: [] });
  // A large measure, then a fold after it: the measure predates the fold and no longer holds.
  app.store.event(run.id, "context.budget", { limit: 100000, system: 100, catalog: 50, messages: 90000, reserve: 1000 });
  assert.ok(tokenReport(app.runtime, run.sessionId).conversation >= 89900, "before the fold, the larger measure stands");
  app.store.event(run.id, "context.compacted", { estimatedBefore: 90000, estimatedAfter: 800 });
  assert.ok(tokenReport(app.runtime, run.sessionId).conversation < 5000, "after it, the stored conversation is what counts");
});

test("a household person's conversation is measured under their own tasks, and nobody else can read it", async (t) => {
  const { app, get } = await fixture(t);
  const run = await app.runtime.run({ prompt: "Sam's homework question.", permissions: [] });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.reassignSession(run.sessionId, profileScope(person.id));
  assert.equal((await get(`/api/sessions/${run.sessionId}/context`)).status, 404, "the owner's window does not read Sam's");
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const { status, body } = await get(`/api/sessions/${run.sessionId}/context`);
  assert.equal(status, 200);
  assert.equal(body.measured, "last task", "Sam's own task was found under Sam's scope");
});

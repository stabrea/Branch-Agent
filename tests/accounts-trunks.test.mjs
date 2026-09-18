/**
 * mac7/lockdown-fix (R17-005): a sign-in account never answers for a Trunk — in its own conversation,
 * in a room or in a routine — and a key is chosen by the Trunk's own pick, never by the owner's
 * default. Every service is a stand-in: keys are answered by a fake fetch, programs by a fake runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode } from "../dist/accounts/manage.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-accounts-trunks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy; // the stand-in fetch below is the whole network
  for (const part of ["trunks", "rooms", "routines"]) app.trunks.setMode(part, { mode: "on" });
  return { app, service, owner: app.runtime.owner };
}
/** A saved key connection: its first key is a stand-in provider, the second answers through a fake fetch. */
function apiConnection(fx, { active = true } = {}) {
  const { app, owner, service } = fx;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const calls = { first: 0, second: 0 };
  const provider = { name: "openai-chat", complete: async () => { calls.first++; return { content: "from the first key", toolCalls: [] }; } };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider });
  if (active) app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (_url, init) => {
    calls.second++;
    if (JSON.parse(String(init.body)).stream) {
      const chunk = JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "from the second key" }, finish_reason: "stop" }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}
/** An installed program signed in to the owner's own account. */
function program(fx) {
  const seen = [];
  const spawn = async (_row, _prompt, _signal, _limits, home) => {
    seen.push(home?.path ?? "primary");
    return { code: 0, stdout: JSON.stringify({ result: "from the sign-in" }), stderr: "" };
  };
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" }, {}, spawn);
  fx.service.deps.spawnAgent = spawn;
  return seen;
}
const accountOf = (app, runId) => app.store.events(runId).filter((e) => e.kind === "model.account").map((e) => e.data.account);

test("a Trunk's pick answers in its conversation, its routine and its room seat, not the owner's default", async (t) => {
  const fx = await fixture(t);
  const { app, service, owner } = fx;
  apiConnection(fx);
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  const ed = app.trunks.create({ name: "Ed" });
  const flo = app.trunks.create({ name: "Flo" });
  app.trunks.edit(ed.id, { permissions: ["files.read"], keys: { copyFromOwner: true, accounts: { [POOL]: second } } });
  await app.trunks.introduced();

  const own = await app.runtime.run({ prompt: "hello" });
  assert.equal(own.output, "from the first key", "the owner's own task keeps the default key");
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.output, "from the second key");

  const routine = app.trunks.routines.create(ed.id, { name: "Look", prompt: "Look around" });
  const fired = await app.scheduler.trigger(owner, routine.id, null, owner);
  const routineRun = app.store.run(fired.id) ?? fired;
  assert.notEqual(routineRun.sessionId, ed.chatSessionId, "a routine runs in a conversation of its own");
  const settled = await waitFor(() => { const r = app.store.run(fired.id); return r && r.status !== "running" ? r : null; });
  assert.deepEqual(accountOf(app, settled.id), [second], "the routine used the Trunk's pick, with no conversation choice to go on");

  const room = app.trunks.rooms.create({ name: "Pair", members: [ed.id, flo.id] });
  app.trunks.rooms.send(room.id, { text: "@ed say something" });
  await app.trunks.rooms.settled(room.id);
  const seat = app.store.runs(owner).find((run) => run.sessionId === room.memberSessions[ed.id]);
  assert.ok(seat, "Ed spoke in the room");
  assert.deepEqual(accountOf(app, seat.id), [second], "the room seat used the Trunk's pick too");
});

test("with only sign-in connections a Trunk is refused in one sentence and the sign-in is never used", async (t) => {
  for (const accounts of ["off", "on"]) {
    await t.test(`several accounts ${accounts}`, async (t) => {
      const fx = await fixture(t);
      const { app, service, owner } = fx;
      const seen = program(fx);
      app.runtime.models.configure(owner, { activePreset: "cli-claude-code" });
      setMode(service, { mode: accounts });
      const own = await app.runtime.run({ prompt: "hello" });
      assert.equal(own.output, "from the sign-in", "the owner may use their own sign-in");
      const before = seen.length;
      const ed = app.trunks.create({ name: "Ed" });
      await app.trunks.introduced();
      const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
      assert.equal(chat.status, "failed");
      assert.match(chat.output, /A Trunk never answers through a sign-in account/);
      const routine = app.trunks.routines.create(ed.id, { name: "Look", prompt: "Look around" });
      const fired = await app.scheduler.trigger(owner, routine.id, null, owner);
      const done = await waitFor(() => { const r = app.store.run(fired.id); return r && r.status !== "running" ? r : null; });
      assert.match(done.output, /never answers through a sign-in account/);
      assert.equal(seen.length, before, "the program was never started for the Trunk");
    });
  }
});

test("a sign-in first in the list is skipped for a Trunk, and a key connection answers instead", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  const seen = program(fx);
  const calls = apiConnection(fx, { active: false });
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code", fallbackOrder: [POOL] });
  const ed = app.trunks.create({ name: "Ed" });
  await app.trunks.introduced();
  const before = seen.length;
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.output, "from the first key");
  assert.equal(seen.length, before);
  assert.ok(calls.first >= 1);
});

test("a Trunk that does not copy the owner's keys and has no pick is refused rather than using the default", async (t) => {
  const fx = await fixture(t);
  const { app, service } = fx;
  const calls = apiConnection(fx);
  setMode(service, { mode: "on" });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: {} } });
  await app.trunks.introduced();
  const before = calls.first;
  const chat = await app.runtime.run({ prompt: "hello", sessionId: ed.chatSessionId });
  assert.equal(chat.status, "failed");
  assert.match(chat.output, /does not copy your keys and has no key picked for openai-test/);
  assert.equal(calls.first, before, "the owner's default key was not used");
});

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

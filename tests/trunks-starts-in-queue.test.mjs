/* Q44 (DG-107): a message queued for a Trunk that starts on another computer. Every way in (the window's
   queue, busy send, a page note, a handed-over step, a raw follow-up, a Trunk's message and its retry) is
   refused in the start paths' plain words before anything is saved, with a 409 over HTTP, so nothing
   waits here for a start that never comes and nobody is told "This goes next." A refused answer to a
   Trunk that moved is kept as a failed receipt, never thrown into the task that was finishing. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { brain, on } from "./trunks-helpers.mjs";

const tower = "a1b2c3d4e5f60718";
const words = /This Trunk starts on Tower, and Branch cannot start a Trunk on another computer yet/;
const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z",
  lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });

/** A Branch with Scout, Tower paired, and a model that holds "wait here" until the test lets it go. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-starts-in-queue-"));
  const held = [];
  const provider = brain([({ last }) => (/wait here/.test(last?.content ?? "") ? new Promise((resolve) => held.push(() => resolve({ content: "Let go.", toolCalls: [] }))) : null)]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { for (const release of held) release(); await app.close(); await discardTemp(root); });
  on(app, "messages");
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [], devices: [device(tower, "Tower", "linux")] });
  assert.equal(app.devices.book.devices().length, 1);
  const trunk = app.trunks.create({ name: "Scout", title: "", description: "" });
  const ann = app.trunks.create({ name: "Ann", title: "", description: "" });
  await app.trunks.introduced();
  return { app, provider, trunk, ann, held, root };
}
async function serve(t, f) {
  const server = await startServer(f.app, { dataDir: join(f.root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  return (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
}
const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(check()); };
/** Refused over HTTP: a 409, the plain words, nothing queued and no model asked. */
function refused(f, answer, asked) {
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.match(answer.body.error, words);
  assert.deepEqual(f.app.runtime.queued(f.trunk.chatSessionId), [], "nothing waits in its conversation");
  assert.equal(f.provider.requests.length, asked, "no model was asked");
}

test("a raw follow-up and the window's queue are refused before anything is saved", async (t) => {
  const f = await fixture(t);
  const call = await serve(t, f);
  f.app.trunks.edit(f.trunk.id, { startsIn: tower });
  const asked = f.provider.requests.length;
  assert.throws(() => f.app.runtime.followUp(f.trunk.chatSessionId, "from anywhere"), (error) => error.status === 409 && words.test(error.message));
  refused(f, await call(`/api/sessions/${f.trunk.chatSessionId}/followups`, { prompt: "from the window" }), asked);
  assert.equal((await call(`/api/sessions/${f.trunk.chatSessionId}/followups`)).status, 200, "the queue can still be read");
  f.app.trunks.edit(f.trunk.id, { startsIn: null });
  assert.equal(f.app.runtime.followUp(f.trunk.chatSessionId, "now here").queued >= 0, true, "this computer takes it");
});

test("a page note for a Trunk that starts elsewhere is refused and not kept", async (t) => {
  const f = await fixture(t);
  const call = await serve(t, f);
  assert.equal((await call("/api/browser/notes/settings", { mode: "on" })).status, 200);
  f.app.trunks.edit(f.trunk.id, { startsIn: tower });
  const asked = f.provider.requests.length;
  refused(f, await call("/api/browser/notes", { kind: "comment", pageUrl: "https://example.com/", selector: "h1", tag: "h1",
    note: "make it bigger", conversationId: f.trunk.chatSessionId }), asked);
  assert.deepEqual((await call("/api/browser/notes")).body.notes, [], "no note is left behind");
});

test("busy send is refused in every mode, and a task already working is not stopped for it", async (t) => {
  const f = await fixture(t);
  const call = await serve(t, f);
  assert.equal((await call("/api/flows-boards/switch", { part: "waiting-line", mode: "on" })).status, 200);
  const working = f.app.runtime.run({ prompt: "wait here", sessionId: f.trunk.chatSessionId });
  await until(() => f.held.length === 1);
  f.app.trunks.edit(f.trunk.id, { startsIn: tower });
  const asked = f.provider.requests.length;
  for (const mode of ["queue", "interrupt", "steer"]) {
    assert.equal((await call("/api/flows-boards/busy", { mode })).status, 200);
    // Steering passes words to the task already working here; too long to steer, it would be queued.
    const prompt = mode === "steer" ? "x".repeat(2001) : `in ${mode} mode`;
    refused(f, await call("/api/flows-boards/busy/send", { sessionId: f.trunk.chatSessionId, prompt }), asked);
  }
  f.held.shift()();
  assert.equal((await working).status, "completed", "the working task was not stopped for a message that was refused");
});

test("a handed-over step is not marked answered when its answer is refused", async (t) => {
  const f = await fixture(t);
  const run = await f.app.runtime.run({ prompt: "hi", sessionId: f.trunk.chatSessionId });
  f.app.runtime.deferrals.open({ id: "step-1", runId: run.id, sessionId: f.trunk.chatSessionId, tool: "shell.run", description: "" });
  f.app.trunks.edit(f.trunk.id, { startsIn: tower });
  assert.throws(() => f.app.runtime.settleDeferred("step-1", "done"), words);
  assert.equal(f.app.runtime.deferrals.get("step-1").settledAt, null, "still waiting, so it can be answered later");
  assert.deepEqual(f.app.runtime.queued(f.trunk.chatSessionId), []);
});

/** A message from Ann that Scout's task is reading, as the receipts keep it. */
function reading(f, status = "delivered") {
  const { app, trunk, ann } = f, prompt = "Message from Ann (@ann):\nhello";
  const run = app.store.createRun(app.runtime.owner, prompt, trunk.chatSessionId);
  const now = new Date().toISOString();
  app.store.save("settings", app.runtime.owner, "trunk-receipts", { items: [{ id: "r1", kind: "message", from: ann.id, to: trunk.id,
    sessionId: trunk.chatSessionId, prompt, status, depth: 1, attempts: 1, runId: run.id, fromRunId: null, reply: null, error: null, at: now, updatedAt: now }] });
  return run;
}
const receipt = (f, id) => f.app.trunks.messages.receipts().find((r) => r.id === id);

test("a retry refused because the Trunk moved fails the receipt and tells the sender", async (t) => {
  const f = await fixture(t);
  const run = reading(f);
  f.app.trunks.edit(f.trunk.id, { startsIn: tower });
  assert.doesNotThrow(() => f.app.store.event(run.id, "run.finished", { status: "failed", output: "429 rate limit" }));
  assert.equal(receipt(f, "r1").status, "failed");
  assert.match(receipt(f, "r1").error, words);
  assert.deepEqual(f.app.runtime.queued(f.trunk.chatSessionId), [], "the retry was not queued");
  const told = f.app.trunks.messages.receipts().find((r) => r.kind === "failure" && r.to === f.ann.id);
  assert.ok(told, "Ann is told it could not be answered");
  assert.match(told.prompt, /could not be answered: This Trunk starts on Tower/);
});

test("an answer to a Trunk that moved is kept as a failed receipt, never thrown into the finishing task", async (t) => {
  const f = await fixture(t);
  const run = reading(f);
  f.app.trunks.edit(f.ann.id, { startsIn: tower });
  assert.doesNotThrow(() => f.app.store.event(run.id, "run.finished", { status: "completed", output: "Hi Ann." }));
  assert.equal(receipt(f, "r1").status, "answered");
  const reply = f.app.trunks.messages.receipts().find((r) => r.kind === "reply");
  assert.equal(reply.status, "failed");
  assert.match(reply.error, /This Trunk starts on Tower/);
  assert.deepEqual(f.app.runtime.queued(f.ann.chatSessionId), []);
});

test("Not now on a message whose sender moved still declines it, and the refused answer is a failed receipt", async (t) => {
  const f = await fixture(t);
  reading(f, "waiting");
  f.app.trunks.edit(f.ann.id, { startsIn: tower });
  assert.deepEqual(f.app.trunks.messages.decline("r1"), { declined: true }, "the owner's Not now is not refused because Ann moved");
  assert.equal(receipt(f, "r1").status, "failed");
  const told = f.app.trunks.messages.receipts().find((r) => r.kind === "failure");
  assert.equal(told.status, "failed");
  assert.match(told.error, /This Trunk starts on Tower/);
});

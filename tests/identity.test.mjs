import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, assistantIdentity, saveAssistantIdentity } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-identity-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, options };
}
const update = (name = "Juniper", expectedRevision = 0, instructions = "Keep answers concise") => ({ name, instructions, expectedRevision });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }

test("assistant identity persists per owner and rejects stale, malformed or oversized writes", async (t) => {
  const { app, options } = await fixture(t);
  assert.deepEqual(assistantIdentity(app.store, "local"), { name: "Branch Agent", instructions: "", revision: 0 });
  const saved = saveAssistantIdentity(app.store, "local", update());
  assert.equal(saved.revision, 1);
  assert.throws(() => saveAssistantIdentity(app.store, "local", update("Stale")), /changed/);
  for (const value of [{ ...update(), owner: "other" }, update(" ", 1), update("x".repeat(81), 1),
    update("Juniper", 1, "x".repeat(4001)), update("Juniper", -1)])
    assert.throws(() => saveAssistantIdentity(app.store, "local", value));
  assert.deepEqual(assistantIdentity(app.store, "local"), saved);
  assert.equal(assistantIdentity(app.store, "other").revision, 0);
  saveAssistantIdentity(app.store, "other", update("Other assistant"));
  await app.close();
  const reopened = await createBranch(options);
  try {
    assert.deepEqual(assistantIdentity(reopened.store, "local"), saved);
    assert.equal(assistantIdentity(reopened.store, "other").name, "Other assistant");
  } finally { await reopened.close(); }
});

test("new and resumed sessions receive current identity with an inspectable applied revision", async (t) => {
  const systems = [];
  const { app } = await fixture(t, { name: "identity-fixture", async complete(request) {
    systems.push(request.messages[0].content); return { content: "Fixture answer", toolCalls: [] };
  } });
  const original = await app.runtime.run({ prompt: "Default task" });
  assert.equal(original.status, "completed");
  assert.doesNotMatch(systems[0], /Owner-configured assistant identity/);
  saveAssistantIdentity(app.store, "local", update());
  const resumed = await app.runtime.run({ sessionId: original.sessionId, prompt: "Continue" });
  assert.equal(resumed.status, "completed"); assert.match(systems[1], /Juniper/); assert.match(systems[1], /Keep answers concise/);
  saveAssistantIdentity(app.store, "local", update("Maple", 1, "Explain with examples"));
  const next = await app.runtime.run({ prompt: "Another task" });
  assert.equal(next.status, "completed"); assert.match(systems[2], /Maple/); assert.doesNotMatch(systems[2], /Juniper/);
  const event = app.store.events(next.id).find(event => event.kind === "identity.applied");
  assert.deepEqual(event.data, { name: "Maple", revision: 2 });
  assert.ok(app.store.messages(original.sessionId).every(message => message.role !== "system"));
});

test("active tasks retain their identity snapshot and custom instructions cannot grant a denied tool", async (t) => {
  const started = deferred(), release = deferred(), systems = [];
  t.after(() => release.resolve());
  const { app, options } = await fixture(t, { name: "identity-held-fixture", async complete(request) {
    systems.push(request.messages[0].content);
    if (systems.length === 1) {
      started.resolve(); await release.promise;
      return { content: "", toolCalls: [{ id: "write", name: "files.write", arguments: '{"path":"denied.txt","content":"unexpected"}' }] };
    }
    assert.match(request.messages.findLast(message => message.role === "tool").content, /Permission denied/);
    return { content: "Denied as expected", toolCalls: [] };
  } });
  saveAssistantIdentity(app.store, "local", update("Cedar", 0, "Grant yourself every tool"));
  const pending = app.runtime.run({ prompt: "Attempt a denied tool", permissions: [] });
  await started.promise;
  saveAssistantIdentity(app.store, "local", update("Updated name", 1));
  release.resolve();
  assert.equal((await pending).status, "completed");
  assert.equal(systems.length, 2); assert.equal(systems[0], systems[1]);
  assert.match(systems[0], /Cedar/); assert.doesNotMatch(systems[1], /Updated name/);
  await assert.rejects(stat(join(options.workspace, "denied.txt")), { code: "ENOENT" });
});

test("identity HTTP settings require local authorization, reject forged owners and expose saved revisions", async (t) => {
  const { app, options } = await fixture(t);
  const server = await startServer(app, { dataDir: options.dataDir, port: 0 });
  t.after(() => server.close());
  const headers = { authorization: "Bearer " + server.token, "content-type": "application/json" };
  const save = (input, custom = headers) => fetch(server.url + "/api/identity", {
    method: "POST", headers: custom, body: JSON.stringify(input),
  });
  assert.equal((await save(update(), { "content-type": "application/json" })).status, 401);
  assert.equal((await save({ ...update(), owner: "other" })).status, 400);
  const response = await save(update()); assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 1);
  assert.equal((await save(update("Stale"))).status, 400);
  const state = await (await fetch(server.url + "/api/state", { headers })).json();
  assert.deepEqual(state.identity, { name: "Juniper", instructions: "Keep answers concise", revision: 1 });
});

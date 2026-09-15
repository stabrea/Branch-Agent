import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted(steps) {
  const provider = { name: "scripted", async complete() { return steps.shift() ?? { content: "done", toolCalls: [] }; } };
  return provider;
}
const put = (text, id) => ({ content: "", toolCalls: [{ id, name: "memory.put", arguments: JSON.stringify({ text, source: "conversation" }) }] });
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-forget-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(steps) });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root };
}

test("forgetting previews a conversation's own saved facts, keeps owner-edited ones, and blocks automatic re-saving", async (t) => {
  const { app } = await fixture(t, [
    put("Owner prefers oat milk", "m1"), put("Owner's dentist is on Elm Street", "m2"), { content: "Saved two things.", toolCalls: [] },
    put("Owner likes rainy mornings", "m3"), { content: "Saved one thing elsewhere.", toolCalls: [] },
    put("Trying to save again", "m4"), { content: "Tried.", toolCalls: [] },
  ]);
  const chat = await app.runtime.run({ prompt: "remember my preferences" });
  const other = await app.runtime.run({ prompt: "another conversation" });
  assert.equal(app.store.list("memory", "local").length, 3);
  const dentist = app.store.list("memory", "local").find((f) => /dentist/.test(f.data.text));
  app.store.updateMemory("local", { id: dentist.id, text: "Owner's dentist moved to Oak Avenue", source: "owner", expectedRevision: 1 }, "");
  const preview = app.store.forgetMemoryPreview("local", chat.sessionId);
  assert.equal(preview.remove.length, 1);
  assert.match(preview.remove[0].text, /oat milk/);
  assert.equal(preview.excluded.length, 1);
  assert.match(preview.excluded[0].reason, /edited/);
  assert.equal(preview.suppressed, false);
  assert.throws(() => app.store.forgetMemory("local", { sessionId: chat.sessionId, ids: [dentist.id] }), /Only facts listed/);
  const result = app.store.forgetMemory("local", { sessionId: chat.sessionId });
  assert.equal(result.removed, 1);
  assert.equal(result.suppressed, true);
  const remaining = app.store.list("memory", "local").map((f) => f.data.text).sort();
  assert.deepEqual(remaining, ["Owner likes rainy mornings", "Owner's dentist moved to Oak Avenue"]);
  const again = await app.runtime.run({ prompt: "save something again", sessionId: chat.sessionId });
  const toolResult = app.store.messages(chat.sessionId).filter((m) => m.role === "tool").at(-1).content;
  assert.match(toolResult, /forgotten/, "automatic re-saving from the forgotten conversation is refused");
  assert.equal(app.store.list("memory", "local").length, 2, "nothing new was saved");
  assert.equal(app.store.forgetMemoryPreview("local", chat.sessionId).suppressed, true);
  assert.equal(app.store.forgetMemoryPreview("local", other.sessionId).remove.length, 1, "other conversations are untouched");
  const saved = app.store.save("memory", "local", "manual-1", { text: "Saved by hand", source: "Saved by workspace owner", sourceRunId: again.id });
  assert.ok(saved, "the owner can still save from the Memory view");
  void again;
});

test("HTTP API exposes forget preview and forget", async (t) => {
  const { app, root } = await fixture(t, [put("Owner's plant is a fern", "p1"), { content: "Saved.", toolCalls: [] }]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const run = (await post("run", { prompt: "remember my plant" })).data;
  const preview = await post("memory/forget/preview", { sessionId: run.sessionId });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.remove.length, 1);
  assert.equal((await post("memory/forget/preview", { sessionId: "00000000-0000-0000-0000-000000000000" })).status, 400);
  const forgotten = await post("memory/forget", { sessionId: run.sessionId });
  assert.equal(forgotten.data.removed, 1);
  assert.equal((await post("memory/forget", { sessionId: run.sessionId, extra: true })).status, 400);
});

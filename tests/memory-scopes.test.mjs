import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, visibleTo } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => () => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps = [say("ok")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-memscope-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, provider, context: app.runtime.context() };
}

test("facts about an entity change over time and a time-qualified question gets the fact valid then", async (t) => {
  const { app, context } = await fixture(t);
  const put = (args) => app.registry.execute("memory.put", { source: "owner", ...args }, context);
  await put({ text: "Mum's phone number is 111", entity: "Mum", attribute: "phone number", validFrom: "2024-01-01T00:00:00.000Z" });
  await put({ text: "Mum's phone number is 222", entity: "Mum", attribute: "phone number", validFrom: "2025-06-01T00:00:00.000Z" });
  await put({ text: "Mum lives in Leeds", entity: "Mum", attribute: "city", validFrom: "2020-01-01T00:00:00.000Z" });
  const early = await app.registry.execute("memory.at", { entity: "mum", attribute: "phone number", at: "2024-12-31T00:00:00.000Z" }, context);
  assert.deepEqual(early.map((f) => f.text), ["Mum's phone number is 111"]);
  assert.equal(early[0].validTo, "2025-06-01T00:00:00.000Z", "the older fact was ended when the newer one started");
  const now = await app.registry.execute("memory.at", { entity: "Mum", attribute: "phone number" }, context);
  assert.deepEqual(now.map((f) => f.text), ["Mum's phone number is 222"]);
  assert.equal(now[0].validTo, null);
  const before = await app.registry.execute("memory.at", { entity: "Mum", attribute: "phone number", at: "2023-01-01T00:00:00.000Z" }, context);
  assert.deepEqual(before, [], "nothing was known yet");
  const everything = await app.registry.execute("memory.at", { entity: "Mum" }, context);
  assert.deepEqual(everything.map((f) => f.attribute).sort(), ["city", "phone number"]);
  const timeline = await app.registry.execute("memory.timeline", { entity: "Mum" }, context);
  assert.deepEqual(timeline.map((f) => [f.attribute, f.validTo === null]), [["city", true], ["phone number", false], ["phone number", true]]);
  const superseded = app.store.review.versions("local", timeline[1].id);
  assert.equal(superseded[0].reason, "superseded");
  assert.equal(app.store.get("memory", "local", timeline[1].id).revision, 2);
});

test("private, shared and agent scopes decide what a delegated specialist can recall, while the owner sees everything", async (t) => {
  const steps = [
    call("memory.search", { query: "secret" }),
    call("memory.search", { query: "team" }, "c2"),
    call("memory.put", { text: "The specialist's own note", source: "worker" }, "c3"),
    call("memory.put", { text: "A note for everyone", source: "worker", scope: "shared" }, "c4"),
    say("child done"),
  ];
  const { app, context, provider } = await fixture(t, steps);
  await app.registry.execute("memory.put", { text: "Owner secret: the safe code", source: "owner" }, context);
  await app.registry.execute("memory.put", { text: "The team meets on Mondays", source: "owner", scope: "shared" }, context);
  const parent = app.store.createRun("local", "parent");
  const child = await app.runtime.delegate("look things up", app.runtime.context({ runId: parent.id }), ["memory.read", "memory.write"], "You are a worker.", { agent: "worker-1" });
  assert.equal(child.status, "completed");
  const results = app.store.messages(child.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
  assert.deepEqual(results[0].result, [], "the specialist cannot see the owner's private fact");
  assert.deepEqual(results[1].result.map((r) => r.data.text), ["The team meets on Mondays"]);
  assert.equal(results[2].result.data.scope, "agent:worker-1", "a specialist's own note stays its own");
  assert.equal(results[3].result.data.scope, "shared");
  const snapshot = provider.requests[0].messages.find((m) => m.role === "system" && /What you remember/.test(m.content))?.content ?? "";
  assert.doesNotMatch(snapshot, /safe code/, "the conversation snapshot respects the specialist's scope");
  assert.match(snapshot, /Mondays/);
  const ownerSees = await app.registry.execute("memory.search", { query: "note" }, context);
  assert.deepEqual(ownerSees.map((r) => r.data.text).sort(), ["A note for everyone", "The specialist's own note"]);
  const other = await app.registry.execute("memory.search", { query: "note" }, { ...context, agent: "worker-2" });
  assert.deepEqual(other.map((r) => r.data.text), ["A note for everyone"], "another specialist sees only shared facts");
  assert.equal(visibleTo({ data: { scope: "agent:a" } }, "b"), false);
  assert.equal(visibleTo({ data: {} }, undefined), true);
});

test("two conversations recall the same permitted memory while their histories stay separate", async (t) => {
  const steps = [call("memory.search", { query: "tea" }), say("first done"), call("memory.search", { query: "tea" }, "c2"), say("second done")];
  const { app } = await fixture(t, steps);
  app.store.save("memory", "local", "tea", { text: "Prefers green tea", source: "owner" });
  const first = await app.runtime.run({ prompt: "what do I drink" });
  const second = await app.runtime.run({ prompt: "remind me about tea" });
  assert.notEqual(first.sessionId, second.sessionId);
  for (const run of [first, second]) {
    const found = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content))[0];
    assert.deepEqual(found.result.map((r) => r.data.text), ["Prefers green tea"]);
  }
  assert.deepEqual(app.store.messages(first.sessionId).filter((m) => m.role === "user").map((m) => m.content), ["what do I drink"]);
  assert.deepEqual(app.store.messages(second.sessionId).filter((m) => m.role === "user").map((m) => m.content), ["remind me about tea"]);
});

test("a conversation can be told to stop remembering on its own and allowed again, and tidy-up sets old facts aside restorably", async (t) => {
  const { app, root } = await fixture(t, [call("memory.put", { text: "Remember me", source: "chat" }), say("saved"), call("memory.put", { text: "Remember me too", source: "chat" }, "c2"), say("saved again")]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const api = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
  };
  const run = await app.runtime.run({ prompt: "please remember" });
  assert.equal(app.store.list("memory", "local").length, 1);
  assert.deepEqual(await api(`sessions/${run.sessionId}/memory-policy`), { remember: true });
  assert.deepEqual(await api(`sessions/${run.sessionId}/memory-policy`, { remember: false }), { remember: false });
  const denied = await app.runtime.run({ prompt: "remember more", sessionId: run.sessionId });
  assert.equal(denied.status, "completed");
  assert.equal(app.store.list("memory", "local").length, 1, "the denied conversation saved nothing new");
  const refusal = app.store.messages(run.sessionId).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content)).at(-1);
  assert.match(refusal.error, /not saved again automatically/);
  assert.deepEqual(await api(`sessions/${run.sessionId}/memory-policy`, { remember: true }), { remember: true });
  const preview = await api("memory/hygiene", { olderThanDays: 1, action: "preview" });
  assert.deepEqual(preview.stale, [], "a fact saved just now is not stale");
  app.store.save("memory", "local", "old", { text: "Ancient fact", source: "owner" });
  const archived = app.store.memoryHygiene("local", { olderThanDays: 1, action: "archive" }, Date.now() + 3 * 86400000);
  assert.deepEqual(archived.archived.map((s) => s.text).sort(), ["Ancient fact", "Remember me"]);
  const setAside = await api("memory/archive");
  assert.equal(setAside.archived.length, 2);
  await api(`memory/archive/${encodeURIComponent("old")}/restore`, {});
  assert.equal(app.store.get("memory", "local", "old").data.text, "Ancient fact");
});

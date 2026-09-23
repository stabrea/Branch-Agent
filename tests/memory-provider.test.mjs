import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

// FQ-memory.providers: proves an outside memory service can REPLACE the built-in SQLite memory for
// the assistant's remember/recall/forget loop, not only sit beside it — see src/memory-provider.ts.

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}

/** A minimal outside memory service, implementing exactly the contract src/memory-provider.ts expects. */
function memoryDouble() {
  const byOwner = new Map(); // owner -> Map(id -> record)
  const requests = [];
  const factsFor = (owner) => byOwner.get(owner) ?? (byOwner.set(owner, new Map()), byOwner.get(owner));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://x");
    let raw = ""; for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, path: url.pathname, search: url.search, body: raw ? JSON.parse(raw) : undefined });
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    const parts = url.pathname.split("/").filter(Boolean); // ["memory", owner, id?] or ["memory", owner, "search"]
    if (parts[0] !== "memory" || !parts[1]) return send(404, { error: "not found" });
    const owner = decodeURIComponent(parts[1]), facts = factsFor(owner);
    if (parts.length === 2 && request.method === "GET") return send(200, [...facts.values()]);
    if (parts.length === 3 && parts[2] === "search" && request.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return send(200, [...facts.values()].filter((r) => String(r.data.text).toLowerCase().includes(q)));
    }
    const id = decodeURIComponent(parts[2] ?? "");
    if (parts.length === 3 && request.method === "GET") {
      const record = facts.get(id);
      return record ? send(200, record) : send(404, { error: "not found" });
    }
    if (parts.length === 3 && request.method === "PUT") {
      const previous = facts.get(id);
      const now = new Date().toISOString();
      const record = { id, owner, data: JSON.parse(raw), createdAt: previous?.createdAt ?? now, updatedAt: now, revision: (previous?.revision ?? 0) + 1 };
      facts.set(id, record);
      return send(200, record);
    }
    if (parts.length === 3 && request.method === "DELETE") {
      const had = facts.delete(id);
      return send(200, { deleted: had });
    }
    return send(404, { error: "not found" });
  });
  return { server, requests, byOwner,
    async listen() { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; },
    async close() { await new Promise((resolve) => server.close(resolve)); } };
}

async function fixture(t, steps = [say("ok")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-memprovider-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.web.policy.configure({ allowPrivateAddresses: true }); // the double lives on 127.0.0.1
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, context: app.runtime.context() };
}

test("switching on an outside memory service replaces the built-in SQLite memory, not just mirrors it", async (t) => {
  const double = memoryDouble();
  const base = await double.listen();
  t.after(() => double.close());
  const { app, context } = await fixture(t);

  const before = await app.memory.backend.view("local");
  assert.equal(before.settings.mode, "built-in", "starts on the built-in database");

  const configured = await app.memory.backend.configure("local", { mode: "outside", url: base });
  assert.equal(configured.mode, "outside");
  assert.equal((await app.memory.backend.view("local")).active, "an outside memory service");

  // (a) a saved fact goes to the outside service, and SQLite's own memory table stays empty for it.
  const saved = await app.registry.execute("memory.put", { text: "The office wifi password is on the fridge", source: "owner" }, context);
  assert.equal(saved.data.text, "The office wifi password is on the fridge");
  const putRequest = double.requests.find((r) => r.method === "PUT");
  assert.ok(putRequest, "the outside service received the write");
  assert.equal(putRequest.body.text, "The office wifi password is on the fridge");
  assert.deepEqual(app.store.list("memory", "local"), [], "nothing was written to this computer's database");

  // (b) search reads from the outside service too.
  const hits = await app.registry.execute("memory.search", { query: "wifi" }, context);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, saved.id);
  assert.equal(hits[0].data.text, "The office wifi password is on the fridge");

  // (c) delete goes to the outside service, and searching again finds nothing.
  const deleted = await app.registry.execute("memory.delete", { id: saved.id }, context);
  assert.equal(deleted, true);
  assert.deepEqual(await app.registry.execute("memory.search", { query: "wifi" }, context), []);

  // (d) with the outside service unreachable, a save fails outright — it never silently falls back to SQLite.
  await double.close();
  await assert.rejects(
    () => app.registry.execute("memory.put", { text: "Should never land anywhere", source: "owner" }, context),
    /outside memory service/i,
  );
  assert.deepEqual(app.store.list("memory", "local"), [], "the failed save left nothing behind locally either");

  // (e) switching back to built-in routes to SQLite again.
  await app.memory.backend.configure("local", { mode: "built-in" });
  const local = await app.registry.execute("memory.put", { text: "Back on this computer", source: "owner" }, context);
  assert.equal(app.store.get("memory", "local", local.id).data.text, "Back on this computer");
});

test("an outside memory service needs a usable address before it can be switched on", async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(async () => app.memory.backend.configure("local", { mode: "outside" }), /address/i);
  await assert.rejects(async () => app.memory.backend.configure("local", { mode: "outside", url: "not a url" }), /address|web/i);
  await assert.rejects(async () => app.memory.backend.configure("local", { mode: "outside", url: "ftp://example.com" }), /http/i);
});

test("an accepted put/update/delete suggestion goes to the outside service, not this computer's database", async (t) => {
  const double = memoryDouble();
  const base = await double.listen();
  t.after(() => double.close());
  const { app, context } = await fixture(t);
  await app.memory.backend.configure("local", { mode: "outside", url: base });
  app.store.review.configure("local", { requireApproval: true });

  // A put made while approval is required is staged rather than saved anywhere yet.
  const staged = await app.registry.execute("memory.put", { text: "The spare key is under the mat", source: "owner" }, context);
  assert.equal(staged.staged, true, "the write waits for the owner rather than landing anywhere");
  assert.equal(double.requests.some((r) => r.method === "PUT"), false, "not sent to the outside service yet");
  assert.deepEqual(app.store.list("memory", "local"), [], "and not written locally either");

  // Accepting it now sends it to the outside service — the bug this proves: it used to always go to SQLite.
  const pending = app.store.review.proposals("local", "pending");
  assert.equal(pending.length, 1);
  const { applied } = await app.store.review.decide("local", pending[0].id, true);
  assert.equal(applied.data.text, "The spare key is under the mat");
  assert.equal(double.requests.some((r) => r.method === "PUT" && r.body.text === "The spare key is under the mat"), true,
    "the accepted suggestion was written to the outside service");
  assert.deepEqual(app.store.list("memory", "local"), [], "this computer's database stayed empty");
  const savedId = applied.id;

  // An accepted update proposal for that same fact also goes to the outside service.
  const updateProposal = await app.registry.execute("memory.update",
    { id: savedId, text: "The spare key is inside the shed", source: "owner", expectedRevision: applied.revision }, context);
  assert.equal(updateProposal.staged, true);
  const updateDecision = await app.store.review.decide("local", app.store.review.proposals("local", "pending")[0].id, true);
  assert.equal(updateDecision.applied.data.text, "The spare key is inside the shed");
  assert.deepEqual(app.store.list("memory", "local"), [], "the update did not fall back to SQLite");

  // And an accepted delete proposal removes it from the outside service, not from SQLite (there is nothing there to remove).
  const deleteProposal = await app.registry.execute("memory.delete", { id: savedId }, context);
  assert.equal(deleteProposal.staged, true);
  const deleteDecision = await app.store.review.decide("local", app.store.review.proposals("local", "pending")[0].id, true);
  assert.equal(deleteDecision.applied.removed, true);
  assert.deepEqual(await app.registry.execute("memory.search", { query: "spare key" }, context), []);
});

test("memory.update against an outside service rejects a stale revision the same way SQLite does", async (t) => {
  const double = memoryDouble();
  const base = await double.listen();
  t.after(() => double.close());
  const { app, context } = await fixture(t);
  await app.memory.backend.configure("local", { mode: "outside", url: base });
  const saved = await app.registry.execute("memory.put", { text: "First wording", source: "owner" }, context);
  await assert.rejects(
    () => app.registry.execute("memory.update", { id: saved.id, text: "Second wording", source: "owner", expectedRevision: 999 }, context),
    /changed since you opened it/i,
  );
  const updated = await app.registry.execute("memory.update", { id: saved.id, text: "Second wording", source: "owner", expectedRevision: saved.revision }, context);
  assert.equal(updated.data.text, "Second wording");
});

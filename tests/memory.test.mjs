import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { parseMemoryArchive, maximumMemoryArchiveBytes } from "../dist/memory.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-memory-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, options };
}
const sample = (id = "memory-one", text = "Prefers tea") => ({
  id, data: { text, source: "User preference", sourceRunId: "original-source-run" }, revision: 2,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
});
const archive = (records = [sample()]) => ({ format: "branch-agent-memory", version: 1,
  exportedAt: "2026-09-15T00:00:00.000Z", records });
const snapshot = app => app.store.list("memory", "local");

test("corrected profile fact is retrieved by the next eligible session without changing the earlier conversation", async (t) => {
  const provider = { name: "memory-profile-fixture", async complete(input) {
    const result = input.messages.findLast(message => message.role === "tool");
    return result ? { content: result.content, toolCalls: [] } : { content: "", toolCalls: [
      { id: "memory-lookup", name: "memory.search", arguments: '{"query":"drink"}' },
    ] };
  } };
  const { app } = await fixture(t, provider);
  const saved = await app.runtime.executeTool("memory.put", { text: "Preferred drink: tea", source: "Owner" });
  const first = await app.runtime.run({ prompt: "Recall my drink preference", permissions: ["memory.read"] });
  assert.equal(first.status, "completed"); assert.match(first.output, /drink: tea/);
  const before = app.store.messages(first.sessionId);
  const corrected = await app.runtime.executeTool("memory.update", {
    id: saved.id, text: "Preferred drink: coffee", source: "Owner correction", expectedRevision: saved.revision,
  });
  assert.equal(corrected.revision, saved.revision + 1); assert.equal(corrected.createdAt, saved.createdAt);
  const second = await app.runtime.run({ prompt: "Recall my drink preference", permissions: ["memory.read"] });
  assert.equal(second.status, "completed"); assert.notEqual(second.sessionId, first.sessionId);
  assert.match(second.output, /drink: coffee/); assert.doesNotMatch(second.output, /drink: tea/);
  assert.deepEqual(app.store.messages(first.sessionId), before);
  await assert.rejects(app.runtime.executeTool("memory.update", {
    id: saved.id, text: "Stale overwrite", source: "Old editor", expectedRevision: saved.revision,
  }), /changed since/);
  assert.equal(app.store.get("memory", "local", saved.id).data.text, "Preferred drink: coffee");
  await assert.rejects(app.registry.execute("memory.update", {
    id: saved.id, text: "Denied", source: "Other", expectedRevision: corrected.revision,
  }, app.runtime.context({ permissions: ["memory.read"] })), /Permission denied/);
});

test("configured fact capacity rejects excess writes, permits corrections and deletions, and persists per owner", async (t) => {
  const { app, options } = await fixture(t);
  assert.deepEqual(app.store.configureMemory("local", { maxFacts: 2 }), { count: 0, maxFacts: 2 });
  const writes = await Promise.allSettled(["one", "two", "three"].map(text =>
    app.runtime.executeTool("memory.put", { text, source: "capacity fixture" })));
  assert.equal(writes.filter(r => r.status === "fulfilled").length, 2);
  assert.equal(writes.filter(r => r.status === "rejected").length, 1);
  assert.throws(() => app.store.save("memory", "local", "sdk-bypass", { text: "excess" }), /capacity/);
  const first = snapshot(app)[0];
  app.store.updateMemory("local", { id: first.id, text: "corrected", source: "Owner", expectedRevision: first.revision }, "edit-run");
  assert.throws(() => app.store.configureMemory("local", { maxFacts: 1 }), /lowering capacity/);
  app.store.save("memory", "other", "other-id", { text: "Other owner's fact" });
  assert.deepEqual(app.store.memoryCapacity("other"), { count: 1, maxFacts: 500 });
  app.store.delete("memory", "local", first.id);
  app.store.save("memory", "local", "replacement", { text: "New room" });
  await app.close();
  const reopened = await createBranch(options);
  try {
    assert.deepEqual(reopened.store.memoryCapacity("local"), { count: 2, maxFacts: 2 });
    assert.throws(() => reopened.store.save("memory", "local", "extra", { text: "No room" }), /capacity/);
  } finally { await reopened.close(); }
});

test("memory archives restore all fact metadata into a clean owner scope and repeated imports are idempotent", async (t) => {
  const source = await fixture(t), target = await fixture(t);
  source.app.store.importMemory("local", archive([sample(), sample("memory-two", "CAFÉ preference")]));
  const exported = source.app.store.exportMemory("local");
  assert.ok(exported.records.every(record => !Object.hasOwn(record, "owner")));
  assert.deepEqual(target.app.store.importMemory("destination", JSON.parse(JSON.stringify(exported))), { imported: 2, unchanged: 0 });
  assert.deepEqual(target.app.store.exportMemory("destination").records, exported.records);
  assert.deepEqual(target.app.store.importMemory("destination", exported), { imported: 0, unchanged: 2 });
  assert.equal(target.app.store.list("memory", "local").length, 0);
  assert.equal(target.app.store.searchMemory("destination", "cafe\u0301")[0].data.text, "CAFÉ preference");
  assert.throws(() => target.app.store.updateMemory("local", {
    id: "memory-one", text: "Wrong owner", source: "Invalid", expectedRevision: 2,
  }, ""), /not found/);
});

test("archive conflicts, insufficient capacity and write faults leave the complete target state unchanged", async (t) => {
  const { app } = await fixture(t);
  app.store.importMemory("local", archive()); const before = snapshot(app);
  assert.throws(() => app.store.importMemory("local", archive([sample("new"), sample("memory-one", "conflicting")])), /conflicts/);
  assert.deepEqual(snapshot(app), before);
  app.store.configureMemory("local", { maxFacts: 2 });
  assert.throws(() => app.store.importMemory("local", archive([sample("a"), sample("b")])), /capacity/);
  assert.deepEqual(snapshot(app), before);
  app.store.configureMemory("local", { maxFacts: 5 });
  app.store.db.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON memory WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'write fault'); END");
  assert.throws(() => app.store.importMemory("local", archive([sample("a"), sample("b")])), /write fault/);
  assert.deepEqual(snapshot(app), before);
});

test("memory archive schema rejects unsupported, duplicate, forged and oversized content before changes", async (t) => {
  const { app } = await fixture(t);
  const record = sample();
  const invalid = [
    { ...archive(), version: 2 }, { ...archive(), owner: "other" },
    archive([{ ...record, owner: "other" }]), archive([record, record]),
    archive([{ ...record, revision: 0 }]), archive([{ ...record, data: { ...record.data, text: "" } }]),
    archive([{ ...record, updatedAt: "2020-01-01T00:00:00.000Z" }]),
    archive(Array.from({ length: 501 }, (_, i) => sample(String(i)))),
    { ...archive(), unwanted: "x".repeat(maximumMemoryArchiveBytes) },
  ];
  for (const value of invalid) assert.throws(() => app.store.importMemory("local", value));
  assert.deepEqual(snapshot(app), []);
  assert.deepEqual(parseMemoryArchive(archive()).records, [record]);
});

test("legacy facts migrate to edit revisions without losing source metadata or silently deleting overflow", async (t) => {
  const { app, options } = await fixture(t);
  await app.close();
  const db = new DatabaseSync(join(options.dataDir, "branch.sqlite"));
  db.exec("DROP TABLE memory; CREATE TABLE memory(id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(id,owner))");
  const insert = db.prepare("INSERT INTO memory VALUES(?,?,?,?,?)");
  for (let i = 0; i < 502; i++) insert.run(String(i), "local", JSON.stringify({ text: "Legacy fact " + i, source: "Legacy source" }),
    "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  for (const [id, text, source] of [["space-text", "   ", "Owner"], ["space-source", "Old fact", "  "]])
    insert.run(id, "legacy-space", JSON.stringify({ text, source }), "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  db.close();
  const reopened = await createBranch(options);
  try {
    const old = reopened.store.get("memory", "local", "0");
    assert.equal(old.revision, 1); assert.equal(old.data.source, "Legacy source");
    assert.equal(old.createdAt, "2020-01-01T00:00:00.000Z");
    assert.equal(reopened.store.memoryCapacity("local").count, 502);
    assert.throws(() => reopened.store.exportMemory("local"), /500 records/);
    assert.throws(() => reopened.store.save("memory", "local", "new", { text: "Excess" }), /capacity/);
    reopened.store.updateMemory("local", { id: "0", text: "Correct legacy", source: "Owner", expectedRevision: 1 }, "");
    assert.equal(reopened.store.get("memory", "local", "0").revision, 2);
    const legacy = reopened.store.list("memory", "legacy-space");
    assert.equal(legacy.find(record => record.id === "space-text").data.text, "   ");
    assert.equal(legacy.find(record => record.id === "space-source").data.source, "  ");
    assert.equal(reopened.store.searchMemory("legacy-space", " ").length, 2);
    const exported = reopened.store.exportMemory("legacy-space");
    reopened.store.importMemory("restored-legacy", exported);
    assert.deepEqual(reopened.store.exportMemory("restored-legacy").records, exported.records);
    for (const id of ["space-text", "space-source"])
      reopened.store.updateMemory("legacy-space", { id, text: "Corrected", source: "Owner", expectedRevision: 1 }, "");
    assert.ok(reopened.store.list("memory", "legacy-space").every(record => record.revision === 2));
    assert.throws(() => reopened.store.save("memory", "new-owner", "empty", { text: "  " }));
  } finally { await reopened.close(); }
});

test("memory retrieval is bounded in UTF-8 bytes and HTTP transfer restores metadata under the current owner", async (t) => {
  const { app, options } = await fixture(t);
  for (let i = 0; i < 20; i++) app.store.save("memory", "local", "fact-" + i, { text: "🌳".repeat(1999) + "x", source: "Large fact" });
  const matches = app.store.searchMemory("local", "x");
  assert.ok(matches.length > 0 && matches.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(matches)) <= 48000);
  const server = await startServer(app, { dataDir: options.dataDir, port: 0 });
  t.after(() => server.close());
  const headers = { authorization: "Bearer " + server.token, "content-type": "application/json" };
  assert.equal((await fetch(server.url + "/api/memory/export")).status, 401);
  const exported = await (await fetch(server.url + "/api/memory/export", { headers })).json();
  assert.equal(exported.records.length, 20); assert.ok(Buffer.byteLength(JSON.stringify(exported)) > 65536);
  const imported = await fetch(server.url + "/api/memory/import", { method: "POST", headers, body: JSON.stringify(exported) });
  assert.deepEqual(await imported.json(), { imported: 0, unchanged: 20 });
  const capacity = await fetch(server.url + "/api/memory/capacity", { method: "POST", headers, body: '{"maxFacts":21}' });
  assert.deepEqual(await capacity.json(), { count: 20, maxFacts: 21 });
});

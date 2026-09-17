import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-history-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  const app = await createBranch({ dataDir, workspace, provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, dataDir, workspace };
}
function seed(store, owner, content, role = "user") {
  const run = store.createRun(owner, "Historical fixture");
  store.message(run.sessionId, { role, content });
  store.finish(run.id, "completed", "Fixture complete");
  return run;
}

test("history full-text search returns originating sessions and enforces owner/role bounds", async (t) => {
  const { app } = await fixture(t);
  const own = seed(app.store, "local", "Café supplier delivery arrives Thursday.");
  seed(app.store, "other", "Café supplier delivery private other owner.");
  seed(app.store, "local", "Café supplier delivery secret tool output.", "tool");
  seed(app.store, "local", "Café supplier delivery system instruction.", "system");
  const results = app.store.searchHistory("local", { query: "CAFE Thursday" });
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, own.sessionId);
  assert.equal(results[0].sessionCreatedAt, own.createdAt);
  const source = { sessionId: results[0].sessionId, messageId: results[0].messageId };
  const content = app.store.readHistory("local", source);
  assert.match(content.content, /Café supplier/);
  assert.throws(() => app.store.readHistory("other", source), /not found/);
  assert.deepEqual(app.store.searchHistory("local", { query: '" OR * --' }), []);
  assert.deepEqual(app.store.searchHistory("local", { query: "**" }), []);
  assert.equal(app.store.searchHistory("local", { query: "unknown Thursday", match: "any" }).length, 1);
  assert.equal(app.store.searchHistory("local", { query: "unknown Thursday" }).length, 0);
});

test("history read is paged by Unicode characters and permission is explicit", async (t) => {
  const { app } = await fixture(t);
  seed(app.store, "local", "Acorn 🌰 hello world", "assistant");
  const [hit] = app.store.searchHistory("local", { query: "Acorn" });
  const input = { sessionId: hit.sessionId, messageId: hit.messageId, length: 7 };
  const first = app.store.readHistory("local", input);
  assert.equal(first.content, "Acorn 🌰");
  const second = app.store.readHistory("local", { ...input, offset: first.nextOffset, length: 30 });
  assert.equal(first.content + second.content, "Acorn 🌰 hello world");
  assert.equal(second.nextOffset, null);
  await assert.rejects(app.registry.execute("history.search", { query: "Acorn" },
    app.runtime.context({ permissions: ["memory.read"] })), /Permission denied/);
  const result = await app.runtime.executeTool("history.search", { query: "Acorn" });
  assert.equal(result.results[0].sessionId, hit.sessionId);
});

test("assistant retrieves a previous conversation without mistaking its current prompt for evidence", async (t) => {
  let oldSession;
  const provider = { name: "history-fixture", async complete(request) {
    const reply = request.messages.findLast((message) => message.role === "tool");
    if (reply) {
      const found = JSON.parse(reply.content).result.results;
      assert.equal(found.length, 1);
      assert.equal(found[0].sessionId, oldSession);
      return { content: found[0].excerpt, toolCalls: [] };
    }
    return { content: "", toolCalls: [{ id: "history", name: "history.search",
      arguments: JSON.stringify({ query: "blueprint" }) }] };
  } };
  const { app } = await fixture(t, provider);
  oldSession = seed(app.store, "local", "The blueprint milestone is Friday.").sessionId;
  const run = await app.runtime.run({ prompt: "What did I say about blueprint?" });
  assert.equal(run.status, "completed", run.output);
  assert.match(run.output, /milestone is Friday/);
});

test("history tools exclude current-session evidence while manual source reads still work", async (t) => {
  const { app } = await fixture(t);
  const run = seed(app.store, "local", "Current sapphire prompt");
  const [hit] = app.store.searchHistory("local", { query: "sapphire" });
  const context = app.runtime.context({ runId: run.id, permissions: ["history.read"] });
  const input = { sessionId: hit.sessionId, messageId: hit.messageId };
  const search = await app.registry.execute("history.search", { query: "sapphire" }, context);
  assert.deepEqual(search.results, []);
  await assert.rejects(app.registry.execute("history.read", input, context), /not found/);
  const manual = await app.runtime.executeTool("history.read", input);
  assert.equal(manual.content, "Current sapphire prompt");
});

test("history migration indexes pre-existing messages once and follows transcript rewrites", async (t) => {
  const { app, dataDir, workspace } = await fixture(t);
  const old = seed(app.store, "local", "Migration sapphire decision");
  await app.close();
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
  db.exec("DROP TRIGGER message_search_insert; DROP TRIGGER message_search_delete; DROP TRIGGER message_search_update; DROP TABLE message_search;");
  db.exec("DROP TRIGGER message_source_insert; DROP INDEX message_source; ALTER TABLE messages DROP COLUMN source_id;");
  db.close();
  const upgraded = await createBranch({ workspace, dataDir });
  try {
    const [original] = upgraded.store.searchHistory("local", { query: "sapphire" });
    assert.equal(original.sessionId, old.sessionId);
    upgraded.store.message(old.sessionId, { role: "assistant", content: "Sapphire tool request", toolCalls: [
      { id: "interrupted", name: "files.read", arguments: '{"path":"missing"}' },
    ] });
    assert.equal(upgraded.store.reconcileMessages(old.sessionId, "fixture interruption"), 1);
    assert.equal(upgraded.store.readHistory("local", {
      sessionId: original.sessionId, messageId: original.messageId,
    }).content, "Migration sapphire decision");
    assert.equal(upgraded.store.searchHistory("local", { query: "Migration" })[0].messageId, original.messageId);
    assert.equal(upgraded.store.searchHistory("local", { query: "sapphire" }).length, 2);
  } finally { await upgraded.close(); }
  const reopened = await createBranch({ workspace, dataDir });
  try { assert.equal(reopened.store.searchHistory("local", { query: "sapphire" }).length, 2); }
  finally { await reopened.close(); }
});

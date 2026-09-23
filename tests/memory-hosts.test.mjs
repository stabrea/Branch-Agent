/**
 * memory.cross-agent: ingesting a supported host's session log and reading the same memory back
 * through a second, different host adapter — permission respected, not just plumbing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-memhosts-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, context: app.runtime.context() };
}

/** One Claude Code chat file: a user turn and an assistant turn, exactly the shape Claude Code writes. */
function claudeCodeLog(said) {
  const line = (uuid, parent, role, content) => JSON.stringify({ type: role, uuid, parentUuid: parent, message: { role, content } });
  return [line("u1", null, "user", said), line("a1", "u1", "assistant", "Noted.")].join("\n");
}

test("a fact ingested from one host's session log is read back through a different host adapter", async (t) => {
  const { app, context } = await fixture(t);
  const log = claudeCodeLog("Please fix the bug. I always want commit messages to stay under 72 characters.");
  const first = await app.registry.execute("memory.ingest_host_log", { host: "claude-code", sessionId: "s1", text: log }, context);
  assert.equal(first.host, "claude-code");
  assert.equal(first.imported, 1);
  assert.equal(first.duplicates, 0);

  // A second, different host adapter reads it back — this is the round trip the gap asked for.
  const viaCodex = await app.registry.execute("memory.host_search", { host: "codex", query: "commit messages" }, context);
  assert.equal(viaCodex.length, 1);
  assert.match(viaCodex[0].data.text, /commit messages/);
  assert.equal(viaCodex[0].data.scope, "shared");
  assert.match(viaCodex[0].data.source, /Claude Code session log \(session s1\)/);

  // Re-ingesting the same log imports nothing new: the fact is recognised, not duplicated.
  const again = await app.registry.execute("memory.ingest_host_log", { host: "claude-code", sessionId: "s1", text: log }, context);
  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 1);
  const stillOne = await app.registry.execute("memory.host_search", { host: "codex", query: "commit messages" }, context);
  assert.equal(stillOne.length, 1);
});

test("a second host adapter reads only what is permitted: shared facts, never another host's own or the owner's private ones", async (t) => {
  const { app, context } = await fixture(t);
  await app.store.save("memory", context.owner, "shared-1", { text: "Shared: keep pull requests small", source: "test", scope: "shared" });
  await app.store.save("memory", context.owner, "claude-only", { text: "Claude Code only: verbose commit trailers", source: "test", scope: "agent:host:claude-code" });
  await app.registry.execute("memory.put", { text: "Owner private: the safe code", source: "owner" }, context);

  const viaCodex = await app.registry.execute("memory.host_search", { host: "codex", query: "" }, context);
  assert.deepEqual(viaCodex.map((r) => r.data.text).sort(), ["Shared: keep pull requests small"],
    "codex's adapter sees the shared fact, not claude-code's own fact or the owner's private one");

  const viaClaudeCode = await app.registry.execute("memory.host_search", { host: "claude-code", query: "" }, context);
  assert.deepEqual(viaClaudeCode.map((r) => r.data.text).sort(),
    ["Claude Code only: verbose commit trailers", "Shared: keep pull requests small"],
    "claude-code's own adapter sees the shared fact and its own");

  const owner = app.store.searchMemory(context.owner, "");
  assert.deepEqual(owner.map((r) => r.data.text).sort(),
    ["Claude Code only: verbose commit trailers", "Owner private: the safe code", "Shared: keep pull requests small"],
    "the owner's own view is unrestricted, as it already is for every other memory reader");
});

test("only a supported host's session log is accepted", async (t) => {
  const { app, context } = await fixture(t);
  await assert.rejects(app.registry.execute("memory.ingest_host_log",
    { host: "chatgpt", sessionId: "s1", text: claudeCodeLog("I always want tabs.") }, context));
  await assert.rejects(app.registry.execute("memory.host_search", { host: "chatgpt", query: "" }, context));
});

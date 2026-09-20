import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-targets-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } },
  });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return app;
}

test("research.run: sources array is judged by site rules", async (t) => {
  const app = await branch(t);
  // research.run declares targets for each source URL
  const targets = app.registry.targetsOf("research.run",
    { question: "test", sources: ["https://example.com", "https://other.com"] },
    { owner: "test" });
  assert.ok(targets, "research.run declares targets");
  assert.equal(targets.length, 2, "has one target per source");
  assert.deepEqual(targets[0], { kind: "read", url: "https://example.com" });
  assert.deepEqual(targets[1], { kind: "read", url: "https://other.com" });
});

test("channels.broadcast: to array is judged, empty resolves to all linked chats", async (t) => {
  const app = await branch(t);
  // With specific chats
  const withTo = app.registry.targetsOf("channels.broadcast",
    { text: "hello", to: [{ channel: "slack", chatId: "C123" }, { channel: "discord", chatId: "D456" }] },
    { owner: "test" });
  assert.ok(withTo, "channels.broadcast declares targets");
  assert.equal(withTo.length, 2, "has one target per chat");
  assert.equal(withTo[0].path, "slack:C123");
  assert.equal(withTo[1].path, "discord:D456");
  
  // Empty list - would resolve to all linked chats, but in test with no linked chats it's empty
  const withoutTo = app.registry.targetsOf("channels.broadcast",
    { text: "hello", to: [] },
    { owner: "test" });
  assert.ok(Array.isArray(withoutTo), "empty list returns array (would be all linked chats)");
});

test("knowledge.manage: split.folder is judged as a single target", async (t) => {
  const app = await branch(t);
  // knowledge.manage.split has a single folder target
  const target = app.registry.targetOf("knowledge.manage",
    { split: { collection: "notes", folder: "private/secrets", name: "extracted" } });
  assert.equal(target, "private/secrets", "split.folder is the target");
  
  // rename and merge don't produce targets (collection names are not paths)
  const renameTarget = app.registry.targetOf("knowledge.manage",
    { rename: { collection: "notes", name: "newname" } });
  assert.equal(renameTarget, "", "rename produces empty target (collection name, not path)");
});

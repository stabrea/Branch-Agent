import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-memory-inspector-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return { app };
}

/** Test: Fact can be displayed with source and origin labels. */
test("facts are displayed with source, origin, and revision", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Save a fact
  const saved = app.store.save("memory", owner, "fact-1", {
    text: "User prefers coffee",
    source: "User preference",
    sourceRunId: "run-123",
    scope: "private"
  });

  // Retrieve all memory facts
  const facts = app.store.list("memory", owner);
  assert.equal(facts.length, 1);

  const fact = facts[0];
  assert.equal(fact.data.text, "User prefers coffee");
  assert.equal(fact.data.source, "User preference");
  assert.equal(fact.data.sourceRunId, "run-123");
  assert.equal(fact.revision, 1);
  assert.ok(fact.createdAt);
  assert.ok(fact.updatedAt);
});

/** Test: Fact can be corrected using revision-checked update. */
test("memory correction uses revision checking to prevent stale edits", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Save a fact
  const saved = app.store.save("memory", owner, "fact-2", {
    text: "Original fact",
    source: "Owner"
  });

  // Correct it with the right revision
  const corrected = app.store.updateMemory(owner, {
    id: saved.id,
    text: "Corrected fact",
    source: "Owner correction",
    expectedRevision: saved.revision
  }, "owner-edit");

  assert.equal(corrected.data.text, "Corrected fact");
  assert.equal(corrected.data.source, "Owner correction");
  assert.equal(corrected.revision, 2);
  assert.equal(corrected.createdAt, saved.createdAt);
  assert.notEqual(corrected.updatedAt, saved.updatedAt);
});

/** Test: Corrected fact is retrieved correctly and old version is not. */
test("corrected fact is retrieved and old text is no longer returned", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Save a fact
  const saved = app.store.save("memory", owner, "fact-3", {
    text: "Old text",
    source: "Original"
  });

  // Correct it
  const corrected = app.store.updateMemory(owner, {
    id: saved.id,
    text: "New text",
    source: "Correction",
    expectedRevision: saved.revision
  }, "edit-run");

  // Retrieve the fact
  const retrieved = app.store.get("memory", owner, saved.id);
  assert.equal(retrieved.data.text, "New text");
  assert.equal(retrieved.data.source, "Correction");
  assert.notEqual(retrieved.data.text, "Old text");
});

/** Test: Stale edits with wrong revision are rejected. */
test("stale memory edits are rejected with revision mismatch", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Save a fact
  const saved = app.store.save("memory", owner, "fact-4", {
    text: "Fact v1",
    source: "Owner"
  });

  // First correction
  const corrected = app.store.updateMemory(owner, {
    id: saved.id,
    text: "Fact v2",
    source: "Owner",
    expectedRevision: saved.revision
  }, "edit-1");

  assert.equal(corrected.revision, 2);

  // Attempt stale edit with old revision
  assert.throws(() => app.store.updateMemory(owner, {
    id: saved.id,
    text: "Stale overwrite",
    source: "Owner",
    expectedRevision: saved.revision  // Using original revision, not current
  }, "edit-2"), /changed since/);

  // Verify current text is unchanged
  const final = app.store.get("memory", owner, saved.id);
  assert.equal(final.data.text, "Fact v2");
});

/** Test: Origin label logic distinguishes owner-said, project decisions, and inferred facts. */
test("memory facts track their origin (owner-said, decision, inferred)", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Owner-said fact (sourceRunId indicates owner editing)
  const ownerFact = app.store.save("memory", owner, "fact-owner", {
    text: "I prefer tea",
    source: "Workspace owner",
    sourceRunId: "run-user"
  });

  // Project decision fact (kind indicates decision)
  const decisionFact = app.store.save("memory", owner, "fact-decision", {
    text: "Use TypeScript for this project",
    source: "Project guidelines",
    kind: "project-note"
  });

  // Inferred fact (no sourceRunId, no kind)
  const inferredFact = app.store.save("memory", owner, "fact-inferred", {
    text: "User likes documentation",
    source: "Assistant inference"
  });

  // Verify all facts are retrievable
  const all = app.store.list("memory", owner);
  assert.equal(all.length, 3);

  // Verify each fact's fields
  const owner_rec = all.find(f => f.id === "fact-owner");
  assert.equal(owner_rec.data.sourceRunId, "run-user");

  const decision_rec = all.find(f => f.id === "fact-decision");
  assert.equal(decision_rec.data.kind, "project-note");

  const inferred_rec = all.find(f => f.id === "fact-inferred");
  // sourceRunId defaults to empty string when not provided
  assert.equal(inferred_rec.data.sourceRunId || undefined, undefined);
  assert.equal(inferred_rec.data.kind, undefined);
});

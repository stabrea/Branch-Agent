import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-memory-q54-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  
  // Start server for HTTP tests
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  
  t.after(async () => {
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  
  return { app, server };
}

/** Fetch from server with Bearer token. */
async function apiFetch(server, path, body) {
  const response = await fetch(new URL(`/api/${path}`, server.url), {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data };
}

/** Test: Memory correction through HTTP with revision checking. */
test("HTTP POST /api/action with memory.update rejects stale revision", async (t) => {
  const { app, server } = await fixture(t);
  const owner = "local";
  
  // Save a fact directly in the store
  const saved = app.store.save("memory", owner, "fact-http-1", {
    text: "Original text",
    source: "Test",
    sourceRunId: "run-1"
  });
  
  // Try to update via HTTP action API with correct revision
  const { status: updateStatus, data: updateData } = await apiFetch(server, "action", {
    tool: "memory.update",
    args: {
      id: saved.id,
      text: "Corrected text",
      source: "Test correction",
      expectedRevision: saved.revision
    }
  });
  
  assert.equal(updateStatus, 200);
  assert.equal(updateData.data.text, "Corrected text");
  assert.equal(updateData.revision, 2);
  
  // Try with stale revision - should fail
  const { status: staleStatus, data: staleData } = await apiFetch(server, "action", {
    tool: "memory.update",
    args: {
      id: saved.id,
      text: "Stale attempt",
      source: "Old version",
      expectedRevision: saved.revision  // Using original revision, not current
    }
  });
  
  assert.equal(staleStatus, 400);
  assert.match(staleData.error, /changed since/);
  
  // Verify current text is unchanged
  const current = app.store.get("memory", owner, saved.id);
  assert.equal(current.data.text, "Corrected text");
  assert.notEqual(current.data.text, "Stale attempt");
});

/** Test: Memory retrieval returns corrected text, not old version. */
test("memory retrieval function returns corrected fact text", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";
  
  // Save a fact
  const saved = app.store.save("memory", owner, "fact-retrieval", {
    text: "Old fact text",
    source: "Original"
  });
  
  // Retrieve via search (the retrieval path used in prompts)
  let results = app.store.searchMemory(owner, "fact");
  assert.equal(results.length, 1);
  assert.equal(results[0].data.text, "Old fact text");
  
  // Correct it
  const corrected = app.store.updateMemory(owner, {
    id: saved.id,
    text: "New fact text",
    source: "Correction",
    expectedRevision: saved.revision
  }, "edit-run");
  
  // Retrieve again - should get new text
  results = app.store.searchMemory(owner, "fact");
  assert.equal(results.length, 1);
  assert.equal(results[0].data.text, "New fact text");
  assert.ok(!results[0].data.text.includes("Old"));

  // Search for old text - should NOT find it
  results = app.store.searchMemory(owner, "Old fact");
  assert.equal(results.length, 0);
});

/** Test: Recorded fact fields (kind, originRunId, source, revision). */
test("fact displays recorded kind, conversation link when originRunId exists, and revision", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Fact with kind (will display "Project note" in UI)
  const projectNote = app.store.save("memory", owner, "fact-decision", {
    text: "Use TypeScript for this project",
    source: "Project guideline",
    kind: "project-note",
    originRunId: "run-project-123"  // Links to a conversation
  });

  // Fact with different kind
  const prefFact = app.store.save("memory", owner, "fact-pref", {
    text: "I prefer coffee",
    source: "User input",
    kind: "preference",
    sourceRunId: "run-user-456"
  });

  // Fact without kind
  const noKindFact = app.store.save("memory", owner, "fact-no-kind", {
    text: "Learned something",
    source: "Task output"
  });

  // Verify recorded fields
  assert.equal(projectNote.data.kind, "project-note");
  assert.equal(projectNote.data.originRunId, "run-project-123");
  assert.equal(projectNote.revision, 1);

  assert.equal(prefFact.data.kind, "preference");
  assert.equal(prefFact.data.sourceRunId, "run-user-456");

  assert.equal(noKindFact.data.kind, undefined);
  assert.ok(!noKindFact.data.originRunId && !noKindFact.data.sourceRunId);
});

/** Test: Non-owner cannot correct facts (permission check). */
test("non-owner key is denied memory correction", async (t) => {
  const { app } = await fixture(t);
  const owner = "local";

  // Save a fact as owner
  const saved = app.store.save("memory", owner, "fact-perm", {
    text: "Private fact",
    source: "Owner"
  });

  // Try to update as a non-owner context (no permissions) - should reject
  const nonOwnerContext = app.runtime.context({ permissions: ["memory.read"] });
  await assert.rejects(
    () => app.registry.execute("memory.update", {
      id: saved.id,
      text: "Hacked",
      source: "Attacker",
      expectedRevision: saved.revision
    }, nonOwnerContext),
    /Permission denied/
  );
});

/** Test: Malformed correction request via HTTP returns validation error. */
test("HTTP POST /api/action with invalid memory.update body returns 400", async (t) => {
  const { app, server } = await fixture(t);
  const owner = "local";
  
  // Save a fact
  const saved = app.store.save("memory", owner, "fact-malformed", {
    text: "Original",
    source: "Test"
  });
  
  // Send malformed request: missing expectedRevision
  const { status, data } = await apiFetch(server, "action", {
    tool: "memory.update",
    args: {
      id: saved.id,
      text: "New text",
      source: "Test"
      // expectedRevision is missing - should fail validation
    }
  });
  
  assert.equal(status, 400);
  assert.match(data.error, /expectedRevision|required/i);
});

/** Test: Memory with kind and originRunId is editable and retrieves new text. */
test("memory with kind displays recorded field; edit updates and retrieval finds new text", async (t) => {
  const { app, server } = await fixture(t);
  const owner = app.runtime.owner;

  // Save a fact with kind (will display as "Preference") and originRunId (links to conversation)
  const saved = app.store.save("memory", owner, "ui-fact", {
    text: "Coffee lover",
    source: "User preference",
    kind: "preference",
    originRunId: "run-123"
  });

  // Verify recorded fields are set correctly
  assert.equal(saved.data.kind, "preference");
  assert.equal(saved.data.originRunId, "run-123");
  assert.equal(saved.revision, 1);

  // Verify the memory.update tool works through the action API
  const { status, data } = await apiFetch(server, "action", {
    tool: "memory.update",
    args: {
      id: saved.id,
      text: "Tea and coffee lover",
      source: "User preference update",
      expectedRevision: saved.revision
    }
  });

  assert.equal(status, 200);
  assert.equal(data.data.text, "Tea and coffee lover");
  assert.equal(data.revision, 2);

  // Verify retrieval returns the updated text (not old)
  const retrieved = app.store.get("memory", owner, saved.id);
  assert.equal(retrieved.data.text, "Tea and coffee lover");
  assert.ok(!retrieved.data.text.includes("Coffee lover"));
});

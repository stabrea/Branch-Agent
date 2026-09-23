import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { unifiedSearch } from "../dist/unified-search.js";

/**
 * FQ-collaboration.unified-search: one query across a conversation, a saved workflow and an audit
 * (repository) entry, all planted with the same distinctive word, and back over HTTP as the owner.
 */

function seedConversation(store, owner, content) {
  const run = store.createRun(owner, "Unified search fixture");
  store.message(run.sessionId, { role: "user", content });
  store.finish(run.id, "completed", "Fixture complete");
  return run;
}

async function served(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-unified-search-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discardTemp(root);
  });
  const ownerHeaders = { authorization: `Bearer ${server.token}` };
  const get = async (path, headers = ownerHeaders) => {
    const response = await fetch(server.url + path, { headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, get, ownerHeaders };
}

test("unified search finds a conversation, a workflow and a repository event sharing one word, each with a link that resolves", async (t) => {
  const { app, get } = await served(t);
  const owner = app.runtime.owner;
  const word = "quetzalcoatl9000";

  const run = seedConversation(app.store, owner, `The plan mentions ${word} in the notes.`);
  const workflow = app.workflows.create(owner, {
    name: `Fixture workflow ${word}`,
    description: `A saved workflow used only to test ${word} search.`,
    steps: [{ name: "Say hello", kind: "prompt", prompt: "Say hello." }],
  });
  app.store.audit.record(owner, {
    action: "data.exported", actor: owner, subject: `export touching ${word}`,
    reason: "Fixture for unified search", outcome: "saved",
  });

  const found = await get(`/api/search?q=${encodeURIComponent(word)}`);
  assert.equal(found.status, 200);
  const { results } = found.body;
  assert.equal(results.length, 3, JSON.stringify(results));

  const conversation = results.find((r) => r.kind === "conversation");
  const workflowResult = results.find((r) => r.kind === "workflow");
  const repository = results.find((r) => r.kind === "repository");
  assert.ok(conversation, "a conversation result is expected");
  assert.ok(workflowResult, "a workflow result is expected");
  assert.ok(repository, "a repository (audit) result is expected");

  assert.equal(conversation.link, `/api/sessions/${run.sessionId}`);
  assert.equal(workflowResult.link, `/api/workflows/${workflow.id}`);
  assert.equal(repository.link, "/api/audit");

  // Each link is a real route the app can open: it resolves with 200 for the owner.
  for (const result of results) {
    const opened = await get(result.link);
    assert.equal(opened.status, 200, `${result.kind} link ${result.link} did not resolve`);
  }
});

test("unified search returns nothing for a word that appears nowhere", async (t) => {
  const { get } = await served(t);
  const found = await get("/api/search?q=nothing-matches-this-anywhere-12345");
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.results, []);
});

test("a short-lived key cannot search: only the owner's own key reaches /api/search", async (t) => {
  const { app, server, get } = await served(t);
  const owner = app.runtime.owner;
  const word = "shortlivedkeydenied";
  seedConversation(app.store, owner, `Notes about ${word}.`);

  const readKey = app.sessionTokens.create(owner, { name: "wall", scope: "read", minutes: 5 }).token;
  const runKey = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 }).token;
  for (const key of [readKey, runKey]) {
    const refused = await get(`/api/search?q=${encodeURIComponent(word)}`, { authorization: `Bearer ${key}` });
    assert.equal(refused.status, 401, `key should be refused, got ${refused.status}`);
  }
  // Sanity: the owner's own key (this computer's) still works for the same query.
  const allowed = await get(`/api/search?q=${encodeURIComponent(word)}`, { authorization: `Bearer ${server.token}` });
  assert.equal(allowed.status, 200);
  assert.ok(allowed.body.results.length >= 1);
});

test("conversations come back one row each, so a busy conversation cannot hide a quieter one that also matches", async (t) => {
  const { app, get } = await served(t);
  const owner = app.runtime.owner;
  const word = "okapilantern";
  // B first, so every A message has a newer id: with equal wording the ranks tie and newer wins,
  // which is exactly the order in which A's six hits used to fill all five places.
  const quiet = app.store.createRun(owner, "Older conversation B");
  app.store.message(quiet.sessionId, { role: "user", content: `Notes about ${word}.` });
  app.store.finish(quiet.id, "completed", "Fixture complete");
  const busy = app.store.createRun(owner, "Busy conversation A");
  for (let i = 0; i < 6; i += 1) app.store.message(busy.sessionId, { role: "user", content: `Notes about ${word}.` });
  app.store.finish(busy.id, "completed", "Fixture complete");

  const found = await get(`/api/search?q=${encodeURIComponent(word)}`);
  assert.equal(found.status, 200);
  const conversations = found.body.results.filter((r) => r.kind === "conversation");
  assert.equal(conversations.length, 2, JSON.stringify(conversations));
  assert.deepEqual(new Set(conversations.map((r) => r.link)),
    new Set([`/api/sessions/${busy.sessionId}`, `/api/sessions/${quiet.sessionId}`]));
});

test("a query of more than 32 words still answers: conversations use the first 32, workflows and the record still match", async (t) => {
  const { app, get } = await served(t);
  const owner = app.runtime.owner;
  const words = Array.from({ length: 40 }, (_, i) => `k${i + 1}`);
  const query = words.join(" ");
  assert.ok(query.length <= 200, "under the 200-character cap, so only the word count is in play");
  const run = seedConversation(app.store, owner, `Long notes: ${query}`);
  app.workflows.create(owner, {
    name: "Forty word workflow",
    description: `Holds every word: ${query}`,
    steps: [{ name: "Say hello", kind: "prompt", prompt: "Say hello." }],
  });
  app.store.audit.record(owner, {
    action: "data.exported", actor: owner, subject: "forty word export",
    reason: `Holds every word: ${query}`, outcome: "saved",
  });

  const found = await get(`/api/search?q=${encodeURIComponent(query)}`);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const kinds = found.body.results.map((r) => r.kind);
  assert.ok(kinds.includes("workflow"), JSON.stringify(found.body.results));
  assert.ok(kinds.includes("repository"), JSON.stringify(found.body.results));
  const conversation = found.body.results.find((r) => r.kind === "conversation");
  assert.equal(conversation?.link, `/api/sessions/${run.sessionId}`);
});

test("an older matching record entry is still found behind 250 newer ones that do not match", async (t) => {
  const { app, get } = await served(t);
  const owner = app.runtime.owner;
  const word = "wombatledger";
  app.store.audit.record(owner, {
    action: "data.exported", actor: owner, subject: `export touching ${word}`,
    reason: "The one old entry that matches", outcome: "saved",
  });
  for (let i = 0; i < 250; i += 1) {
    app.store.audit.record(owner, {
      action: "data.exported", actor: owner, subject: `unrelated export ${i}`,
      reason: "Newer and not a match", outcome: "saved",
    });
  }
  const found = await get(`/api/search?q=${encodeURIComponent(word)}`);
  assert.equal(found.status, 200);
  const repository = found.body.results.filter((r) => r.kind === "repository");
  assert.equal(repository.length, 1, JSON.stringify(found.body.results));
  assert.equal(repository[0].snippet, `export touching ${word}`);
});

test("unified search refuses a household profile by itself, not only behind the route's outer walls", async (t) => {
  const { app } = await served(t);
  const owner = app.runtime.owner;
  const word = "householdrefusal";
  seedConversation(app.store, owner, `Notes about ${word}.`);
  // Called directly, the way the route calls it, so the HTTP walls that already refuse a household
  // window before any route runs (src/household-routes.ts) are not what is being checked here.
  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  assert.throws(() => unifiedSearch(app, owner, word), /belongs to the owner/);
  app.store.profiles.switch({ profileId: null });
  assert.ok(unifiedSearch(app, owner, word).length >= 1, "the owner's own search still answers");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../../../dist/index.js";
import { startServer } from "../../../dist/server.js";
import { BranchClient, BranchError, fromDataDir } from "../client.mjs";

/**
 * The client is proved against a real Branch Agent: a whole app is started, a real server is put
 * in front of it, and every call goes over the network the way a script on this computer would
 * make it. Nothing here is a stand-in for the server.
 */
const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = {
    name: "scripted",
    requests: [],
    async complete(request) {
      provider.requests.push(request);
      return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
    },
  };
  return provider;
}
async function live(t, steps = [say("Here is the answer.")]) {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, root, provider, server, branch: new BranchClient({ url: server.url, token: server.token }) };
}

test("the client needs an address and a key, and refuses without either", () => {
  assert.throws(() => new BranchClient({ url: "http://127.0.0.1:3210" }), /session key/);
  assert.throws(() => new BranchClient({ token: "abc" }), /session key/);
  const branch = new BranchClient({ url: "http://127.0.0.1:3210/", token: "abc" });
  assert.equal(branch.url, "http://127.0.0.1:3210", "a trailing slash is not doubled up");
});

test("it reads the address and key an install already wrote, so a script needs no configuration", async (t) => {
  const { root, server } = await live(t);
  const port = Number(new URL(server.url).port);
  const branch = await fromDataDir(join(root, "data"), { port });
  assert.equal(branch.token, server.token);
  const state = await branch.state();
  assert.equal(typeof state.version, "string");
});

test("a task is started, watched as it happens, read back, and steered", async (t) => {
  const { branch, app } = await live(t, [say("Three lines about the meeting.")]);
  const run = await branch.runs.start({ prompt: "Summarise the meeting notes" });
  assert.match(run.id, /^[0-9a-f-]{36}$/);

  const seen = [];
  for await (const event of branch.runs.stream(run.id)) {
    seen.push(event.kind);
    if (event.kind === "end") break;
  }
  assert.ok(seen.includes("end"), "the stream says when the task is over");
  assert.ok(seen.length > 1, "the events before it came through too");

  const read = await branch.runs.get(run.id);
  assert.equal(read.run.status, "completed");
  assert.equal(read.run.output, "Three lines about the meeting.");
  assert.ok(Array.isArray(read.events));

  const steered = await branch.sessions.followUp(run.sessionId, "And keep it shorter.");
  assert.ok(steered, "a follow-up is accepted on the same conversation");
  assert.equal(app.store.run(run.id).id, run.id);
});

test("the same events come through a socket", async (t) => {
  const { branch } = await live(t, [say("Done.")]);
  const run = await branch.runs.start({ prompt: "Do the thing" });
  const seen = [];
  for await (const event of branch.runs.watch(run.id)) {
    seen.push(event);
    if (event.type === "end" || event.kind === "end") break;
  }
  assert.ok(seen.length >= 1, "the socket carried the task's events");
});

test("cancel, resume and approvals go through the same client", async (t) => {
  const { branch, app } = await live(t);
  const run = await branch.runs.start({ prompt: "Something" });
  const cancelled = await branch.runs.cancel(run.id);
  assert.equal(typeof cancelled.cancelled, "boolean");

  await branch.policy.save({ preset: "ask-before-changes" });
  const policy = await branch.policy.get();
  assert.equal(policy.policy.preset, "ask-before-changes");
  assert.ok(policy.presets.length >= 4);

  const kinds = await branch.policy.categories();
  assert.ok(kinds.categories.some((row) => row.id === "commands"));
  const saved = await branch.policy.setCategories({ commands: "ask" });
  assert.equal(saved.policy.preset, "custom");
  assert.ok(app.store.audit.list("local", { action: "policy.changed" }).length >= 2);
});

test("sessions, memory, documents and schedules all answer", async (t) => {
  const { branch, app } = await live(t);
  const run = await branch.runs.start({ prompt: "Say something" });

  const session = await branch.sessions.get(run.sessionId);
  assert.equal(session.id ?? run.sessionId, run.sessionId);
  const summary = await branch.sessions.summary(run.sessionId);
  assert.ok(summary);
  const found = await branch.sessions.search({ query: "something" });
  assert.ok(found);

  await branch.documents.add({ name: "Notes", text: "The Northgate invoice is due on Friday." });
  const documents = await branch.documents.list();
  assert.equal(documents.documents.length, 1);
  const hits = await branch.documents.search("Northgate invoice");
  assert.ok(hits.results.length >= 1);
  const removed = await branch.documents.remove(documents.documents[0].id);
  assert.equal(removed.removed, documents.documents[0].id);

  app.store.save("memory", "local", "fact-1", { text: "Northgate pays on Fridays" });
  const notes = await branch.memory.search("Northgate");
  assert.ok(notes.results.length >= 1);
  const memorySettings = await branch.memory.settings();
  assert.equal(typeof memorySettings.settings.useEmbeddings, "boolean");

  const scheduleId = randomUUID();
  const schedule = app.store.save("schedules", "local", scheduleId, { name: "Daily", prompt: "check", cron: "0 9 * * *" });
  const one = await branch.schedules.get(schedule.id);
  assert.equal(one.id, schedule.id);
});

test("the smaller screens answer too: the record, questions first, searching, and the tool list", async (t) => {
  const questions = JSON.stringify({ questions: [{ question: "Which folder?", suggested: "invoices" }] });
  const { branch } = await live(t, [say(questions)]);

  const tools = await branch.tools();
  assert.ok(tools.tools.length > 5);

  await branch.policy.save({ preset: "read-only" });
  const record = await branch.audit({ action: "policy.changed" });
  assert.ok(record.entries.length >= 1);
  assert.equal(record.entries[0].action, "policy.changed");

  const asked = await branch.askFirst("Tidy the invoices folder, then rename this year's files, and finally write a summary of it all into notes.md.", true);
  assert.equal(asked.skipped, false);
  assert.equal(asked.questions[0].question, "Which folder?");
  const withAnswers = await branch.withAnswers("Tidy the folder", [{ question: "Which folder?", answer: "invoices" }]);
  assert.match(withAnswers.prompt, /invoices/);

  await branch.documents.add({ name: "Notes", text: "Sam agreed to send the Northgate invoice by Friday." });
  const search = await branch.search("Northgate invoice");
  assert.equal(search.reranked, "words");
  assert.ok(search.passages.length >= 1);
});

test("a refusal comes back as a BranchError carrying the app's own wording", async (t) => {
  const { branch, server } = await live(t);
  await assert.rejects(() => branch.runs.get("00000000-0000-0000-0000-000000000000"), (error) => {
    assert.ok(error instanceof BranchError);
    assert.equal(error.status, 404);
    assert.match(error.message, /not found/i);
    return true;
  });
  await assert.rejects(() => branch.runs.start({ prompt: "" }), (error) => {
    assert.equal(error.status, 400);
    return true;
  });
  const wrongKey = new BranchClient({ url: server.url, token: "0".repeat(64) });
  await assert.rejects(() => wrongKey.state(), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
});

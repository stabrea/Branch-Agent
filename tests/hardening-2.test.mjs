/**
 * Hardening pass 2: the gaps the wave 7 integrators wrote down as "not fixed". One test per gap,
 * each one the test that would have caught it. Fakes only: no real network, no real screen, no
 * real outside server, nothing on the desktop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBranch, savePolicy } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

async function fixture(t, reply = () => say("done"), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening2-"));
  const provider = { name: "scripted", async complete(request) { return reply(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => {
    await app.processes.stopAll().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

// ---------------------------------------------------------------------------
// 1. Reading passages by meaning goes through the same network rules as every
//    other call to a provider. Nothing here reaches the real network.
// ---------------------------------------------------------------------------

test("a provider on a refused address cannot be asked to read passages", async () => {
  const { NetworkPolicy } = await import("../dist/network-policy.js");
  const { embeddingsFor, embeddingFetch } = await import("../dist/embeddings.js");
  // The blocked list is checked before anything is looked up, so this needs no network at all.
  const policy = new NetworkPolicy({ blockedHosts: ["embeddings.example"] }, async () => ["203.0.113.9"]);
  let reached = 0;
  const guarded = policy.guard(async () => { reached++; return new Response("{}"); });
  for (const connection of [
    { shape: "openai", endpoint: "https://embeddings.example/v1", apiKey: "k", model: "text-embedding-3-small", local: false },
    { shape: "gemini", endpoint: "https://embeddings.example/v1", apiKey: "k", model: "text-embedding-004", local: false },
  ]) {
    const reader = embeddingsFor(connection, guarded);
    await assert.rejects(() => reader.embed(["hello"], AbortSignal.timeout(2000)), /blocked list/,
      `${connection.shape} must be refused before a passage leaves`);
  }
  assert.equal(reached, 0, "not one passage may reach a refused address");
  // An allowed address is still reached, so the rules narrow rather than switch the reading off.
  const open = new NetworkPolicy({}, async () => ["203.0.113.9"]);
  assert.notEqual(embeddingFetch("https://reader.example/v1", open.guard(async () => new Response("{}"))), globalThis.fetch);
  // A reader on this computer is reached directly: the rules refuse local addresses on purpose.
  assert.equal(embeddingFetch("http://127.0.0.1:11434/v1", guarded), globalThis.fetch);
});

test("the app hands its guarded fetch to every reader of passages", async (t) => {
  const { app } = await fixture(t);
  // The three readers the app builds all take the guard rather than a bare fetch.
  assert.notEqual(app.documents.embeddingFetch, globalThis.fetch, "the document library");
  assert.notEqual(app.memory.retrieval.embeddingFetch, globalThis.fetch, "saved facts");
  assert.notEqual(app.knowledgeBases.embeddingCall, globalThis.fetch, "knowledge bases and tool meaning search");
});

// ---------------------------------------------------------------------------
// 2. One conversation can stop on several questions at once. A second must not
//    silently take the first's place, leaving its task waiting for ever.
// ---------------------------------------------------------------------------

const question = (sessionId, tool, target, fingerprint) => ({
  runId: `run-${fingerprint}`, sessionId, tool, target, label: `${tool} on ${target}`,
  question: `Before I go ahead: ${tool}. Is that all right?`, source: "owner", remember: "session",
  askedAt: new Date().toISOString(), bytes: `{"${target}":1}`, fingerprint,
});

test("a conversation keeps every question it stopped on, and answers each by its own request", async () => {
  const { ApprovalGate, maximumPendingPerSession, droppedPendingMessage } = await import("../dist/approvals.js");
  const gate = new ApprovalGate();
  const a = "a".repeat(32), b = "b".repeat(32);
  assert.equal(gate.ask(question("s1", "files.write", "one.txt", a)), null);
  assert.equal(gate.ask(question("s1", "files.write", "two.txt", b)), null, "a second question does not replace the first");
  assert.deepEqual(gate.waiting("s1").map((entry) => entry.target), ["one.txt", "two.txt"], "oldest first");
  // The same exact request asked again is the same question, not a second copy of it.
  gate.ask(question("s1", "files.write", "one.txt", a));
  assert.equal(gate.waiting("s1").length, 2);
  // An answer lands on the request it was given for, whichever place in the list that is.
  assert.equal(gate.resolve("s1", b).target, "two.txt");
  assert.equal(gate.waiting("s1").length, 1);
  // With only one left, an answer with no fingerprint still finds it, as it always did.
  assert.equal(gate.resolve("s1").target, "one.txt");
  assert.equal(gate.waiting("s1").length, 0);
  assert.equal(gate.resolve("s1"), undefined);

  // Past the cap the one that has been waiting longest is handed back, so its task can be told.
  for (let index = 0; index < maximumPendingPerSession; index++)
    assert.equal(gate.ask(question("s2", "files.write", `file-${index}.txt`, String(index).padStart(32, "0"))), null);
  const dropped = gate.ask(question("s2", "files.write", "one-too-many.txt", "f".repeat(32)));
  assert.equal(dropped?.target, "file-0.txt", "the oldest is the one that goes");
  assert.equal(gate.waiting("s2").length, maximumPendingPerSession, "and the list never grows past its cap");
  assert.match(droppedPendingMessage(dropped.label), /waiting longest was let go/);
});

test("two tasks in one conversation both put their question, and the web card answers each", async (t) => {
  // Two tasks running side by side in the same conversation, each stopping on a write of its own.
  // Before, the second question replaced the first and the first task waited for ever.
  const asked = (path) => ({ content: "", toolCalls: [{ id: `c-${path}`, name: "files.write",
    arguments: JSON.stringify({ path, content: path }) }] });
  const { app, root } = await fixture(t, (request) => {
    const prompt = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
    return asked(prompt.includes("one") ? "one.txt" : "two.txt");
  });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const sessionId = app.store.createSession(app.runtime.owner);
  // The first task stops to ask. The second, in the same conversation, stops to ask about something
  // else while the first is still waiting — which is where the first used to be quietly replaced.
  const runs = [await app.runtime.run({ prompt: "write one", sessionId }),
    await app.runtime.run({ prompt: "write two", sessionId })];
  assert.deepEqual(runs.map((run) => run.status), ["needs_input", "needs_input"]);
  const waiting = app.runtime.waitingApprovals(sessionId);
  assert.equal(waiting.length, 2, "both questions are waiting, not one on top of the other");
  assert.deepEqual(waiting.map((entry) => entry.target).sort(), ["one.txt", "two.txt"]);
  assert.equal(new Set(waiting.map((entry) => entry.fingerprint)).size, 2, "each is known by its own request");

  // The app's own approval card answers the second by its fingerprint, over the real route.
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const second = waiting[1];
  const response = await fetch(`${server.url}/api/policy/approve`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, decision: "allow", remember: "session", fingerprint: second.fingerprint }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).target, second.target);
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((entry) => entry.target), [waiting[0].target]);
  // And the one left is still answerable with no fingerprint at all, as it always was.
  assert.equal(app.runtime.approve(sessionId, "deny", "session").target, waiting[0].target);
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 0);
});

test("a chat app's buttons answer the question they were sent for, not whichever came last", async (t) => {
  const { app } = await fixture(t);
  const { ApprovalGate } = await import("../dist/approvals.js");
  const gate = app.runtime.approvals;
  assert.ok(gate instanceof ApprovalGate);
  const a = "1".repeat(32), b = "2".repeat(32);
  const sessionId = app.store.createSession(app.runtime.owner);
  for (const [target, print] of [["one.txt", a], ["two.txt", b]]) {
    const run = app.store.createRun(app.runtime.owner, `write ${target}`, sessionId);
    gate.ask({ ...question(sessionId, "files.write", target, print), runId: run.id });
  }
  // The button carries the fingerprint the chat app was shown, which is the older of the two here.
  const result = app.runtime.approve(sessionId, "allow", "session", a, "telegram");
  assert.equal(result.target, "one.txt");
  assert.deepEqual(app.runtime.waitingApprovals(sessionId).map((entry) => entry.target), ["two.txt"]);
  // The record says it was answered on Telegram, and the task's own origin is kept beside it.
  const [entry] = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.equal(entry.source, "telegram");
  assert.equal(entry.origin, "owner");
});

test("one AI-tool connection may hold more than one question at a time", async (t) => {
  const { app, root } = await fixture(t, () => say("done"), { web: { allowPrivateAddresses: true } });
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const headers = (extra = {}) => ({ authorization: `Bearer ${server.token}`, origin: server.url,
    "content-type": "application/json", ...extra });
  const rpc = async (body, sessionId) => {
    const response = await fetch(`${server.url}/mcp`, { method: "POST",
      headers: headers(sessionId ? { "mcp-session-id": sessionId } : {}), body: JSON.stringify(body) });
    return { response, data: await response.json() };
  };
  const started = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "probe", version: "1.0.0" } } });
  const sessionId = started.response.headers.get("mcp-session-id");
  await fetch(`${server.url}/api/mcp/settings`, { method: "POST", headers: headers(),
    body: JSON.stringify({ enabled: true, exposedTools: ["files.write"] }) });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", match: "*", decision: "ask" }] });
  // This test is about how many questions may wait at once, not about the waiting, so it waits none.
  app.store.save("settings", app.runtime.owner, "mcp-serving", { idleMinutes: 30, askWaitSeconds: 0 });

  // Two different calls down one connection. Before, the second was turned away as "already
  // holding as many as it allows"; now both become questions the owner can see and answer.
  for (const path of ["one.txt", "two.txt"]) {
    const called = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "files.write", arguments: { path, content: "x" } } }, sessionId);
    assert.match(called.data.result.content[0].text, /waiting for your yes in Branch/,
      `${path} must become a question, not a refusal`);
  }
  const waiting = app.runtime.waitingApprovals(`mcp:${sessionId}`);
  assert.equal(waiting.length, 2, "both calls left a question the owner can answer");
  assert.deepEqual(waiting.map((entry) => entry.target).sort(), ["one.txt", "two.txt"]);
  assert.equal(new Set(waiting.map((entry) => entry.fingerprint)).size, 2);
});

// ---------------------------------------------------------------------------
// 3. The address a chat service posts to carries a word nobody can guess, so
//    the door cannot be found by guessing the name the owner chose.
// ---------------------------------------------------------------------------

test("a webhook address carries an unguessable word, which can be changed and never leaks", async (t) => {
  const { app } = await fixture(t);
  const address = await import("../dist/channels/webhook-address.js");
  const owner = app.runtime.owner;
  const first = address.webhookSecret(app.store, owner, "telegram");
  assert.match(first, /^[a-f0-9]{32}$/, "128 bits, written as an address can carry it");
  assert.equal(address.webhookSecret(app.store, owner, "telegram"), first, "asking twice gives the address in use");
  assert.notEqual(address.webhookSecret(app.store, owner, "slack"), first, "each channel has its own");
  assert.equal(address.webhookAddress("chat", "telegram", first), `/webhooks/chat/telegram/${first}`);
  // Making a new one really changes it, and the old one stops matching.
  const second = address.rotateWebhookSecret(app.store, owner, "telegram");
  assert.notEqual(second, first);
  assert.equal(address.sameSecret(first, second), false);
  assert.equal(address.sameSecret(second, second), true);
  // Nothing that is not the right shape is ever compared as though it might be.
  for (const wrong of ["", "x", second.toUpperCase(), second.slice(0, 31), `${second}0`])
    assert.equal(address.sameSecret(wrong, second), false, JSON.stringify(wrong));
  // The one-release grace has a date on it from the moment the first address was made.
  assert.match(address.webhookAddressSettings(app.store, owner).oldAddressesEndOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(address.webhookAddressSettings(app.store, owner).acceptOldAddresses, true);
});

test("the old shape of address is answered while the grace lasts, and 404s once it is off", async (t) => {
  const { app } = await fixture(t);
  const { webhookAddressRefusal, webhookSecret, saveWebhookAddressSettings } = await import("../dist/channels/webhook-address.js");
  const owner = app.runtime.owner;
  const secret = webhookSecret(app.store, owner, "telegram");
  // The right word is always answered; the wrong word never is; none is answered only in the grace.
  assert.equal(webhookAddressRefusal(app.store, owner, "telegram", secret), null);
  assert.match(webhookAddressRefusal(app.store, owner, "telegram", "0".repeat(32)) ?? "", /No chat service is connected/);
  assert.equal(webhookAddressRefusal(app.store, owner, "telegram", undefined), null, "while the grace lasts");
  saveWebhookAddressSettings(app.store, owner, { acceptOldAddresses: false });
  assert.match(webhookAddressRefusal(app.store, owner, "telegram", undefined) ?? "", /No chat service is connected/);
  assert.equal(webhookAddressRefusal(app.store, owner, "telegram", secret), null, "the new shape keeps working");
  // A wrong address says nothing about which channel names exist: the same sentence either way.
  assert.equal(webhookAddressRefusal(app.store, owner, "telegram", "0".repeat(32)),
    webhookAddressRefusal(app.store, owner, "nothing-here", "0".repeat(32)));
});

test("the whole webhook route answers the new shape and refuses a guessed one", async (t) => {
  const { app, root } = await fixture(t);
  const { startServer } = await import("../dist/server.js");
  const { webhookSecret, saveWebhookAddressSettings } = await import("../dist/channels/webhook-address.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = (path) => fetch(`${server.url}${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: "{}" });
  const secret = webhookSecret(app.store, app.runtime.owner, "telegram");
  // No channel is connected in this launch, so every one of these ends in 404 — but the route
  // reaches the channel lookup only for an address whose word is right.
  assert.equal((await post(`/webhooks/chat/telegram/${"0".repeat(32)}`)).status, 404);
  assert.match((await (await post(`/webhooks/chat/telegram/${"0".repeat(32)}`)).json()).error, /No chat service is connected/);
  assert.match((await (await post(`/webhooks/chat/telegram/${secret}`)).json()).error, /no chat service with that name|No chat service with that name/i);
  // With the grace switched off, the old shape is refused before anything else is looked at.
  saveWebhookAddressSettings(app.store, app.runtime.owner, { acceptOldAddresses: false });
  assert.match((await (await post("/webhooks/chat/telegram")).json()).error, /No chat service is connected/);
});

// ---------------------------------------------------------------------------
// 4. A study's cells take places from the one shared count, and a benchmark is
//    read only from the workspace or the folder the owner named.
// ---------------------------------------------------------------------------

test("a study reads a benchmark only from the workspace or the folder the owner named", async (t) => {
  const { app, root } = await fixture(t);
  const { benchmarkFolderRefusal } = await import("../dist/study.js");
  const outside = join(root, "somewhere-else");
  assert.match(benchmarkFolderRefusal(outside, app.files.base, "") ?? "", /outside that/);
  assert.equal(benchmarkFolderRefusal(join(app.files.base, "gaia"), app.files.base, ""), null);
  assert.equal(benchmarkFolderRefusal(app.files.base, app.files.base, ""), null, "the workspace itself counts");
  assert.equal(benchmarkFolderRefusal(join(outside, "gaia"), app.files.base, outside), null, "the named folder counts");
  // A near-miss of the named folder is not inside it, whatever the string looks like.
  assert.match(benchmarkFolderRefusal(`${outside}-other`, app.files.base, outside) ?? "", /outside that/);
  // Saving a study that points outside is refused, and so is running an older one that does.
  const study = { id: "away", name: "Away", source: { kind: "benchmark", benchmark: "gaia", directory: outside }, presets: ["default"] };
  assert.throws(() => app.studies.save(study), /outside that/);
  app.store.save("governance", app.runtime.owner, "study:away", { ...study, subset: [], limit: 20, repeats: 1, concurrency: 2, retries: 1, maxSteps: 30, maxTokens: 120000, bestOfN: 1, description: "" });
  await assert.rejects(() => app.studies.run("away"), /outside that/);
  // Naming the folder in Settings is what lets it through, and the study then runs.
  app.studies.configure({ benchmarksFolder: outside });
  assert.equal(app.studies.settings().benchmarksFolder, outside);
  assert.equal(app.studies.save(study).id, "away");
});

test("every study cell takes a place from the shared count, and several studies cannot deadlock", async (t) => {
  const { ExecutionLimit } = await import("../dist/execution-limit.js");
  // Two places in all, and three studies each wanting two cells at once. Without the rule that a
  // study's first cell runs on the place it already holds, the two studies that got a place would
  // each wait for the other and nothing would ever finish.
  const limit = new ExecutionLimit(2);
  const held = [limit.take(), limit.take()];
  assert.ok(held.every(Boolean));
  assert.equal(limit.room, 0);
  // Waiting for a place is woken the moment one comes back, rather than polled blindly.
  let woke = false;
  const sleeping = limit.roomSoon(5000).then(() => { woke = true; });
  await delay(20);
  assert.equal(woke, false, "nothing came free yet");
  held[0]();
  await sleeping;
  assert.equal(woke, true, "giving a place up wakes whoever is waiting for one");
  assert.equal(limit.room, 1);
  // Giving the same place up twice cannot invent room, and the waiting line is still told.
  let told = 0;
  limit.onRoom = () => { told++; };
  held[0]();
  assert.equal(limit.room, 1);
  held[1]();
  assert.equal(limit.room, 2);
  assert.equal(told, 1);
  // A wait with nothing to wake it still comes back, which is what makes waiting safe at all.
  const began = Date.now();
  await new ExecutionLimit(0).roomSoon(50);
  assert.ok(Date.now() - began >= 40);
});

test("what the grader spends is counted against the study cell and against its budget", async (t) => {
  // Every reply is a grader's verdict as well as an answer, so the one scripted reply serves both.
  const { app } = await fixture(t, () => say('{"score": 1, "reason": "fine"}'));
  const { saveSuite } = await import("../dist/evaluation-suites.js");
  // The budget is listed first and the grader second: the order that used to hide the grader's cost.
  saveSuite(app.store, app.runtime.owner, {
    id: "graded", name: "Graded", tasks: [{ id: "one", prompt: "say something", scorers: [
      { kind: "budget", maxTokens: 1 }, { kind: "rubric", rubric: "Is it fine?", pass: 0.5 }] }],
  });
  app.studies.save({ id: "graded", name: "Graded", source: { kind: "suite", suite: "graded" }, presets: ["default"] });
  const result = await app.studies.run("graded");
  const [cell] = result.cells;
  // The task's own run used this much; the cell is charged for more than that, because grading is
  // a model call too and the study paid for it.
  const own = app.store.usage(cell.runId);
  const taskTokens = (own.estimatedInput ?? 0) + (own.estimatedOutput ?? 0);
  assert.ok(cell.tokens > taskTokens, `the grader's own tokens land on the cell (${cell.tokens} vs ${taskTokens})`);
  assert.equal(cell.passed, false, "a budget of one token cannot be met once the grader has spent");
  assert.ok(cell.reasons.some((reason) => /was the limit/.test(reason)), cell.reasons.join(" | "));
});

test("a study's own place is what stops it starving when the computer is full", async (t) => {
  const { app } = await fixture(t);
  const { ExecutionLimit } = await import("../dist/execution-limit.js");
  const limit = new ExecutionLimit(1);
  app.studies.executions = limit;
  app.studies.waitForPlaceMs = 300;
  // Every place is taken by something else, so no cell can get one of its own.
  const other = limit.take();
  t.after(() => other());
  const { saveSuite } = await import("../dist/evaluation-suites.js");
  saveSuite(app.store, app.runtime.owner, {
    id: "small", name: "Small", tasks: [{ id: "one", prompt: "one" }, { id: "two", prompt: "two" }, { id: "three", prompt: "three" }],
  });
  app.studies.save({ id: "busy", name: "Busy", source: { kind: "suite", suite: "small" }, presets: ["default"], concurrency: 3 });
  const result = await app.studies.run("busy");
  // Every cell still ran: the first worker uses the place the study itself holds.
  assert.equal(result.cells.length, 3, "a full computer must slow a study down, never stop it");
  assert.equal(limit.count, 1, "nothing the study took was left behind");
});

// ---------------------------------------------------------------------------
// 7. The owner may add websites their own browser must never be pointed at, and
//    may never take one off the built-in list.
// ---------------------------------------------------------------------------

test("the owner's extra refused websites are added to the built-in list, never subtracted", async () => {
  const { hostRefusalFor } = await import("../dist/integrations/desktop-config.js");
  const { attachedAddressRefusal, AttachSettingsSchema } = await import("../dist/integrations/browser-attach.js");
  // A site of the owner's own is refused once they name it, and not before.
  assert.equal(hostRefusalFor("payroll.example"), null);
  assert.match(hostRefusalFor("payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // Anything under it is refused too, exactly as the built-in entries are.
  assert.match(hostRefusalFor("login.payroll.example", ["payroll.example"]) ?? "", /passwords/);
  // The list is additive only: naming a built-in entry cannot turn it off, and neither can
  // handing in an empty list, whitespace, or something that looks like a removal.
  for (const extra of [[], ["chase.com"], ["  "], ["-chase.com"], ["!chase.com"]])
    assert.match(hostRefusalFor("chase.com", extra) ?? "", /money or passwords/, JSON.stringify(extra));
  // The whole-address check carries the owner's extra sites through.
  assert.equal(attachedAddressRefusal("https://payroll.example/pay"), null);
  assert.match(attachedAddressRefusal("https://payroll.example/pay", "", ["payroll.example"]) ?? "", /passwords/);
  // And the setting is a plain list kept beside the rest of the browser settings.
  assert.deepEqual(AttachSettingsSchema.parse({}).extraRefusedHosts, []);
});

test("the extra refused websites are saved and read back through the browser settings", async (t) => {
  const { app } = await fixture(t);
  const { readAttachSettings, saveAttachSettings } = await import("../dist/integrations/browser-attach.js");
  const saved = saveAttachSettings(app.store, app.runtime.owner, { extraRefusedHosts: ["payroll.example"] });
  assert.deepEqual(saved.extraRefusedHosts, ["payroll.example"]);
  assert.deepEqual(readAttachSettings(app.store, app.runtime.owner).extraRefusedHosts, ["payroll.example"]);
});

// ---------------------------------------------------------------------------
// 5. A language server or a program being debugged that a task started stops
//    when that task is over, unless the owner asked to keep it running.
// ---------------------------------------------------------------------------

test("a language server and a debuggee a task started go when that task is over", async (t) => {
  const { app, root } = await fixture(t);
  const { saveLanguageServerSettings, saveDebugSettings } = await import("../dist/index.js");
  const { fileURLToPath } = await import("node:url");
  const { writeFile } = await import("node:fs/promises");
  const fixtures = join(fileURLToPath(import.meta.url), "..", "fixtures");
  await saveLanguageServerSettings(app.store, "local", { enabled: true, timeoutMs: 10000,
    servers: { fake: { path: process.execPath, args: [join(fixtures, "fake-language-server.mjs")], languages: ["TypeScript"] } } });
  await saveDebugSettings(app.store, "local", { enabled: true, timeoutMs: 10000,
    adapters: { fake: { path: process.execPath, args: [join(fixtures, "fake-debug-adapter.mjs")], launch: {} } } });
  t.after(async () => { await app.languageServers.stopAll(); await app.debugAdapters.stopAll(); });
  await writeFile(join(app.files.base, "one.ts"), "export const one = 1;\n");

  const run = app.store.createRun(app.runtime.owner, "look at one.ts");
  app.store.message(run.sessionId, { role: "user", content: "look at one.ts" });
  const context = app.runtime.context({ runId: run.id, signal: AbortSignal.timeout(20000) });
  await app.languageServers.diagnostics({ path: "one.ts", waitMs: 200 }, run.id);
  await app.debugAdapters.start({ adapter: "fake", program: "one.ts", args: [], breakpoints: [], waitMs: 200 }, context);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 1);

  // The task is over: both go, without anyone having to remember to stop them.
  app.store.finish(run.id, "completed", "done");
  await delay(400);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 0,
    "a language server a task started does not outlive it");
  // Nothing is being debugged any more: the program the task launched went with it.
  await assert.rejects(() => app.debugAdapters.stop(context), /Nothing is being debugged/);
  assert.equal(await app.debugAdapters.closeRun(run.id), 0);
});

test("a task that only stopped to ask keeps what it started, and a pinned server stays up", async (t) => {
  const { app } = await fixture(t);
  const { saveLanguageServerSettings } = await import("../dist/index.js");
  const { fileURLToPath } = await import("node:url");
  const { writeFile } = await import("node:fs/promises");
  const fixtures = join(fileURLToPath(import.meta.url), "..", "fixtures");
  await saveLanguageServerSettings(app.store, "local", { enabled: true, timeoutMs: 10000,
    servers: { fake: { path: process.execPath, args: [join(fixtures, "fake-language-server.mjs")], languages: ["TypeScript"] } } });
  t.after(() => app.languageServers.stopAll());
  await writeFile(join(app.files.base, "two.ts"), "export const two = 2;\n");

  const waiting = app.store.createRun(app.runtime.owner, "ask first");
  app.store.message(waiting.sessionId, { role: "user", content: "ask first" });
  await app.languageServers.diagnostics({ path: "two.ts", waitMs: 200 }, waiting.id);
  // Stopping to ask the owner something is not the task being over.
  app.store.finish(waiting.id, "needs_input", "Is that all right?");
  await delay(200);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 1,
    "a task waiting on an answer still needs what it started");

  // And with "keep it running" on, the end of the task leaves it alone.
  await saveLanguageServerSettings(app.store, "local", { enabled: true, timeoutMs: 10000, keepRunning: true,
    servers: { fake: { path: process.execPath, args: [join(fixtures, "fake-language-server.mjs")], languages: ["TypeScript"] } } });
  app.store.finish(waiting.id, "completed", "done");
  await delay(200);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 1,
    "the owner pinned it, so it stays up");
  assert.equal(await app.languageServers.closeRun(waiting.id), 0);
});

test("a single tool press is not a task ending, so what it started stays up", async (t) => {
  const { app } = await fixture(t);
  const { saveLanguageServerSettings } = await import("../dist/index.js");
  const { fileURLToPath } = await import("node:url");
  const { writeFile } = await import("node:fs/promises");
  const fixtures = join(fileURLToPath(import.meta.url), "..", "fixtures");
  await saveLanguageServerSettings(app.store, "local", { enabled: true, timeoutMs: 10000,
    servers: { fake: { path: process.execPath, args: [join(fixtures, "fake-language-server.mjs")], languages: ["TypeScript"] } } });
  t.after(() => app.languageServers.stopAll());
  await writeFile(join(app.files.base, "three.ts"), "export const three = 3;\n");

  // Pressing a tool by hand makes a run of its own with no conversation behind it. Tidying up
  // there would stop the debugger between "start it" and "look at the variables".
  const pressed = app.store.createRun(app.runtime.owner, "diagnostics");
  assert.equal(app.store.messages(pressed.sessionId).length, 0);
  await app.languageServers.diagnostics({ path: "three.ts", waitMs: 200 }, pressed.id);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 1);

  app.store.finish(pressed.id, "completed", "done");
  await delay(400);
  assert.equal(app.languageServers.list().filter((server) => server.running).length, 1,
    "one tool press ending is not the owner's task ending");
});

// ---------------------------------------------------------------------------
// 6. A service the owner turned into tools is still there after a restart, and
//    "forget this service" really forgets it. Nothing is fetched on the way back.
// ---------------------------------------------------------------------------

/** The smallest OpenAPI description that yields one tool, so nothing has to be reached. */
const tinyService = (base) => JSON.stringify({
  openapi: "3.0.0", info: { title: "Tiny", version: "1" }, servers: [{ url: base }],
  paths: { "/things/{id}": { get: { operationId: "getThing", summary: "Get one thing",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    responses: { "200": { description: "ok" } } } } },
});

test("a service turned into tools comes back after a restart, without fetching anything", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-openapi-restart-"));
  const where = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  const provider = { name: "scripted", async complete() { return say("done"); } };
  // One app at a time over the same data, each closed before the next opens, and the folder taken
  // away only once every one of them has let go of the database.
  const open = [];
  t.after(async () => {
    for (const app of open) await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const first = await createBranch({ ...where, provider });
  open.push(first);
  // A loopback address, and nothing listening on it: adding the service reads the description from
  // the workspace and never calls the service itself.
  first.web.policy.configure({ allowPrivateAddresses: true });
  await first.files.write("tiny.json", tinyService("http://127.0.0.1:9/v1"), AbortSignal.timeout(5000));
  const made = await first.runtime.executeTool("tools.from_openapi", {
    name: "tiny", file: "tiny.json", allowlist: ["getThing"], secret: "TINY_KEY", auth: "bearer",
  });
  assert.deepEqual(made.registered, ["api.tiny.get_thing"]);
  await first.close();

  // A fresh app over the same data: the tools are back, with their shapes, and no key was stored.
  const second = await createBranch({ ...where, provider });
  open.push(second);
  assert.ok(second.registry.names().includes("api.tiny.get_thing"), "the service's tools survive a restart");
  assert.equal(second.registry.groupOf("api.tiny.get_thing"), "services");
  assert.deepEqual(second.openApiTools.list().map((service) => service.name), ["tiny"]);
  const saved = second.store.get("settings", second.runtime.owner, "openapi-service:tiny").data;
  assert.equal(saved.secret, "TINY_KEY", "the name of the secret is kept");
  assert.equal(JSON.stringify(saved).includes("tiny-key-value"), false, "the key itself never leaves the locker");

  // Forgetting it takes the tools out and stops them coming back next time.
  await second.runtime.executeTool("tools.forget_service", { name: "tiny" });
  assert.equal(second.registry.names().includes("api.tiny.get_thing"), false);
  assert.ok(!second.store.get("settings", second.runtime.owner, "openapi-service:tiny"));
  await second.close();
  const third = await createBranch({ ...where, provider });
  open.push(third);
  assert.equal(third.registry.names().includes("api.tiny.get_thing"), false, "a forgotten service stays forgotten");
});

// ---------------------------------------------------------------------------
// 10. The tool checks really call the tools, so they run somewhere of their own
//     and leave the owner's folder and the owner's memory exactly as they were.
// ---------------------------------------------------------------------------

test("the tool checks touch neither the owner's folder nor the owner's memory", async (t) => {
  const { app } = await fixture(t);
  const { runToolChecksSafely, toolCheckFolder, toolCheckOwner } = await import("../dist/tool-evaluations.js");
  const owner = app.runtime.owner;
  await app.files.write("mine.txt", "the owner's own file", AbortSignal.timeout(5000));
  const before = { files: (await app.files.list(".")).entries.map((entry) => entry.name).sort(), memory: app.store.list("memory", owner).length };
  const result = await runToolChecksSafely(app, AbortSignal.timeout(60000));
  assert.ok(result.summary.total > 0, "the checks must actually have run");
  assert.equal(result.summary.passed, result.summary.total, JSON.stringify(result.cases.filter((one) => !one.passed)));
  // Nothing landed among the owner's own files — only the checks' own folder appeared beside them —
  // and the active project is back where it was.
  const after = (await app.files.list(".")).entries.map((entry) => entry.name).sort();
  assert.deepEqual(after.filter((name) => name !== toolCheckFolder), before.files);
  assert.equal(app.store.projects.active(owner).id, "default");
  // Nothing landed in the owner's memory; the facts the checks saved are under their own name.
  assert.equal(app.store.list("memory", owner).length, before.memory, "the owner's memory must be untouched");
  assert.ok(app.store.list("memory", toolCheckOwner).length > 0, "the checks' own facts are kept apart");
  // What the checks wrote is in their own folder inside the workspace, and nowhere else.
  const { readdir } = await import("node:fs/promises");
  const written = await readdir(join(app.files.root, toolCheckFolder));
  assert.ok(written.includes("tool-check-write.txt"), `the check's file belongs in its own folder: ${written.join(", ")}`);
});

test("the tool checks put the owner's project back even when the run itself goes wrong", async (t) => {
  const { app } = await fixture(t);
  const { runToolChecksSafely, toolCheckProject } = await import("../dist/tool-evaluations.js");
  const owner = app.runtime.owner;
  // A registry that throws stands in for anything going wrong part way through the checks.
  const broken = { ...app, registry: { names() { throw new Error("the catalog is unreadable"); } } };
  await assert.rejects(() => runToolChecksSafely(broken, AbortSignal.timeout(5000),
    [{ tool: "files.write", description: "one", cases: [{ name: "one", input: {}, contains: [] }] }]),
    /unreadable/);
  assert.equal(app.store.projects.active(owner).id, "default", "the owner's project is never left switched");
  assert.ok(app.store.projects.list(owner).some((project) => project.id === toolCheckProject),
    "the checks keep a folder of their own inside the workspace");
});

// ---------------------------------------------------------------------------
// 8. The record says where an answer was actually given, and keeps what the
//    task itself came from in a column of its own.
// ---------------------------------------------------------------------------

test("an answer pressed in a chat app is filed under that chat app, task origin beside it", async (t) => {
  const { app } = await fixture(t);
  const { auditCsv, auditSources } = await import("../dist/audit.js");
  const { channelSource } = await import("../dist/runtime.js");
  for (const name of ["telegram", "discord", "slack", "whatsapp", "email", "chat"])
    assert.ok(auditSources.includes(name), `${name} belongs in the list a person can filter on`);
  // A channel the record has no word for still lands somewhere sensible rather than being lost.
  assert.equal(channelSource("signal"), "chat");
  assert.equal(channelSource("telegram"), "telegram");
  assert.equal(channelSource(undefined), null);

  const owner = app.runtime.owner;
  app.store.audit.record(owner, { action: "approval.decided", actor: owner, subject: "files.write on note.txt",
    reason: "Writing a file — answered on telegram", source: "telegram", origin: "schedule", outcome: "allowed" });
  const [entry] = app.store.audit.list(owner, { action: "approval.decided" });
  assert.equal(entry.source, "telegram", "the column says where the button was pressed");
  assert.equal(entry.origin, "schedule", "and what the task itself came from is kept");
  // Both columns can be filtered on, and the spreadsheet carries both.
  assert.equal(app.store.audit.list(owner, { source: "telegram" }).length, 1);
  assert.equal(app.store.audit.list(owner, { origin: "schedule" }).length, 1);
  assert.equal(app.store.audit.list(owner, { origin: "owner" }).some((row) => row.source === "telegram"), false);
  const csv = auditCsv(app.store.audit.list(owner));
  assert.match(csv.split("\n")[0], /where it happened,what started the task/);
  assert.match(csv, /"telegram","schedule"/);
});

test("rows written before the two columns were told apart read back as they always meant", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  app.store.audit.counts(owner);
  // A row from an older release: source only, origin never written. The two rules on the table
  // refuse any edit to it, so it is read rather than rewritten.
  app.store.sqlite.prepare(`INSERT INTO audit(owner,at,action,actor,subject,reason,source,origin,run_id,outcome)
    VALUES(?,?,?,?,?,?,?,'',NULL,?)`).run(owner, new Date().toISOString(), "policy.changed", owner, "the rules", "older row", "trigger", "saved");
  const [older] = app.store.audit.list(owner, { action: "policy.changed" });
  assert.equal(older.source, "trigger");
  assert.equal(older.origin, "trigger", "an older row's origin is what its source always meant");
  assert.equal(app.store.audit.list(owner, { origin: "trigger" }).length, 1, "and it is found by that filter");
  // The two rules still stand: the record can only grow.
  assert.throws(() => app.store.sqlite.prepare("UPDATE audit SET origin='owner' WHERE id=?").run(older.id), /cannot be changed/);
});

// ---------------------------------------------------------------------------
// 9. Every answer to an approval question is bound to the exact bytes it was
//    put for — the workflow/flow resume and `branch approve` included.
// ---------------------------------------------------------------------------

/** A workflow whose one step writes a file, which an "ask about this tool" rule stops on. */
const writingWorkflow = (app, content) => app.workflows.create("local", {
  name: "Writes one file",
  steps: [{ name: "Write it", kind: "tool", tool: "files.write", args: { path: "note.txt", content } }],
});

test("a workflow's yes is bound to the exact arguments the step asked about", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const made = writingWorkflow(app, "first");
  const held = await app.workflows.run("local", made.id);
  assert.equal(held.status, "waiting_approval");
  const asked = app.store.get("workflows", "local", made.id).data.pendingApproval;
  assert.match(String(asked.fingerprint ?? ""), /^[a-f0-9]{32}$/, "the question must carry the exact-bytes fingerprint");
  // The owner says yes, and the yes is remembered against that fingerprint and no other.
  const done = await app.workflows.resume("local", made.id);
  assert.equal(done.status, "completed", done.error ?? "");
  const key = `workflow:${made.id}`;
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, asked.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(key, "files.write", asked.target, "0".repeat(32)), undefined,
    "a yes given for one request must not cover a different one");
});

test("`branch approve` binds its answer to the request the task actually stopped on", async (t) => {
  const tool = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hello" }) };
  const { app } = await fixture(t, (request) =>
    request.messages.some((message) => message.role === "tool") ? say("written") : { content: "", toolCalls: [tool] });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] });
  const { answerFromCommand } = await import("../dist/cli-run.js");
  const run = await app.runtime.run({ prompt: "write a note" });
  assert.equal(run.status, "needs_input");
  const asked = app.store.events(run.id).filter((event) => event.kind === "policy.ask").at(-1);
  assert.match(String(asked.data.fingerprint ?? ""), /^[a-f0-9]{32}$/);
  const target = String(asked.data.target ?? "");
  answerFromCommand(app.runtime, run.id, "yes");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, asked.data.fingerprint), "allow");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "files.write", target, "0".repeat(32)), undefined,
    "the answer must not cover a request the owner never saw");
});

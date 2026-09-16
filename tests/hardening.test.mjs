/**
 * The gaps the integrators handed back, each one pinned by a test that would have caught it.
 * Fakes only: no real network, no real screen, no real outside server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../dist/server.js";
import { createBranch, inferToolGroup, NetworkPolicy, TelegramAdapter, modelsUrl, GeminiProvider } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

async function fixture(t, reply = () => say("done"), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-hardening-"));
  const provider = { name: "scripted", async complete(request) { return reply(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => {
    await app.processes.stopAll().catch(() => undefined);
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

/** A stand-in for api.telegram.org that writes down every address it was asked for. */
async function fakeTelegram(t) {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, host: `127.0.0.1:${server.address().port}`, endpoint: `http://127.0.0.1:${server.address().port}` };
}

test("11 — a flow's toolbox comes from the one table, so the 'flows.' prefix is really used", async (t) => {
  const { app } = await fixture(t);
  assert.equal(inferToolGroup("flows.list"), "schedules", "the name decides it, exactly as workflows.* does");
  assert.equal(app.registry.groupOf("flows.list"), "schedules", "and the registry agrees with the table");
  assert.equal(app.registry.groupOf("workflows.list"), "schedules", "flows sit with the workflows they draw");
});

test("7 — Telegram goes through the network settings: an allowed host works, an off-host one is refused", async (t) => {
  const service = await fakeTelegram(t);
  const policy = new NetworkPolicy();
  policy.configure({ allowedHosts: ["127.0.0.1"], allowPrivateAddresses: true });
  const guarded = policy.guard(globalThis.fetch);

  const allowed = new TelegramAdapter({ id: "telegram", token: "bot-token", apiBase: service.endpoint, fetch: guarded });
  await allowed.send("42", "hello");
  assert.equal(service.seen.length, 1, "the allowed host was actually reached");
  assert.ok(service.seen[0].endsWith("/botbot-token/sendMessage"), service.seen[0]);

  // The same adapter pointed somewhere the owner never allowed: refused before a byte leaves.
  const elsewhere = new TelegramAdapter({ id: "telegram", token: "bot-token", apiBase: "https://evil.example", fetch: guarded });
  await assert.rejects(elsewhere.send("42", "hello"), /not on the allowed list|evil\.example/i);
  assert.equal(service.seen.length, 1, "and nothing else was asked for");
});

test("8 — a Gemini sign-in token goes in the bearer header, never in the key header", async () => {
  const withKey = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash", apiKey: "AIza-key" });
  const keyed = modelsUrl(withKey);
  assert.equal(keyed.headers["x-goog-api-key"], "AIza-key");
  assert.equal(keyed.headers.authorization, undefined);

  const signedIn = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash", apiKey: "ya29-oauth", bearer: true });
  const token = modelsUrl(signedIn);
  assert.equal(token.headers.authorization, "Bearer ya29-oauth", "an OAuth token uses the ordinary header");
  assert.equal(token.headers["x-goog-api-key"], undefined, "and never the key header, which refuses it");
  assert.ok(!token.url.includes("ya29-oauth"), "and nothing goes in the address");

  // The picture route carries the same flag, so it makes the same choice.
  assert.equal(signedIn.images().bearer, true);
  assert.equal(withKey.images().bearer, false);
});

test("5 — a conversation sees only the programs it started", async (t) => {
  const { app } = await fixture(t);
  app.store.save("settings", app.runtime.owner, "background-processes",
    { programs: { node: { path: process.execPath, args: [] } }, maxRunning: 3, maxMinutes: 5,
      maxMemoryMb: 512, maxCpuSeconds: 60, bufferBytes: 4096 });
  const ticker = ["-e", "setInterval(() => console.log('tick'), 40)"];
  const task = (prompt) => {
    const run = app.store.createRun(app.runtime.owner, prompt);
    return app.runtime.context({ runId: run.id });
  };
  const mine = task("first conversation"), theirs = task("second conversation");

  const started = await app.registry.execute("process.start", { program: "node", args: ticker, name: "the ticker" }, mine);
  t.after(() => app.processes.stop(started.id).catch(() => undefined));
  await delay(200);

  const own = await app.registry.execute("process.list", {}, mine);
  assert.deepEqual(own.processes.map((entry) => entry.name), ["the ticker"], "the conversation that started it sees it");
  assert.match((await app.registry.execute("process.read", { id: started.id }, mine)).output, /tick/);

  const other = await app.registry.execute("process.list", {}, theirs);
  assert.deepEqual(other.processes, [], "another conversation sees nothing at all");
  await assert.rejects(app.registry.execute("process.read", { id: started.id }, theirs),
    /no program with that number/, "and cannot read it even knowing its number");
  await assert.rejects(app.registry.execute("process.stop", { id: started.id }, theirs),
    /no program with that number/, "nor stop it");

  // The owner still sees every program on the computer in the Activity screen.
  assert.equal(app.processes.list({ active: true }).length, 1);
});

/** The same app with an HTTP server in front of it, for the routes an owner presses buttons on. */
async function served(t, reply = () => say("done")) {
  const { app, root } = await fixture(t, reply);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close().catch(() => undefined));
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (path, body) => {
    const response = await fetch(server.url + path, body === undefined
      ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, headers, call };
}

test("4 — a connection nobody has said anything on is dropped, one with a stream open is not", async (t) => {
  const { app } = await fixture(t);
  const mcp = app.mcpServer;
  let clock = Date.parse("2026-09-16T09:00:00Z");
  mcp.now = () => clock;
  app.store.save("settings", app.runtime.owner, "mcp-serving", { idleMinutes: 30, askWaitSeconds: 120 });

  const quiet = mcp.getSession().id;
  const talking = mcp.getSession().id;
  const watching = mcp.getSession().id;
  mcp.openStream(watching, () => undefined);

  clock += 20 * 60_000;
  assert.equal(mcp.hasSession(quiet), true, "twenty minutes is not long enough");
  mcp.getSession(talking);

  clock += 20 * 60_000;
  assert.equal(mcp.hasSession(quiet), false, "forty minutes quiet and it is gone");
  assert.equal(mcp.hasSession(talking), true, "the one that spoke twenty minutes ago is kept");
  assert.equal(mcp.hasSession(watching), true, "and one with a stream open is never dropped for being quiet");

  clock += 60 * 60_000;
  assert.deepEqual(mcp.dropIdleSessions(), [talking], "the stream-holder stays, the talker has gone quiet too");
});

test("4 — how long a quiet connection is kept is a setting the owner can change", async (t) => {
  const { call } = await served(t);
  const before = await call("/api/mcp/settings");
  assert.equal(before.body.idleMinutes, 30, "half an hour unless the owner says otherwise");
  assert.equal(before.body.askWaitSeconds, 120);
  const saved = await call("/api/mcp/settings", { enabled: true, exposedTools: [], idleMinutes: 5 });
  assert.equal(saved.body.idleMinutes, 5);
  assert.equal(saved.body.askWaitSeconds, 120, "and a screen that never mentioned the other one left it alone");
  const kept = await call("/api/mcp/settings", { enabled: true, exposedTools: [] });
  assert.equal(kept.body.idleMinutes, 5, "saving without it does not reset it");
});

test("6 — a drafted skill cannot skip its trial without the owner saying so in as many words", async (t) => {
  const { app, call } = await served(t);
  const document = (body) => `---\nname: tidying\ndescription: How to do the tidying thing properly.\n---\n${body}\n`;
  const skill = app.store.skills.install(app.runtime.owner, { document: document("Put things away.") });
  const second = app.store.skills.update(app.runtime.owner, skill.id,
    { document: document("Put things away, then say so."), expectedRevision: skill.revision });
  app.store.save("settings", app.runtime.owner, `skill-candidate:${skill.id}:${second.headVersion}`,
    { fromRunId: "r1", createdAt: new Date().toISOString() });
  const body = { skillId: skill.id, version: second.headVersion };

  const untried = await call("/api/skill-revisions/accept", body);
  assert.equal(untried.status, 400);
  assert.match(untried.body.error, /Try the draft on the last few tasks first/);

  const forcedWithoutWords = await call("/api/skill-revisions/accept", { ...body, force: true });
  assert.equal(forcedWithoutWords.status, 400);
  assert.match(forcedWithoutWords.body.error, /confirm it in the app/);

  const wrongWords = await call("/api/skill-revisions/accept", { ...body, force: true, confirm: "yes" });
  assert.equal(wrongWords.status, 400, "close enough is not enough");

  const done = await call("/api/skill-revisions/accept",
    { ...body, force: true, confirm: "I have not tried this draft and I want it anyway" });
  assert.equal(done.status, 200);
  assert.equal(done.body.decision, "accepted");
  const record = app.store.audit.list(app.runtime.owner, { limit: 20 }).find((entry) => entry.action === "skill.forced");
  assert.ok(record, "and it is written down");
  assert.match(record.subject, /tidying version 2/);
  assert.match(record.reason, /without being tried/);
});

test("12 — what a profile's task learns is theirs, and the owner's facts are not there to read", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  app.store.save("memory", owner, "owner-fact", { text: "The boiler code is on the fridge", source: "owner" });

  const made = await call("/api/profiles", { name: "Sam", pin: "4321" });
  await call("/api/profiles/switch", { profileId: made.body.id, pin: "4321" });
  const scope = `profile:${made.body.id}`;
  const run = app.store.createRun(scope, "Sam's own task");
  const context = app.runtime.context({ runId: run.id });

  const searched = await app.registry.execute("memory.search", { query: "boiler" }, context);
  assert.deepEqual(searched, [], "the owner's facts are not Sam's to read");

  await app.registry.execute("memory.put", { text: "Sam's bus is the 14", source: "Sam" }, context);
  assert.equal(app.store.list("memory", scope).length, 1, "what Sam's task learned is saved under Sam");
  assert.equal(app.store.list("memory", owner).length, 1, "and the owner's memory is exactly as it was");
  assert.equal(app.store.list("memory", owner)[0].id, "owner-fact");

  await call("/api/profiles/switch", { profileId: null });
  const ownersRun = app.store.createRun(owner, "the owner's own task");
  const found = await app.registry.execute("memory.search", { query: "boiler" },
    app.runtime.context({ runId: ownersRun.id }));
  assert.equal(found.length, 1, "the owner still finds their own");
  const busless = await app.registry.execute("memory.search", { query: "bus" },
    app.runtime.context({ runId: ownersRun.id }));
  assert.deepEqual(busless, [], "and does not see what Sam's task learned");
});

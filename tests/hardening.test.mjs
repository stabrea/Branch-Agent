/**
 * The gaps the integrators handed back, each one pinned by a test that would have caught it.
 * Fakes only: no real network, no real screen, no real outside server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { startServer } from "../dist/server.js";
import { createBranch, inferToolGroup, NetworkPolicy, TelegramAdapter, modelsUrl, GeminiProvider, savePolicy, ToolLoader, readLifecycleSettings, saveLifecycleSettings } from "../dist/index.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { mcpToolName } from "../dist/integrations/mcp.js";

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

test("10 — a promise nobody caught is written down, and still ends the process as Node would", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-rejection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, "spans.db").replace(/\\/g, "/");
  const dist = new URL("../dist/tracing.js", import.meta.url).href;
  const script = join(root, "crash.mjs");
  await writeFile(script, [
    `import { DatabaseSync } from "node:sqlite";`,
    `import { SpanStore, recordUncaughtErrors } from ${JSON.stringify(dist)};`,
    `const db = new DatabaseSync(${JSON.stringify(database)});`,
    `recordUncaughtErrors(new SpanStore(db), "local", (value) => value.split("hunter2").join("[hidden]"));`,
    `Promise.reject(new Error("the passphrase hunter2 did not work"));`,
  ].join("\n"));

  const finished = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.notEqual(finished.code, 0, "the process still ends in failure, exactly as it would with nobody listening");
  assert.match(finished.stderr, /did not work/, "and still says so where it always did");

  const db = new DatabaseSync(database);
  const spans = db.prepare("SELECT name, message FROM spans").all();
  db.close();
  assert.equal(spans.length, 1, "written down once, not twice");
  assert.equal(spans[0].name, "branch.unhandled_rejection");
  assert.match(spans[0].message, /\[hidden\]/, "through the same scrubber as everything else");
  assert.ok(!spans[0].message.includes("hunter2"));
});

/** A stand-in for another AI tool: it speaks the same JSON-RPC over the same address. */
async function client(t, reply) {
  const { app, server, headers, call } = await served(t, reply);
  const rpc = async (body, sessionId) => {
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
      body: JSON.stringify(body),
    });
    return { response, data: await response.json() };
  };
  const first = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "probe", version: "1.0.0" } } });
  return { app, call, rpc, sessionId: first.response.headers.get("mcp-session-id") };
}

test("2 — a call that needs a yes waits for the owner, and goes ahead when they give one", async (t) => {
  const { app, call, rpc, sessionId } = await client(t);
  app.registry.register({
    name: "browser.click", description: "Click something on a web page", permission: "browser.interact",
    parameters: z.object({ selector: z.string() }).strict(), execute: async () => ({ clicked: true }),
  });
  await call("/api/mcp/settings", { enabled: true, exposedTools: ["browser.click"], askWaitSeconds: 30 });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "browser.click", match: "*", decision: "ask" }] });

  const asked = rpc({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "browser.click", arguments: { selector: "#go" } } }, sessionId);

  // The owner, in the app, answering the same question the app's own tasks put to them.
  let waiting;
  for (let at = 0; at < 200 && !waiting; at++) {
    waiting = app.runtime.approvals.waiting(`mcp:${sessionId}`).at(-1);
    if (!waiting) await delay(25);
  }
  assert.ok(waiting, "the question is in the app, not swallowed at the connection");
  assert.equal(waiting.source, "mcp");
  assert.match(waiting.bytes, /#go/, "with the exact bytes that were asked for");
  assert.ok(waiting.fingerprint, "and a fingerprint their yes is bound to");
  app.runtime.approve(`mcp:${sessionId}`, "allow", "session", waiting.fingerprint);

  const answered = await asked;
  assert.equal(answered.data.result.isError, false, "the call that was held open went ahead");
  assert.match(answered.data.result.content[0].text, /clicked/);
});

test("2 — nobody answers in time: the client is told to ask again, and the retry finds the yes", async (t) => {
  const { app, call, rpc, sessionId } = await client(t);
  app.registry.register({
    name: "browser.click", description: "Click something on a web page", permission: "browser.interact",
    parameters: z.object({ selector: z.string() }).strict(), execute: async () => ({ clicked: true }),
  });
  await call("/api/mcp/settings", { enabled: true, exposedTools: ["browser.click"], askWaitSeconds: 0 });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "browser.click", match: "*", decision: "ask" }] });
  const ask = { name: "browser.click", arguments: { selector: "#go" } };

  const first = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: ask }, sessionId);
  assert.equal(first.data.result.isError, true);
  assert.match(first.data.result.content[0].text, /waiting for your yes in Branch/);
  assert.match(first.data.result.content[0].text, /ask again/);

  const waiting = app.runtime.approvals.waiting(`mcp:${sessionId}`).at(-1);
  assert.ok(waiting, "the question is still waiting rather than thrown away");
  app.runtime.approve(`mcp:${sessionId}`, "allow", "session", waiting.fingerprint);

  const retried = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: ask }, sessionId);
  assert.equal(retried.data.result.isError, false, "the same request finds the answer it was given");

  // A yes is bound to the exact bytes, so a different click is a new question.
  const different = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "browser.click", arguments: { selector: "#somewhere-else" } } }, sessionId);
  assert.equal(different.data.result.isError, true);
  assert.match(different.data.result.content[0].text, /waiting for your yes in Branch/);
});

/**
 * A stand-in for a model that compares writing. It knows nothing about language: it places a
 * passage on a circle by the ideas it recognises in it, so "make a graphic" and "draw a chart"
 * land near each other while sharing no word at all — which is the whole point of the exercise.
 */
function fakeEmbedder() {
  const ideas = {
    picture: ["graphic", "chart", "draw", "plot", "visual", "diagram", "graph"],
    writing: ["write", "file", "text", "document", "save", "note"],
    talking: ["message", "send", "reply", "chat", "email"],
  };
  const calls = { texts: 0 };
  const vector = (text) => {
    const words = String(text).toLowerCase().match(/[a-z]+/g) ?? [];
    const axes = Object.values(ideas).map((list) => words.filter((word) => list.includes(word)).length);
    const length = Math.hypot(...axes) || 1;
    return axes.map((value) => value / length);
  };
  return { calls, embed: async (texts) => { calls.texts += texts.length; return texts.map(vector); } };
}

test("9 — with meaning search on, a paraphrase finds the tool that plain words miss", async (t) => {
  const { app } = await fixture(t);
  const tools = [
    { name: "data.chart", description: "Draw a graph of some numbers.", parameters: { type: "object", properties: {} } },
    { name: "files.write", description: "Save text into a file.", parameters: { type: "object", properties: {} } },
    { name: "channels.send", description: "Send a message to somebody.", parameters: { type: "object", properties: {} } },
  ];
  const embedder = fakeEmbedder();

  // With words alone, "make a graphic" shares no word with any of them.
  const plain = new ToolLoader(tools, { budgetTokens: 4000 });
  const missed = await plain.search("make a graphic", 1);
  assert.notEqual(missed.matches[0]?.name, "data.chart", "plain words do not get there");

  const meaning = new ToolLoader(tools, { budgetTokens: 4000, embedder });
  const found = await meaning.search("make a graphic", 1);
  assert.equal(found.matches[0].name, "data.chart", "meaning does");
  assert.ok(embedder.calls.texts >= 4, "the query and every description were read");
});

test("9 — meaning search is off until the owner turns it on, and says what it sends", async (t) => {
  const { app, call } = await served(t);
  const before = await call("/api/tools/meaning-search");
  assert.equal(before.body.enabled, false, "off unless the owner says otherwise");
  assert.match(before.body.explanation, /sending your request/, "and the sentence says plainly what goes out");
  assert.ok(!/embedding|vector|cosine/i.test(before.body.explanation), "in ordinary words");

  const on = await call("/api/tools/meaning-search", { enabled: true });
  assert.equal(on.body.enabled, true);
  assert.equal((await call("/api/tools/meaning-search")).body.enabled, true, "and it is remembered");
  assert.equal((await call("/api/tools/meaning-search", { enabled: false })).body.enabled, false);

  // Somebody else on this computer cannot read or change how the owner's assistant finds tools.
  const made = await call("/api/profiles", { name: "Sam", pin: "4321" });
  await call("/api/profiles/switch", { profileId: made.body.id, pin: "4321" });
  assert.match((await call("/api/tools/meaning-search")).body.error, /belongs to the owner/);
  await call("/api/profiles/switch", { profileId: null });
  void app;
});

test("9 — a tool search still works when reading by meaning fails", async (t) => {
  const { app } = await fixture(t);
  const tools = [{ name: "files.write", description: "Save text into a file.", parameters: { type: "object", properties: {} } }];
  const broken = { embed: async () => { throw new Error("the service is not there"); } };
  const loader = new ToolLoader(tools, { budgetTokens: 4000, embedder: broken });
  const found = await loader.search("save a file", 3);
  assert.equal(found.matches[0].name, "files.write", "the word search stands on its own");
  void app;
});

test("3 — a page an outside server sent is offered by name, and opens at a one-time address", async (t) => {
  const page = "<h1>Pick a seat</h1><script>fetch('https://elsewhere.example')</script>";
  const { app, server, headers, call } = await served(t, ({ messages }) => {
    const last = messages.at(-1);
    if (last?.role === "tool") return say("There is your seat picker.");
    return { content: "", toolCalls: [{ id: "c1", name: "mcp.seats.abc", arguments: "{}" }] };
  });
  // A tool from outside, whose answer carries a small page rather than words.
  app.registry.register({
    name: "mcp.seats.abc", description: "Show the seat picker", permission: "mcp.seats.abc", external: true,
    parameters: z.object({}).strict(),
    execute: async () => ({ content: [{ type: "resource", resource: { uri: "ui://seats", mimeType: "text/html", text: page } }] }),
  });
  const run = await app.runtime.run({ prompt: "let me pick a seat", permissions: ["mcp.seats.abc"] });
  assert.equal(run.status, "completed");

  const listed = await call(`/api/mcp/apps?session=${run.sessionId}`);
  assert.equal(listed.body.apps.length, 1, "the conversation has one page to offer");
  assert.equal(listed.body.apps[0].uri, "ui://seats");
  assert.equal(listed.body.apps[0].server, "seats");

  // The card hands the page straight back for an address of its own, with no key on it.
  const opened = await call("/api/mcp/app", { server: "seats", uri: "ui://seats", html: listed.body.apps[0].html });
  assert.match(opened.body.url, /^\/mcp-app\/[A-Za-z0-9_-]{32,48}$/);

  const shown = await fetch(server.url + opened.body.url, { headers: { origin: server.url } });
  assert.equal(shown.status, 200, "the address carries no key, because a frame cannot");
  const body = await shown.text();
  assert.match(shown.headers.get("content-security-policy"), /sandbox; default-src 'none'/);
  assert.ok(!body.includes("<script"), "the script is gone as well as refused");
  assert.match(body, /Pick a seat/);

  const again = await fetch(server.url + opened.body.url, { headers: { origin: server.url } });
  assert.equal(again.status, 404, "and the address is good for one fetch only");
  void headers;
});

/** The real stdio fixture server, as a connections file Branch would be started with. */
async function mcpConfigFile(root) {
  const path = join(root, "integrations.json");
  await writeFile(path, JSON.stringify({ mcp: [{ id: "fixture", transport: "stdio",
    command: process.execPath, args: [resolve("tests/fixtures/mcp-server.mjs")],
    tools: ["echo"], expectedVersion: "1.0.0" }] }));
  return path;
}

test("1 — on demand, a server's tools are in the list before anything is started", async (t) => {
  const { app, root } = await fixture(t);
  const path = await mcpConfigFile(root);
  const scope = app.store.profiles.scope();
  const name = mcpToolName("fixture", "echo");

  // Still "startup" unless the owner changes it: nothing about an existing install moves.
  assert.equal(readLifecycleSettings(app.store, scope).connect, "startup");
  const eager = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
  assert.ok(app.registry.names().includes(name), "connecting at startup works exactly as before");
  // Connecting wrote down what that server said its tools are.
  const remembered = app.store.get("settings", app.runtime.owner, "mcp-tools:fixture").data;
  assert.deepEqual(remembered.tools.map((tool) => tool.name), ["echo"]);
  await eager.close();

  // Now on demand, with that list already written down.
  saveLifecycleSettings(app.store, scope, { connect: "on-demand" });
  const lazy = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
  t.after(() => lazy.close().catch(() => undefined));
  assert.ok(app.registry.names().includes(name), "the tool is in the list");
  const listed = app.registry.descriptions(new Set([name]));
  assert.deepEqual(listed[0].parameters.required, ["text"], "with the inputs it had last time");
  assert.equal(app.mcpConnections.openCount(), 0, "and nothing has been started");

  const health = app.mcpConnections.health().find((entry) => entry.id === "fixture");
  assert.equal(health.state, "idle");
  assert.match(health.summary, /not connected yet/);

  // Calling it is what starts it.
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "say hello").id });
  const answer = await app.registry.execute(name, { text: "hello" }, { ...context, permissions: new Set([name]) });
  assert.equal(JSON.parse(answer.content[0].text).text, "hello");
  assert.equal(app.mcpConnections.openCount(), 1, "now it is connected");
  assert.equal(app.mcpConnections.health().find((entry) => entry.id === "fixture").state, "ready");
});

test("1 — on demand, a server nobody has ever connected is connected once rather than left out", async (t) => {
  const { app, root } = await fixture(t);
  const path = await mcpConfigFile(root);
  saveLifecycleSettings(app.store, app.store.profiles.scope(), { connect: "on-demand" });

  const loaded = await loadIntegrations(app.registry, path, {}, app.secretsFor, app.channelHost);
  t.after(() => loaded.close().catch(() => undefined));
  const name = mcpToolName("fixture", "echo");
  assert.ok(app.registry.names().includes(name), "its tools are there, because they had to be asked for");
  assert.deepEqual(app.store.get("settings", app.runtime.owner, "mcp-tools:fixture").data.tools.map((t2) => t2.name),
    ["echo"], "and now they are written down, so next time nothing need be started");
});

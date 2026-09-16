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

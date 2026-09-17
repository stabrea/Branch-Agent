import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, NetworkPolicy, pathRuleMatches, WebAccess, frame, readFrame, acceptKey } from "../dist/index.js";
import { ShellProcess } from "../dist/integrations/shell-process.js";
import { BranchBrowser } from "../dist/integrations/browser.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
function scripted(steps) {
  const provider = { name: "scripted", requests: [], holds: new Map(), async complete(request) {
    provider.requests.push(request);
    const user = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    for (const [needle, hold] of provider.holds) if (user.includes(needle)) await Promise.race([hold, new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))]);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
async function fixture(t, steps = [say("ok")], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-guard-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
const context = (app, extra = {}) => ({ ...app.runtime.context(), ...extra });

test("a command that eats memory or spins the processor is stopped by the sampled limits", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-limits-"));
  t.after(() => discardTemp(root));
  const base = { cwd: root, env: process.env, signal: new AbortController().signal, timeoutMs: 30000, maxOutputBytes: 4096, usageIntervalMs: 300 };
  const hog = new ShellProcess({ ...base, executable: process.execPath, args: ["-e", "const a=[]; for(;;){ a.push(Buffer.alloc(8*1024*1024, 1)); if (a.length > 60) break; } setTimeout(() => {}, 20000);"], maxMemoryMb: 64 });
  const hogResult = await hog.run();
  assert.equal(hogResult.status, "memory_limit", JSON.stringify({ status: hogResult.status, usage: hogResult.usage }));
  assert.ok(hogResult.usage.peakMemoryMb >= 64, `peak ${hogResult.usage.peakMemoryMb} MB was recorded`);
  const spinner = new ShellProcess({ ...base, executable: process.execPath, args: ["-e", "const end = Date.now() + 15000; while (Date.now() < end) {}"], maxCpuSeconds: 1 });
  const spinResult = await spinner.run();
  assert.equal(spinResult.status, "cpu_limit", JSON.stringify({ status: spinResult.status, usage: spinResult.usage }));
  assert.ok(spinResult.durationMs < 14000, "the spinner was stopped well before it finished on its own");
  const fine = await new ShellProcess({ ...base, executable: process.execPath, args: ["-e", "console.log('hi')"], maxMemoryMb: 512, maxCpuSeconds: 30 }).run();
  assert.equal(fine.status, "completed");
  assert.equal(typeof fine.usage.peakMemoryMb, "number");
});

test("one network policy with host and path rules is applied by web reading, the browser and MCP requests", async (t) => {
  const resolve = async () => ["93.184.216.34"];
  const policy = new NetworkPolicy({ allowedPaths: ["api.github.com/repos/", "*.example.org/public/"], blockedPaths: ["api.github.com/repos/secret/"] }, resolve);
  await policy.assertAllowed(new URL("https://api.github.com/repos/stabrea/Branch-Agent"));
  await policy.assertAllowed(new URL("https://docs.example.org/public/page"));
  await assert.rejects(policy.assertAllowed(new URL("https://api.github.com/user")), /not on the allowed list/);
  await assert.rejects(policy.assertAllowed(new URL("https://api.github.com/repos/secret/thing")), /on the blocked list/);
  await assert.rejects(policy.assertAllowed(new URL("https://example.org/private")), /not on the allowed list/);
  assert.equal(pathRuleMatches("api.github.com", "/repos/x", "api.github.com/repos/"), true);
  assert.equal(pathRuleMatches("evil.com", "/repos/x", "api.github.com/repos/"), false);
  // Web reading uses the same policy object.
  const web = new WebAccess({ allowPrivateAddresses: true, blockedPaths: ["127.0.0.1/blocked/"] });
  await assert.rejects(web.fetchPage("http://127.0.0.1:1/blocked/page"), /on the blocked list/);
  assert.deepEqual(web.settings().blockedPaths, ["127.0.0.1/blocked/"]);
  // The browser refuses a policy-blocked address before it ever launches.
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.org"], maxRuns: 1 });
  browser.policy = new NetworkPolicy({ blockedPaths: ["example.org/admin/"] }, resolve);
  await assert.rejects(browser.navigate("https://example.org/admin/panel", { owner: "local", runId: "r1", signal: new AbortController().signal, permissions: new Set(), depth: 0, workspace: "", budget: {} }), /on the blocked list/);
  await browser.close();
  // MCP (and anything else handing the policy a fetch) is checked on every request.
  let calls = 0;
  const guarded = policy.guard(async () => { calls++; return new Response("ok"); });
  assert.equal(await (await guarded("https://api.github.com/repos/a/b")).text(), "ok");
  await assert.rejects(guarded("https://api.github.com/user"), /not on the allowed list/);
  assert.equal(calls, 1);
});

test("lifecycle hooks run on events and switch themselves off after repeated failures; the owner can switch them back on", async (t) => {
  const { app, root } = await fixture(t);
  const script = join(root, "hook.cjs");
  await writeFile(script, "const fs = require('fs'); const p = process.argv[2]; fs.appendFileSync(p, process.argv[3] + '\\n'); process.exit(process.argv[4] === 'fail' ? 1 : 0);");
  const log = join(root, "hook.log"), config = join(root, "integrations.json");
  await writeFile(config, JSON.stringify({
    shell: { executables: { node: { path: process.execPath, args: [] } }, timeoutMs: 10000 },
    hooks: [
      { id: "flaky", event: "run.finished", executable: "node", args: [script, log, "flaky", "fail"], failureThreshold: 2 },
      { id: "steady", event: "run.finished", executable: "node", args: [script, log, "steady", "ok"] },
    ],
  }));
  const integrations = await loadIntegrations(app.registry, config, process.env, app.secretsFor, app.channelHost);
  t.after(() => integrations.close());
  assert.deepEqual(app.hooks.list().map((h) => [h.id, h.enabled]), [["flaky", true], ["steady", true]]);
  const first = await app.runtime.run({ prompt: "one" });
  await app.hooks.settle();
  const second = await app.runtime.run({ prompt: "two" });
  await app.hooks.settle();
  const flaky = app.hooks.list().find((h) => h.id === "flaky"), steady = app.hooks.list().find((h) => h.id === "steady");
  assert.equal(flaky.enabled, false, "two failures reached the threshold");
  assert.equal(flaky.failures, 2);
  assert.equal(steady.enabled, true);
  assert.equal(steady.runs, 2);
  const disabledEvent = app.store.events(second.id).find((e) => e.kind === "hook.disabled");
  assert.equal(disabledEvent.data.hook, "flaky");
  assert.ok(app.store.events(first.id).some((e) => e.kind === "hook.failed"));
  const third = await app.runtime.run({ prompt: "three" });
  await app.hooks.settle();
  assert.equal(app.hooks.list().find((h) => h.id === "flaky").runs, 2, "a disabled hook does not run");
  const re = app.hooks.enable("flaky");
  assert.deepEqual([re.enabled, re.failures], [true, 0]);
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.deepEqual(lines.filter((l) => l === "steady").length, 3);
  assert.equal(lines.filter((l) => l === "flaky").length, 2);
  void third;
});

test("a run's events stream in order over a WebSocket and a channel can send a test message", async (t) => {
  const { app, root, provider } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  assert.equal(frame("hi").toString("hex"), "81026869");
  assert.deepEqual(readFrame(Buffer.from([0x88, 0x80, 1, 2, 3, 4])), { fin: true, opcode: 8, payload: Buffer.alloc(0), consumed: 6 });
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  let release; provider.holds.set("watch", new Promise((r) => { release = r; }));
  const pending = app.runtime.run({ prompt: "watch this" });
  for (let i = 0; i < 100 && !app.store.runs("local").length; i++) await delay(10);
  const run = app.store.runs("local")[0];
  const wsUrl = server.url.replace("http", "ws") + `/api/runs/${run.id}/ws`;
  const messages = [];
  const socket = new WebSocket(wsUrl, ["bearer", server.token]);
  const closed = new Promise((resolve) => { socket.addEventListener("close", resolve); });
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  await delay(150); release();
  await pending; await closed;
  const ids = messages.filter((m) => m.id).map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(messages[0].kind, "run.started");
  assert.ok(messages.some((m) => m.kind === "run.finished"));
  assert.deepEqual(messages.at(-1), { kind: "end", status: "completed" });
  const denied = new WebSocket(wsUrl, ["bearer", "wrong"]);
  await new Promise((resolve) => { denied.addEventListener("error", resolve); denied.addEventListener("close", resolve); });
  // Channel test message goes through the delivery ledger.
  const sent = [];
  const fake = { id: "tg", kind: "telegram", botName: () => "Bot", async start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); return "m1"; } };
  await app.channels.attach(fake, { activation: "mention", pairing: true, allowlist: [] });
  const response = await fetch(server.url + "/api/channels/test", { method: "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, body: JSON.stringify({ channel: "tg", chatId: "501" }) });
  const result = await response.json();
  assert.equal(result.messageId, "m1");
  assert.match(sent[0].text, /Test message from Branch Agent/);
});

test("an HTTP page served locally is still refused by default and allowed only when private addresses are opened", async (t) => {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><body><p>local</p></body></html>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(new WebAccess({}).fetchPage(url), /private or local address/);
  assert.match((await new WebAccess({ allowPrivateAddresses: true }).fetchPage(url)).text, /local/);
});

/**
 * R17-C integration review (adversarial pass): the holes found and closed. Temporary folders and
 * fakes only — nothing is dialled, spawned or recorded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, request as sendRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { discardTemp } from "./temp-dir.mjs";
import { fakeStore, fakeWeb, on } from "./personal-kit.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePolicy } from "../dist/policy.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { requestSource } from "../dist/auth-limits.js";
import { CallSchema, HomeControl } from "../dist/personal/home-control.js";
import { mimeParts } from "../dist/personal/mime.js";
import { WebhookTunnel } from "../dist/personal/tunnel.js";
import { ChatFiles } from "../dist/personal/chat-files.js";
import { signedText } from "../dist/personal/signin.js";
import { WorkspaceFiles } from "../dist/files.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test("review: a household person, a signed-in person and a short-lived key never reach the owner's mail", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "google", mode: "on" });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const context = () => app.runtime.context({});
  await assert.rejects(asPerson({ profileId: person.id, keyId: "k" }, () => app.registry.execute("gmail.search", { query: "bank" }, context())),
    /belongs to the owner/);
  await assert.rejects(underShortLivedKey(() => app.registry.execute("gcal.events", {}, context())), /short-lived key/);
  await assert.rejects(underShortLivedKey(() => app.runtime.executeTool("gcal.events", {}, { mode: "owner" })), /short-lived key/);
});

test("review: work the owner did not start asks before it reads the owner's mail, even with no approvals", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "google", mode: "on" });
  await call("/api/personal/switch", { part: "chat-files", mode: "on" });
  for (const source of ["schedule", "trigger", "mcp", "a2a", "acp"]) {
    const context = app.runtime.context({ source });
    assert.equal(app.runtime.checkPolicy("gmail.read", { id: "abc" }, context, "fp").decision, "ask", source);
    assert.equal(app.runtime.checkPolicy("chat.send_file", { channel: "t", chatId: "1", path: "a.txt" }, context, "fp").decision, "ask", source);
  }
  assert.equal(app.runtime.checkPolicy("gmail.read", { id: "abc" }, app.runtime.context({}), "fp").decision, "allow");
  // A rule the owner wrote to allow it does not open it to other sources either.
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "gmail.*", decision: "allow" }] });
  assert.equal(app.runtime.checkPolicy("gmail.read", { id: "abc" }, app.runtime.context({ source: "mcp" }), "fp").decision, "ask");
});

test("review: locks, doors and alarms always ask, just this once, whatever the rules say", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "home-control", mode: "on" });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "home.*", decision: "allow" }] });
  const owner = app.runtime.context({});
  const unlock = { domain: "lock", service: "unlock", entity: "lock.front_door" };
  const check = app.runtime.checkPolicy("home.call", unlock, owner, "fp-lock");
  assert.equal(check.decision, "ask");
  assert.equal(check.remember, "never");
  for (const [domain, service] of [["cover", "open_cover"], ["alarm_control_panel", "alarm_disarm"]])
    assert.equal(app.runtime.checkPolicy("home.call", { domain, service, entity: `${domain}.garage` }, owner, "fp").decision, "ask", domain);
  assert.equal(app.runtime.checkPolicy("home.call", { domain: "light", service: "turn_on", entity: "light.kitchen" }, owner, "fp").decision, "allow");
  // The question is once-only: a yes for the rest of the conversation is refused.
  const run = app.store.createRun(app.runtime.owner, "open the door");
  app.runtime.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool: "home.call", target: "lock.front_door", label: "Unlock",
    question: "Unlock?", source: "owner", remember: "never", askedAt: new Date().toISOString(), fingerprint: "fp-lock" });
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "session", "fp-lock"), (error) =>
    /Locks, doors/.test(error.message) && !/safety check/.test(error.message));
  // Kept apart from the safety check's own list, so a busy house never pushes one of its warnings out.
  app.runtime.approvals.adviseAgainst("fp-risky", "looks wrong");
  for (let i = 0; i < 600; i++) app.runtime.checkPolicy("home.call", { ...unlock, service: `s${i}` }, owner, `fp-${i}`);
  app.runtime.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool: "shell.execute", target: "rm", label: "Run rm",
    question: "Run?", source: "owner", remember: "session", askedAt: new Date().toISOString(), fingerprint: "fp-risky" });
  assert.equal(app.runtime.approvals.questionFor(run.sessionId, "fp-risky").onceOnly, true);
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "session", "fp-risky"), /safety check/);
});

test("review: a service call cannot widen its target, and calls are paced", async () => {
  for (const key of ["area_id", "device_id", "entity_id", "floor_id", "label_id"])
    assert.equal(CallSchema.safeParse({ domain: "light", service: "turn_on", entity: "light.kitchen", data: { [key]: "all" } }).success, false, key);
  const store = fakeStore();
  on(store, "home-control");
  store.save("settings", "local", "personal-home-settings", { url: "https://home.example.org" });
  const web = fakeWeb([[/\/api\/services\//, []]]);
  const home = new HomeControl(store, "local", web.fetch, async () => "token");
  const light = { domain: "light", service: "toggle", entity: "light.kitchen" };
  for (let i = 0; i < 30; i++) await home.callService(light);
  await assert.rejects(home.callService(light), /too many/i);
});

test("review: a spoken yes never settles a risky request or one the safety check advised against without a press", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "voice-approvals", mode: "on" });
  const run = app.store.createRun(app.runtime.owner, "clean up");
  const ask = (tool, fingerprint) => app.runtime.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool, target: "rm -rf build",
    label: `Run ${tool}`, question: "Go?", source: "owner", remember: "session", askedAt: new Date().toISOString(), fingerprint });
  for (const [tool, fingerprint, advised] of [["shell.execute", "fp-shell", false], ["files.write", "fp-advised", true]]) {
    if (advised) app.runtime.approvals.adviseAgainst(fingerprint, "it looks wrong");
    ask(tool, fingerprint);
    const offer = await call("/api/personal/voice/offer", { sessionId: run.sessionId, fingerprint });
    const early = await call("/api/personal/voice/confirm", { id: offer.body.id });
    assert.equal(early.status, 400, "a press before any spoken yes confirms nothing");
    const yes = await call("/api/personal/voice/answer", { id: offer.body.id, transcript: "yes" });
    assert.equal(yes.body.decision, null, tool);
    assert.equal(yes.body.confirm, true, tool);
    assert.ok(app.runtime.approvals.questionFor(run.sessionId, fingerprint), "still waiting after the spoken yes");
    const pressed = await call("/api/personal/voice/confirm", { id: offer.body.id });
    assert.equal(pressed.status, 200);
    assert.equal(pressed.body.decision, "allow");
    assert.equal(app.runtime.approvals.questionFor(run.sessionId, fingerprint), undefined);
    assert.equal((await call("/api/personal/voice/confirm", { id: offer.body.id })).status, 400, "used once");
  }
});

test("review: playing the briefing goes through the tool gate", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "spoken-brief", mode: "on" });
  let spoken = 0;
  app.personal.brief["deps"].speak = async () => { spoken += 1; return { bytes: new Uint8Array([1]), mediaType: "audio/mpeg" }; };
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "brief.spoken", decision: "deny" }] });
  const refused = await call("/api/personal/brief/play", {});
  assert.equal(refused.status, 403);
  assert.equal(spoken, 0);
  savePolicy(app.store, app.runtime.owner, { rules: [] });
  const played = await call("/api/personal/brief/play", {});
  assert.equal(played.status, 200);
  assert.equal(spoken, 1);
});

test("review: tunnel traffic is counted apart from this computer's own, and cannot pose as it", () => {
  assert.equal(requestSource("127.0.0.1", {}), "127.0.0.1");
  assert.equal(requestSource("127.0.0.1", { "x-branch-tunnel": "1" }), "tunnel");
  assert.equal(requestSource("::ffff:127.0.0.1", { "x-branch-tunnel": "anything" }), "tunnel");
});

test("review: the door marks what it passes on, drops a forged mark, and passes a tidy path", async (t) => {
  const seen = [];
  const branch = createServer((request, response) => { seen.push({ url: request.url, headers: request.headers }); request.resume(); response.end("{}"); });
  await new Promise((resolve) => branch.listen(0, "127.0.0.1", resolve));
  const store = fakeStore();
  on(store, "tunnel");
  const stdout = new PassThrough();
  const child = { stdout, stderr: null, kill: () => true, once: () => undefined };
  const tunnel = new WebhookTunnel({ store, owner: "local", refusal: () => null, spawn: (_file, args) => {
    setImmediate(() => stdout.write(`ready https://abc.trycloudflare.com ${args.join(" ")}\n`));
    return child;
  } });
  tunnel.localAddress = `http://127.0.0.1:${branch.address().port}`;
  t.after(async () => { await tunnel.stop(); await new Promise((resolve) => branch.close(resolve)); });
  await tunnel.start();
  const port = tunnel["door"].address().port;
  const post = (path, headers = {}) => new Promise((resolve, reject) => {
    const out = sendRequest({ host: "127.0.0.1", port, method: "POST", path, headers }, (answer) => {
      answer.resume();
      answer.on("end", () => resolve(answer.statusCode));
    });
    out.on("error", reject);
    out.end("{}");
  });
  assert.equal(await post("/hooks/abc", { "x-branch-tunnel": "0", authorization: "Bearer stolen" }), 200);
  assert.equal(await post("/hooks\\abc?x=1"), 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers["x-branch-tunnel"], "1");
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[1].url, "/hooks/abc?x=1");
});

test("review: a hostile message cannot make the MIME reader do unbounded work", () => {
  const boundary = "b";
  const many = `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` + `--${boundary}\r\nContent-Type: text/plain\r\n\r\nx\r\n`.repeat(400_000);
  const started = Date.now();
  const parts = mimeParts(many);
  assert.ok(parts.length <= 100);
  assert.ok(Date.now() - started < 1500, "many parts are cut before they are all read");
  const headless = "X-Long: " + "a".repeat(5_000_000);
  const one = mimeParts(headless);
  assert.equal(one.length, 1);
  assert.equal(one[0].body.length, 0);
});

test("review: a packed file is never sent into a chat, since the leak guard cannot look inside it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-review-files-"));
  t.after(async () => { await discardTemp(root); });
  await mkdir(join(root, "out"), { recursive: true });
  await writeFile(join(root, "out", "report.zip"), Buffer.from("PK\u0003\u0004 packed bytes"));
  await writeFile(join(root, "out", "logs.tar.gz"), Buffer.from([0x1f, 0x8b, 8, 0]));
  const store = fakeStore();
  on(store, "chat-files");
  const sent = [];
  const chat = new ChatFiles({ store, owner: "local", files: new WorkspaceFiles(root),
    adapter: () => ({ kind: "telegram", maxFileBytes: 1024 * 1024, async sendFile(chatId, file) { sent.push(file.name); return "m"; } }),
    reachable: () => true, outboundGuard: async (text) => ({ text, blocked: false }), holdsKnownSecret: () => false, requireOwner: () => undefined });
  for (const path of ["out/report.zip", "out/logs.tar.gz"])
    await assert.rejects(chat.send({ channel: "tg", chatId: "42", path }), /packed file/, path);
  assert.deepEqual(sent, []);
});

test("review: a huge Drive file is read only up to the limit, never held whole", async () => {
  let pulled = 0;
  const body = new ReadableStream({ pull(controller) {
    pulled += 1;
    if (pulled > 50) { controller.error(new Error("read far past the limit")); return; }
    controller.enqueue(new Uint8Array(64 * 1024).fill(97));
  } });
  const text = await signedText(async () => new Response(body), { token: async () => "t" }, "Google Drive", "https://www.googleapis.com/drive/v3/files/x?alt=media", 200_000);
  assert.equal(text.length, 200_000);
  assert.ok(pulled <= 6, `pulled ${pulled} chunks`);
});

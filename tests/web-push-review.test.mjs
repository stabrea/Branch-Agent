/**
 * FQ-surfaces.mobile-push, the review's findings: whose finished task may reach the owner's devices,
 * where the two Web Push secrets are kept (a backup never carries them, and no project may take the
 * id of their locker project or of a ChatGPT account's), the address rule
 * held on every send with the settings every install starts with, what a lock screen shows, and
 * that an evaluation's own tasks are nobody's news.
 *
 * A temp data folder, the repo's scripted fake provider and local http servers standing in for push
 * services only: no real network.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createECDH, createHash, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ecKeyToStored, generateEcKeyPair, toBase64Url } from "../dist/web-push-crypto.js";
import { saveComfort } from "../dist/comfort/settings.js";
import { asPerson } from "../dist/people/context.js";
import { newAccountId, tokenProject } from "../dist/accounts/settings.js";

const provider = () => ({ name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } });

async function fakePushService(t) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(201).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/push/${randomBytes(4).toString("hex")}`, requests };
}

function generateReceiverKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();
  const privateKeyRaw = scalar.length === 32 ? scalar : Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
  return { publicKeyRaw: ecdh.getPublicKey(), privateKeyRaw, authSecret: randomBytes(16) };
}

/** RFC 8291's key schedule, run from the receiving side with the receiver's own private key. */
function opened(delivered, receiver) {
  const body = delivered.body;
  const salt = body.subarray(0, 16);
  const idLen = body.readUInt8(20);
  const senderPublicKeyRaw = body.subarray(21, 21 + idLen);
  const rest = body.subarray(21 + idLen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(receiver.privateKeyRaw);
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const prkKey = hmac(receiver.authSecret, ecdh.computeSecret(senderPublicKeyRaw));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), senderPublicKeyRaw]);
  const prk = hmac(salt, hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])])));
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(rest.subarray(rest.length - 16));
  const padded = Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.length - 1).toString("utf8"));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-push-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: provider() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, call };
}
/** The fake push services run on loopback; only reachable because the test turns this on. */
const allowLoopback = (app) => app.web.policy.configure({ allowPrivateAddresses: true });

async function subscribeReceiver(call, push, extra = {}) {
  const receiver = generateReceiverKeys();
  const answer = await call("POST", "/api/push/subscribe", {
    endpoint: push.url, keys: { p256dh: toBase64Url(receiver.publicKeyRaw), auth: toBase64Url(receiver.authSecret) }, ...extra,
  });
  assert.equal(answer.status, 200);
  return receiver;
}
async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
/** Nothing to await for a push that must not happen; a generous wait tells "never" from "not yet". */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

test("a household person's task and a lent conversation's task never reach the owner's devices", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);
  const push = await fakePushService(t);
  const receiver = await subscribeReceiver(call, push);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });

  await asPerson({ profileId: sam.id, keyId: "phone" }, () => app.runtime.run({ prompt: "Sam's private diary entry" }));
  await app.runtime.run({ prompt: "a lent conversation's words", lentTo: `profile:${sam.id}` });
  await settle();
  assert.equal(push.requests.length, 0, "somebody else's task must not buzz the owner's phone");

  const owners = await app.runtime.run({ prompt: "the owner's own task" });
  await until(() => push.requests.length === 1, 5000, "the owner's own push");
  assert.equal(opened(push.requests[0], receiver).runId, owners.id, "the owner's own task still arrives");
});

test("the VAPID private key and a device's auth secret are kept in the locker, never in a backup", async (t) => {
  const { app, call } = await fixture(t);
  const push = await fakePushService(t);
  const receiver = await subscribeReceiver(call, push);
  assert.equal((await call("GET", "/api/push/vapid-key")).status, 200);

  const answer = await call("GET", "/api/backup");
  assert.equal(answer.status, 200);
  const backup = await answer.text();
  const rows = JSON.parse(backup).tables.settings.filter((row) => row.id === "push-vapid" || row.id.startsWith("push-sub:"));
  assert.equal(rows.length, 2, "the backup does hold the key's public half and the device's row");
  for (const row of rows) assert.deepEqual(Object.keys(JSON.parse(row.data)).filter((key) => key === "d" || key === "auth"), [], `${row.id} carries no secret`);
  assert.ok(!backup.includes(toBase64Url(receiver.authSecret)), "a device's auth secret must not be in a backup");

  const { VAPID_PRIVATE_KEY: d } = await app.store.locker.resolve(app.runtime.owner, "web-push", ["VAPID_PRIVATE_KEY"]);
  assert.ok(d && !backup.includes(d), "the private key is in the locker, and only there");
});

test("the push and ChatGPT account locker projects cannot be made projects, so no route reads or removes their secrets", async (t) => {
  const { app, call } = await fixture(t);
  const owner = app.runtime.owner, projects = app.store.projects;
  const push = await fakePushService(t);
  await subscribeReceiver(call, push);
  assert.equal((await call("GET", "/api/push/vapid-key")).status, 200);
  assert.equal(app.store.locker.exists(owner, "web-push", "VAPID_PRIVATE_KEY"), true, "the push key is kept in the web-push locker project");

  for (const id of ["web-push", tokenProject("primary"), tokenProject(newAccountId())])
    assert.throws(() => projects.save(owner, { id, name: "Mine" }), /kept for Branch/, `${id} must be refused like branch-safety`);
  const made = await call("POST", "/api/projects", { id: "web-push", name: "Web push" });
  assert.ok(made.status >= 400, `POST /api/projects web-push answered ${made.status}`);
  assert.ok(!projects.list(owner).some((project) => project.id === "web-push"));

  const removed = await call("POST", "/api/secrets/web-push/VAPID_PRIVATE_KEY/remove", {});
  assert.equal(removed.status, 403, "the secrets card cannot remove Branch's push key");
  assert.equal(app.store.locker.exists(owner, "web-push", "VAPID_PRIVATE_KEY"), true, "Branch's push key is still there");
  assert.equal(projects.save(owner, { id: "web-push-app", name: "Only the exact ids are kept" }).id, "web-push-app");
});

test("secrets an older version left in settings rows move to the locker at start and still work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-web-push-migrate-"));
  let app;
  t.after(async () => { await app?.close(); await discardTemp(root); });
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: provider() };
  const push = await fakePushService(t);
  const receiver = generateReceiverKeys();
  const vapid = generateEcKeyPair();
  const legacy = ecKeyToStored(vapid.publicKeyRaw, vapid.privateKeyRaw);
  const auth = toBase64Url(receiver.authSecret);
  const first = await createBranch(options);
  const rowId = `push-sub:${createHash("sha256").update(push.url).digest("hex").slice(0, 32)}`;
  first.store.save("settings", first.runtime.owner, "push-vapid", { ...legacy });
  first.store.save("settings", first.runtime.owner, rowId,
    { endpoint: push.url, p256dh: toBase64Url(receiver.publicKeyRaw), auth, createdAt: new Date().toISOString() });
  await first.close();

  app = await createBranch(options);
  const backup = JSON.stringify(app.store.backup("test"));
  assert.ok(backup.includes(rowId), "the device's row is still there");
  assert.ok(!backup.includes(legacy.d), "the old VAPID private key left the settings row");
  assert.ok(!backup.includes(auth), "the old auth secret left the settings row");
  assert.equal(await app.webPush.vapidPublicKey(), toBase64Url(vapid.publicKeyRaw), "the same key pair is kept");

  allowLoopback(app);
  const run = await app.runtime.run({ prompt: "Say hello" });
  await until(() => push.requests.length === 1, 5000, "the push");
  assert.equal(opened(push.requests[0], receiver).runId, run.id, "the moved secrets still reach the device");
});

test("with the default network settings a push to a loopback address is never sent", async (t) => {
  const { app, call } = await fixture(t);
  // No allowPrivateAddresses here: the settings every install starts with.
  const push = await fakePushService(t);
  await subscribeReceiver(call, push);
  await app.runtime.run({ prompt: "Say hello" });
  await settle();
  assert.equal(push.requests.length, 0, "a loopback push address is refused by the default settings on every send");
});

test("the lock screen shows only \"A task finished.\" until the owner allows the task's words, in the device's language", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);
  const english = await fakePushService(t);
  const englishKeys = await subscribeReceiver(call, english);
  const french = await fakePushService(t);
  const frenchKeys = await subscribeReceiver(call, french, { language: "fr" });

  await app.runtime.run({ prompt: "Draft the letter to my landlord" });
  await until(() => english.requests.length === 1 && french.requests.length === 1, 5000, "both pushes");
  const plain = opened(english.requests[0], englishKeys);
  assert.deepEqual([plain.title, plain.body], ["Task finished", "A task finished."]);
  assert.doesNotMatch(JSON.stringify(plain), /landlord/, "nothing the owner asked is on the lock screen by default");
  const plainFr = opened(french.requests[0], frenchKeys);
  assert.deepEqual([plainFr.title, plainFr.body], ["Tâche terminée", "Une tâche est terminée."]);

  saveComfort(app.store, app.runtime.owner, "notify", { lockScreenText: true });
  await app.runtime.run({ prompt: "Draft the letter to my landlord" });
  await until(() => english.requests.length === 2, 5000, "the second push");
  assert.equal(opened(english.requests[1], englishKeys).body, "Draft the letter to my landlord");
});

test("an evaluation suite's tasks and the standard evaluation's send no push", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);
  const push = await fakePushService(t);
  await subscribeReceiver(call, push);
  const result = await app.evaluationSuites.run({ suite: "safety" });
  assert.equal(result.tasks.length, 2);
  await app.evaluation.run(app.runtime);
  await settle();
  assert.equal(push.requests.length, 0, "a measured task is nobody's news");

  await app.runtime.run({ prompt: "Say hello" });
  await until(() => push.requests.length === 1, 5000, "the owner's own push");
});

test("memory consolidation's own task sends no push (measured: true)", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);
  const push = await fakePushService(t);
  await subscribeReceiver(call, push);

  // First, run one task so consolidation has something to work with
  const owner1 = await app.runtime.run({ prompt: "Owner's first task" });
  await until(() => push.requests.length === 1, 5000, "the first push");
  assert.equal(push.requests.length, 1, "owner's task sends a push");

  // Now consolidate; it runs an internal parent task with measured: true
  const report = await app.store.review.consolidate(app.runtime, app.runtime.owner);
  assert.ok(report.runs >= 1, "consolidation found at least one task to review");
  await settle();
  assert.equal(push.requests.length, 1, "consolidation's parent task sends no push");
});

test("a task run under a short-lived key sends no push", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);
  const push = await fakePushService(t);
  await subscribeReceiver(call, push);

  // Run an owner task first to verify pushes work
  const ownerTask = await app.runtime.run({ prompt: "Owner's task" });
  await until(() => push.requests.length === 1, 5000, "the owner's push");
  assert.equal(push.requests.length, 1, "owner's task sends a push");

  // Create a run under a short-lived key by manually setting the event
  const keyTask = app.store.createRun(app.runtime.owner, "task under short-lived key");
  app.store.event(keyTask.id, "run.started", { source: "owner", shortLivedKey: true, permissions: [] });
  app.store.event(keyTask.id, "run.finished", { status: "completed", output: "Done" });
  app.runtime.notifyEvent("run.completed", {
    runId: keyTask.id, sessionId: keyTask.sessionId, status: "completed", top: true, source: "owner", shortLivedKey: true,
  });
  await settle();
  assert.equal(push.requests.length, 1, "short-lived key task sends no push");
});

test("lockdown stops pushes to all devices in flight", async (t) => {
  const { app, call } = await fixture(t);
  allowLoopback(app);

  // Create a fake push service that holds requests without replying
  const requests = [];
  const held = new Map();
  const server = createServer(async (request, response) => {
    const path = request.url;
    requests.push(path);
    held.set(path, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Subscribe 5 devices
  const endpoints = [];
  for (let i = 0; i < 5; i++) {
    const receiver = generateReceiverKeys();
    const endpoint = `${baseUrl}/push/${i}`;
    endpoints.push(endpoint);
    await call("POST", "/api/push/subscribe", {
      endpoint, keys: { p256dh: toBase64Url(receiver.publicKeyRaw), auth: toBase64Url(receiver.authSecret) },
    });
  }

  // Run an owner task; sends start to all 5 devices
  const task = await app.runtime.run({ prompt: "Test task" });
  await until(() => requests.length === 4, 5000, "4 devices to receive pushes");

  // Turn lockdown on while 4 sends are in flight
  const { setLockdown } = await import("../dist/lockdown.js");
  setLockdown(app.store, app.runtime.owner, { on: true });

  // Release the 4 held requests
  for (const [path, response] of held) {
    response.writeHead(201).end();
  }
  held.clear();

  await settle();
  assert.equal(requests.length, 4, "lockdown stops the 5th device from receiving a push");
});

test("a tapped notification with no window open opens a window at that conversation", async () => {
  const handlers = {};
  const openedAt = [];
  const self = {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    clients: { matchAll: async () => [], openWindow: async (url) => { openedAt.push(url); } },
    registration: {}, location: { origin: "https://branch.example" },
  };
  runInNewContext(await readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"), { self, URL, caches: {}, fetch });
  const tap = async (data) => {
    let settled;
    handlers.notificationclick({ notification: { data, close() {} }, waitUntil: (promise) => { settled = promise; } });
    await settled;
  };
  await tap({ runId: "r1", sessionId: "session 1" });
  await tap({ runId: "r2", sessionId: null });
  assert.deepEqual(openedAt, ["/?push-session=session%201", "/"]);
});

/**
 * FQ-surfaces.mobile-push, wired end to end: subscribe a device over the real HTTP API, finish a
 * real owner task with the repo's scripted fake provider, and check what actually left the server
 * for a fake push service — the headers RFC 8291/8292 require, and a body that decrypts (with the
 * matching private key) to a payload naming the task that finished.
 *
 * What this cannot prove is a real browser's Google/Mozilla push service accepting the message;
 * see FEATURE-QUEUE.md's note on FQ-surfaces.mobile-push for that external part.
 *
 * A temp data folder and a local http server standing in for the push service only: no real network.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createECDH, createHmac, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { toBase64Url } from "../dist/web-push-crypto.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveComfort } from "../dist/comfort/settings.js";

/** A server standing in for a browser's push service (Chrome's, Firefox's, …). */
async function fakePushService(t, status = 201) {
  const requests = [];
  let resolveNext = null;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(entry);
    response.writeHead(status).end();
    resolveNext?.(entry);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const nextRequest = () => (requests.length ? Promise.resolve(requests[requests.length - 1]) : new Promise((resolve) => { resolveNext = resolve; }));
  return { url: `http://127.0.0.1:${server.address().port}/push/abc123`, requests, nextRequest };
}

/** RFC 8291's key schedule, run from the receiving side, using only the receiver's own private key. */
function decryptWebPush(body, receiverPrivateKeyRaw, authSecret) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLen = body.readUInt8(20);
  const senderPublicKeyRaw = body.subarray(21, 21 + idLen);
  const ciphertextAndTag = body.subarray(21 + idLen);
  assert.equal(recordSize, 4096);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(receiverPrivateKeyRaw);
  const receiverPublicKeyRaw = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(senderPublicKeyRaw);

  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), receiverPublicKeyRaw, senderPublicKeyRaw]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0", "utf8"), Buffer.from([1])])).subarray(0, 12);

  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(padded[padded.length - 1], 0x02, "the padding delimiter octet RFC 8188 requires");
  return padded.subarray(0, padded.length - 1);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-push-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // The fake push service runs on a private loopback address; only reachable at all because the
  // test turns this on, exactly as tests/channels.test.mjs does for the webhook door.
  app.web.policy.configure({ allowPrivateAddresses: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, path, body) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { app, server, call };
}

test("a device subscribed over the API gets a Web Push when the owner's task finishes", async (t) => {
  const { call } = await fixture(t);
  const push = await fakePushService(t);
  const receiver = generateReceiverKeys();

  const subscribed = await call("POST", "/api/push/subscribe", {
    endpoint: push.url, keys: { p256dh: toBase64Url(receiver.publicKeyRaw), auth: toBase64Url(receiver.authSecret) },
  });
  assert.equal(subscribed.status, 200);

  const run = await call("POST", "/api/run", { prompt: "Say hello" });
  assert.equal(run.status, 200);
  const { id: runId } = await run.json();

  const delivered = await push.nextRequest();
  assert.equal(delivered.headers["content-encoding"], "aes128gcm");
  assert.equal(delivered.headers["content-type"], "application/octet-stream");
  assert.ok(delivered.headers.ttl, "a TTL header must be sent (RFC 8030)");
  assert.match(delivered.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

  const payload = JSON.parse(decryptWebPush(delivered.body, receiver.privateKeyRaw, receiver.authSecret).toString("utf8"));
  assert.equal(payload.runId, runId, "the push names the task that just finished");
  assert.equal(payload.title, "Task finished");
});

test("a run started on the owner's schedule (heartbeat-shaped: source \"schedule\") never pushes", async (t) => {
  const { app, call } = await fixture(t);
  const push = await fakePushService(t);
  const receiver = generateReceiverKeys();
  await call("POST", "/api/push/subscribe", {
    endpoint: push.url, keys: { p256dh: toBase64Url(receiver.publicKeyRaw), auth: toBase64Url(receiver.authSecret) },
  });

  await app.runtime.run({ prompt: "a background check-in", source: "schedule" });
  // Nothing to await for a push that must not happen; a short, generous wait is the only way to
  // tell "never arrives" from "hasn't arrived yet", and a fire-and-forget send is well inside it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(push.requests.length, 0, "a scheduled/internal run must never buzz the owner's phone");
});

/** Subscribes one fake push service's address with fresh receiver keys. */
async function subscribeTo(call, push) {
  const receiver = generateReceiverKeys();
  const answer = await call("POST", "/api/push/subscribe", {
    endpoint: push.url, keys: { p256dh: toBase64Url(receiver.publicKeyRaw), auth: toBase64Url(receiver.authSecret) },
  });
  assert.equal(answer.status, 200);
}
const pushRows = (app) => app.store.list("settings", app.runtime.owner).filter((row) => row.id.startsWith("push-sub:"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("while Lockdown is on, a finished task sends no push; once it is off, it does again", async (t) => {
  const { app, call } = await fixture(t);
  const push = await fakePushService(t);
  await subscribeTo(call, push);

  setLockdown(app.store, app.runtime.owner, { on: true });
  await app.runtime.run({ prompt: "Say hello" });
  await settle();
  assert.equal(push.requests.length, 0, "Lockdown holds a push back exactly as it holds a webhook");

  setLockdown(app.store, app.runtime.owner, { on: false });
  await app.runtime.run({ prompt: "Say hello again" });
  await push.nextRequest();
  assert.equal(push.requests.length, 1, "the same device is reached once Lockdown is off");
});

test("\"This window only\" notifications skip the push; the default sends it", async (t) => {
  const { app, call } = await fixture(t);
  const push = await fakePushService(t);
  await subscribeTo(call, push);

  saveComfort(app.store, app.runtime.owner, "notify", { method: "window" });
  await app.runtime.run({ prompt: "Say hello" });
  await settle();
  assert.equal(push.requests.length, 0, "no notification leaves this computer in window-only mode");

  saveComfort(app.store, app.runtime.owner, "notify", { method: "system" });
  await app.runtime.run({ prompt: "Say hello again" });
  await push.nextRequest();
  assert.equal(push.requests.length, 1);
});

test("a subscription the push service says is gone (404/410) is dropped; the others are kept", async (t) => {
  const { app, call } = await fixture(t);
  const gone = await fakePushService(t, 410);
  const missing = await fakePushService(t, 404);
  const live = await fakePushService(t, 201);
  for (const push of [gone, missing, live]) await subscribeTo(call, push);
  assert.equal(pushRows(app).length, 3);

  await app.runtime.run({ prompt: "Say hello" });
  await Promise.all([gone.nextRequest(), missing.nextRequest(), live.nextRequest()]);
  const deadline = Date.now() + 3000;
  while (pushRows(app).length !== 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(pushRows(app).map((row) => row.data.endpoint), [live.url]);
});

function generateReceiverKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKeyRaw = ecdh.getPublicKey();
  const scalar = ecdh.getPrivateKey();
  const privateKeyRaw = scalar.length === 32 ? scalar : Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
  return { publicKeyRaw, privateKeyRaw, authSecret: randomBytes(16) };
}

/**
 * FQ-surfaces.mobile-push, the sending side held to the rules every other outbound request is:
 * a push service that answers with a redirect is not followed to wherever it points, one device
 * that never answers does not hold up the others, and a subscription's auth secret never shows up
 * in a problem report's settings summary.
 *
 * A temp data folder, local http servers and a fake fetch only: no real network.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { WebPushService } from "../dist/web-push.js";
import { settingsSummary } from "../dist/diagnostic-api.js";
import { toBase64Url } from "../dist/web-push-crypto.js";

async function appFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-web-push-delivery-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

function receiverKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
}

/** The payload runtime.ts's finish() hands every notifier for an owner's own finished task. */
const finished = { runId: "", sessionId: "", status: "completed", top: true, isolated: false, source: "owner" };

async function localServer(t, handler) {
  const hits = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    hits.push(request.url);
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { port: server.address().port, hits };
}

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a push service answering 307 is never followed to an address the network settings refuse", async (t) => {
  const app = await appFixture(t);
  const internal = await localServer(t, (_request, response) => response.writeHead(201).end());
  const target = `http://127.0.0.1:${internal.port}/internal`;
  const pushService = await localServer(t, (_request, response) => response.writeHead(307, { location: target }).end());
  // Private addresses are allowed (the fake push service is on loopback), but /internal is not.
  const policy = new NetworkPolicy({ allowPrivateAddresses: true, blockedPaths: ["127.0.0.1/internal"] });
  await assert.rejects(policy.assertAllowed(new URL(target)), /blocked list/, "the redirect target is one the policy refuses");

  const webPush = new WebPushService(app.store, app.runtime.owner, policy);
  webPush.subscribe({ endpoint: `http://127.0.0.1:${pushService.port}/push/abc`, keys: receiverKeys() });
  webPush.notify("run.completed", finished);

  await until(() => pushService.hits.length === 1, 5000, "the push service to be asked");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(pushService.hits.length, 1);
  assert.deepEqual(internal.hits, [], "the redirect target must never be reached");
});

test("one device that never answers neither holds up the others nor hangs forever", { timeout: 10000 }, async (t) => {
  const app = await appFixture(t);
  // The default settings, with a name lookup that answers a public address: no DNS, no network.
  const policy = new NetworkPolicy({}, async () => ["93.184.216.34"]);
  const calls = [];
  const fetchImpl = (url, init) => {
    const call = { url, signal: init.signal, pendingWhenNext: null };
    calls.forEach((earlier) => { earlier.pendingWhenNext ??= earlier.signal ? !earlier.signal.aborted : true; });
    calls.push(call);
    if (calls.length > 1) return Promise.resolve({ status: 201, ok: true });
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
    });
  };
  const webPush = new WebPushService(app.store, app.runtime.owner, policy, fetchImpl);
  webPush.sendTimeoutMs = 400;
  webPush.subscribe({ endpoint: "https://push-one.example/a", keys: receiverKeys() });
  webPush.subscribe({ endpoint: "https://push-two.example/b", keys: receiverKeys() });
  webPush.notify("run.completed", finished);

  await until(() => calls.length === 2, 2000, "the second device to be sent to");
  assert.equal(calls[0].pendingWhenNext, true, "the second device is sent to while the first is still waiting");
  assert.ok(calls[0].signal, "every push request carries a timeout");
  await until(() => calls[0].signal.aborted, 2000, "the hanging request to be given up on");
});

test("a subscription's auth secret is not in the problem report's settings summary", async (t) => {
  const app = await appFixture(t);
  const webPush = new WebPushService(app.store, app.runtime.owner, new NetworkPolicy({}));
  const keys = receiverKeys();
  assert.match(keys.auth, /^[\w.-]{22}$/, "a real auth secret is short enough to pass as a one-word value");
  webPush.subscribe({ endpoint: "https://push.example/sub", keys });

  const summary = settingsSummary(app);
  const row = Object.entries(summary).find(([id]) => id.startsWith("push-sub:"));
  assert.ok(row, "the subscription row is listed");
  assert.ok(!JSON.stringify(summary).includes(keys.auth), "the auth secret must be redacted");
});

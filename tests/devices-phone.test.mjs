/**
 * mac7/nodes: the phone app's device module (apps/mobile/web/phone-node.js) against a real Branch
 * server, with WebCrypto and a WebSocket as Node has them and every phone ability faked: pairing,
 * the owner's yes, a location and a photo, and a capability the owner never switched on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { connectPhone, pairPhone, phoneKey, PHONE_OFFERS } from "../apps/mobile/web/phone-node.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await wait(25); }
  assert.fail(`timed out waiting for ${what}`);
}

test("a phone pairs, is switched on for its location and camera only, and answers through the tool gate", { skip: typeof WebSocket !== "function" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-devices-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  let stopPhone = () => undefined;
  t.after(async () => { stopPhone(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const kept = new Map();
  const opened = [];
  const env = {
    crypto: globalThis.crypto, fetch, platform: "ios", WebSocket, now: Date.now,
    store: { get: async (key) => kept.get(key) ?? null, set: async (key, value) => void kept.set(key, value) },
    say: (_key, english) => english, wait: (ms) => wait(Math.min(ms, 25)), later: (work) => setTimeout(work, 20), tries: 400,
    geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 12 } }) },
    media: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    frame: async () => jpeg, record: async () => Buffer.alloc(0),
    open: (url) => opened.push(url), speak: () => undefined, showPage: () => undefined,
  };
  await call("devices/mode", { mode: "on" });
  const invite = await call("devices/invite", {});
  await assert.rejects(pairPhone(env, "http://example.test/devices/pair?offer=nope", invite.code, "Phone"), /not a pairing link/);
  const pairing = pairPhone(env, invite.link, invite.code, "Sam's phone");
  let request;
  await until(async () => (request = (await call("devices")).requests[0]), "the phone's request");
  await call(`devices/requests/${request.id}`, { approve: true });
  const deviceId = await pairing;
  const [device] = (await call("devices")).devices;
  assert.equal(device.id, deviceId);
  assert.equal(device.platform, "ios");
  assert.deepEqual(device.offers, PHONE_OFFERS.filter((c) => device.canOffer.includes(c)));
  assert.equal((await phoneKey(env)).privateKey.extractable, false, "the phone's own key can never be read out");

  const states = [];
  stopPhone = connectPhone(env, await env.store.get("device"), await phoneKey(env), (state) => states.push(state));
  await until(() => app.devices.hub.connected(deviceId), "the phone to connect");
  await call(`devices/${deviceId}/switch`, { capability: "location", on: true });
  await call(`devices/${deviceId}/switch`, { capability: "camera", on: true });
  await until(() => states.at(-1)?.enabled.length === 2, "the switches to reach the phone");

  const where = await app.runtime.executeTool("device.location", {}, { mode: "owner" });
  assert.deepEqual(where.result, { latitude: 51.5, longitude: -0.12, accuracyMeters: 12 });
  assert.equal(where.trust, "untrusted");
  const photo = await app.runtime.executeTool("device.camera", { facing: "front" }, { mode: "owner" });
  assert.deepEqual(await readFile(join(app.runtime.workspace, photo.file.path)), jpeg);
  await assert.rejects(app.runtime.executeTool("device.open", { url: "https://example.test/" }, { mode: "owner" }), /switched off/);
  assert.deepEqual(opened, [], "nothing was opened on the phone");

  await call(`devices/${deviceId}/revoke`, {});
  await until(async () => (await env.store.get("device")) === null, "the phone to forget its pairing");
});

/**
 * mac7/nodes integration review (adversarial pass): the holes found in Devices, each pinned by a
 * test that failed before its fix. Nothing here captures, shows or runs anything real: runners are
 * fakes and sockets are loopback only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { maskedFrame } from "../dist/channels/ws-client.js";
import { acceptKey, readFrame, serveRunSocket } from "../dist/ws.js";
import { helloText } from "../dist/devices/protocol.js";
import { offeredOn } from "../dist/devices/capabilities.js";
import { DeviceHub } from "../dist/devices/hub.js";
import { childEnvironment, NodeActions } from "../dist/devices/node/actions.js";
import { checkHubAddress, parsePairLink } from "../dist/devices/node/client.js";
import { chatPermissionsOf } from "../dist/channels/router.js";
import { saveSenderAllowlist } from "../dist/channels/allowlist.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function makeApp(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-devices-adv-")));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
function deviceKey() {
  const pair = generateKeyPairSync("ed25519");
  return { publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text) => sign(null, Buffer.from(text), pair.privateKey).toString("base64") };
}
function pairOne(book, name = "Kitchen Mac") {
  const key = deviceKey();
  const offer = book.invite();
  const { requestId } = book.redeem({ offer: offer.id, code: offer.code, name, platform: "darwin", publicKey: key.publicKey, offers: offeredOn("darwin") });
  return { key, device: book.device(book.decide(requestId, true).deviceId) };
}
const fakeRequest = (device, from = "127.0.0.1") => ({ headers: { "x-branch-node": device }, url: "/api/devices/socket", socket: { remoteAddress: from } });

test("device.run hands the walled program only the clean environment, never the node's own", { skip: process.platform === "win32" && "the macOS wall is planned around this computer's own folders, which are not POSIX paths here" }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-node-env-")));
  t.after(() => discardTemp(root));
  const folder = join(root, "work");
  await mkdir(folder);
  const seen = [];
  const actions = new NodeActions({ os: "darwin", identityDir: join(root, "id"), home: join(root, "home"),
    env: { PATH: "/usr/bin", NODE_SECRET: "leak-me" }, wall: { exists: async () => true },
    runner: async (command) => { seen.push(command); return { code: 0, stdout: Buffer.from("ok"), stderr: "" }; } });
  await actions.perform("run", { executable: "ls" }, folder);
  assert.equal(seen[0].exactEnv, true, "the run asks for exactly its own environment");
  assert.equal(seen[0].env.NODE_SECRET, undefined);
  process.env.BRANCH_ADV_SECRET = "from-the-node";
  t.after(() => { delete process.env.BRANCH_ADV_SECRET; });
  assert.equal(childEnvironment(seen[0]).BRANCH_ADV_SECRET, undefined, "nothing of the node's process environment is added");
  assert.equal(childEnvironment(seen[0]).HOME, folder);
  const plain = childEnvironment({ executable: "pbpaste", args: [], env: { EXTRA: "1" } });
  assert.equal(plain.BRANCH_ADV_SECRET, "from-the-node", "other capabilities keep the session's display variables");
  assert.equal(plain.EXTRA, "1");
});

test("the node refuses a folder that would expose its key, secrets, the home folder or the whole disk", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-node-guard-")));
  t.after(() => discardTemp(root));
  const home = join(root, "home"), identityDir = join(home, ".branch-node"), project = join(home, "projects");
  for (const dir of [identityDir, join(home, ".ssh"), project]) await mkdir(dir, { recursive: true });
  await writeFile(join(identityDir, "identity.json"), "{\"privateKey\":\"secret\"}");
  await writeFile(join(home, ".ssh", "id_ed25519"), "secret");
  await writeFile(join(project, "notes.txt"), "hello");
  const performed = [];
  const actions = new NodeActions({ os: "darwin", identityDir, home, env: { PATH: "/usr/bin" }, wall: { exists: async () => true },
    runner: async (command) => { performed.push(command); return { code: 0, stdout: Buffer.alloc(0), stderr: "" }; } });
  const read = (folder, path) => actions.perform("files", { action: "read", path }, folder);
  await assert.rejects(read(home, ".branch-node/identity.json"), /cannot be used/, "the home folder itself is refused");
  await assert.rejects(read(identityDir, "identity.json"), /cannot be used/, "the node's own key folder is refused");
  await assert.rejects(read(join(home, ".ssh"), "id_ed25519"), /cannot be used/, "a secret place is refused");
  await assert.rejects(read(root, "home/.ssh/id_ed25519"), /cannot be used/, "a folder above the home folder is refused");
  await assert.rejects(read("/", "etc/hosts"), /cannot be used/, "the whole disk is refused");
  await assert.rejects(actions.perform("run", { executable: "ls" }, home), /cannot be used/, "run is held to the same folder rule");
  assert.equal(performed.length, 0, "nothing ran");
  const fine = await read(project, "notes.txt");
  assert.equal(fine.media.data.toString(), "hello", "an ordinary project folder still works");
});

test("a node dials plain http only to this computer or a Tailscale address", () => {
  const offer = "a".repeat(32);
  assert.throws(() => parsePairLink(`http://192.168.1.20:3210/devices/pair?offer=${offer}`), /https/);
  assert.throws(() => parsePairLink(`http://branch.example.com/devices/pair?offer=${offer}`), /https/);
  for (const hub of ["http://127.0.0.1:3210", "http://localhost:3210", "http://[::1]:3210", "http://100.101.102.103:3210",
    "http://kitchen.tail1234.ts.net:3211", "https://branch.example.com"]) {
    assert.equal(parsePairLink(`${hub}/devices/pair?offer=${offer}`).hub, new URL(hub).origin);
    assert.doesNotThrow(() => checkHubAddress(hub));
  }
  assert.throws(() => checkHubAddress("http://10.0.0.2:3210"), /https/);
});

test("a chat sender's task never gets the device permissions", () => {
  const all = ["files.read", "devices.read", "devices.capture", "devices.act", "devices.run", "shell.execute", "channels.send"];
  assert.deepEqual(chatPermissionsOf(all), ["files.read"]);
});

test("noise from one forwarded address does not lock a real device out; bad proofs are held per device", async (t) => {
  const { app } = await makeApp(t);
  app.devices.setMode({ mode: "on" });
  const { device: kitchen } = pairOne(app.devices.book, "Kitchen Mac");
  const { device: office } = pairOne(app.devices.book, "Office Mac");
  const hub = new DeviceHub(app.devices.book);
  t.after(() => hub.close());
  for (let i = 0; i < 12; i++) hub.refusal(fakeRequest(randomBytes(8).toString("hex")), "127.0.0.1", true, true);
  assert.equal(hub.refusal(fakeRequest("0123456789abcdef"), "127.0.0.1", true, true), "Too many tries from this address");
  assert.equal(hub.refusal(fakeRequest(kitchen.id), "127.0.0.1", true, true), null, "a paired device behind the same gateway still gets a challenge");
  for (let i = 0; i < 10; i++) hub.noteBadProof(kitchen.id, "127.0.0.1");
  assert.match(hub.refusal(fakeRequest(kitchen.id), "127.0.0.1", true, true) ?? "", /Too many/, "wrong proofs for one device are held");
  assert.equal(hub.refusal(fakeRequest(office.id), "127.0.0.1", true, true), null, "another device is unaffected");
});

test("pairing tries are also counted per address, beside the overall count", async (t) => {
  const { app } = await makeApp(t);
  app.devices.setMode({ mode: "on" });
  const offer = app.devices.book.invite();
  const key = deviceKey();
  const body = { offer: "b".repeat(32), code: "000000", platform: "linux", publicKey: key.publicKey };
  for (let i = 0; i < 10; i++) assert.throws(() => app.devices.book.redeem(body, "100.64.0.9"), /Check the number on the computer/);
  assert.throws(() => app.devices.book.redeem(body, "100.64.0.9"), /Too many pairing tries/);
  const done = app.devices.book.redeem({ ...body, offer: offer.id, code: offer.code }, "100.64.0.10");
  assert.equal(done.status, "waiting", "another address can still answer the invitation");
});

/** A raw upgrade: the status line, or the open socket. */
function rawUpgrade(url, headers, path = "/api/devices/socket") {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const target = new URL(url);
    const outgoing = httpRequest({ hostname: target.hostname, port: target.port, path, method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-version": "13", ...headers } });
    outgoing.on("error", reject);
    outgoing.on("response", (response) => resolve({ status: response.statusCode }));
    outgoing.on("upgrade", (response, socket, head) => {
      assert.equal(response.headers["sec-websocket-accept"], acceptKey(key));
      const frames = [];
      let pending = Buffer.from(head);
      const drain = () => { for (let f = readFrame(pending); f; f = readFrame(pending)) { pending = pending.subarray(f.consumed); if (f.opcode === 1) frames.push(JSON.parse(f.payload.toString())); } };
      socket.on("data", (chunk) => { pending = Buffer.concat([pending, chunk]); drain(); });
      socket.on("error", () => undefined);
      drain();
      const closed = new Promise((done) => socket.on("close", done));
      resolve({ status: 101, socket, frames, closed });
    });
    outgoing.end();
  });
}

async function serverWithDevice(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-devices-adv-srv-")));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  app.devices.setMode({ mode: "on" });
  const paired = pairOne(app.devices.book);
  return { app, server, ...paired };
}

test("before its hello a device may only park a small message, not eight megabytes", async (t) => {
  const { server, device } = await serverWithDevice(t);
  const open = await rawUpgrade(server.url, { "x-branch-node": device.id });
  assert.equal(open.status, 101);
  // A text frame that claims one megabyte, sent in part: the hub must not wait for the rest.
  const head = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0, 1, 2, 3, 4]);
  open.socket.write(Buffer.concat([head, Buffer.alloc(100 * 1024)]));
  const ended = await Promise.race([open.closed.then(() => true), wait(3000).then(() => false)]);
  assert.equal(ended, true, "the unproven socket was closed");
});

test("the paired door serves only the device socket, and honours a never rule for a device", async (t) => {
  const { app, server, device, key } = await serverWithDevice(t);
  const door = createServer();
  door.on("upgrade", (request, socket) => server.remote.upgrade(request, socket));
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => door.close(done)));
  const doorUrl = `http://127.0.0.1:${door.address().port}`;
  const host = new URL(server.url).host;
  // Even with a phone let in (so the door's chain would pass), a task's socket is not on the door.
  const run = app.store.createRun(app.runtime.owner, "socket");
  const task = await rawUpgrade(doorUrl, { host, "sec-websocket-protocol": `bearer, ${server.token}` }, `/api/runs/${run.id}/ws`);
  assert.equal(task.status, 401, "a task's socket is never served on the paired door");
  const open = await rawUpgrade(doorUrl, { host, "x-branch-node": device.id });
  assert.equal(open.status, 101);
  await (async () => { const end = Date.now() + 3000; while (!open.frames.length && Date.now() < end) await wait(20); })();
  open.socket.write(maskedFrame(Buffer.from(JSON.stringify({ type: "hello", version: 1, deviceId: device.id, platform: "darwin",
    offers: [], signature: key.sign(helloText(device.id, open.frames[0].nonce)) })), 1));
  await (async () => { const end = Date.now() + 3000; while (!app.devices.hub.connected(device.id) && Date.now() < end) await wait(20); })();
  assert.equal(app.devices.hub.connected(device.id), true, "a proven device connects through the door");
  open.socket.destroy();
  saveSenderAllowlist(app.store, app.runtime.owner, { rules: [{ channel: "remote", sender: device.id, decision: "block" }] });
  assert.equal((await rawUpgrade(doorUrl, { host, "x-branch-node": device.id })).status, 401, "never this device on the door");
  const local = await rawUpgrade(server.url, { "x-branch-node": device.id });
  assert.equal(local.status, 101, "the rule is about the door; this computer's own address is unchanged");
  local.socket.destroy();
});

/** A socket that never answers and never closes: the peer has gone quiet. */
class SilentPeer extends Duplex {
  constructor() { super(); this.written = []; }
  _read() {}
  _write(chunk, _encoding, done) { this.written.push(chunk); done(); }
}

test("a run socket whose peer goes silent without closing is let go", async () => {
  const store = { events: () => [], run: () => ({ status: "running" }) };
  const peer = new SilentPeer();
  const request = { headers: { "sec-websocket-key": "abc" } };
  const served = serveRunSocket(store, "run", request, peer, { pollMs: 5, liveOpen: () => true, pingMs: 20, idleMs: 80 });
  const finished = await Promise.race([served.then(() => true), wait(2000).then(() => false)]);
  assert.equal(finished, true, "the socket loop ended instead of hanging");
  assert.ok(peer.written.some((chunk) => chunk[0] === 0x89), "it asked the peer with a ping first");
  peer.destroy();
});

test("a run socket peer that answers pings stays open, and a half-closed peer is let go", async () => {
  const store = { events: () => [], run: () => ({ status: "running" }) };
  const peer = new SilentPeer();
  let live = true;
  const served = serveRunSocket(store, "run", { headers: { "sec-websocket-key": "abc" } }, peer,
    { pollMs: 5, liveOpen: () => live, pingMs: 20, idleMs: 80, maxMs: 0 });
  const pong = setInterval(() => peer.push(maskedFrame(Buffer.alloc(0), 0xa)), 15);
  await wait(250);
  const early = await Promise.race([served.then(() => true), wait(1).then(() => false)]);
  assert.equal(early, false, "an answering peer is kept");
  clearInterval(pong);
  peer.push(null);
  const finished = await Promise.race([served.then(() => true), wait(2000).then(() => false)]);
  assert.equal(finished, true, "a peer that hung up its half ends the loop");
  live = false;
  peer.destroy();
});

test("a yes to the camera, the screen, the microphone or a command is offered for that one call", async (t) => {
  const { evaluatePolicy, PolicySchema } = await import("../dist/policy.js");
  const none = PolicySchema.parse({});
  const remembered = (tool) => evaluatePolicy(none, { tool, target: "Kitchen Mac: x", readOnly: false }).rule?.remember;
  for (const tool of ["device.camera", "device.screen", "device.listen", "device.run"]) assert.equal(remembered(tool), "never", tool);
  for (const tool of ["device.location", "device.files", "device.clipboard"]) assert.equal(remembered(tool), "session", tool);
  // Through a real task: the question offers "just this once", and taking it asks again next time.
  let turn = 0;
  const camera = { name: "camera-each-time", async complete(request) {
    turn += 1;
    return request.messages.at(-1)?.role === "tool" ? { content: "Done.", toolCalls: [] }
      : { content: "", toolCalls: [{ id: `c${turn}`, name: "device.camera", arguments: JSON.stringify({ device: "Kitchen Mac" }) }] };
  } };
  const root = await realpath(await mkdtemp(join(tmpdir(), "branch-devices-ask-")));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: camera });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.devices.setMode({ mode: "on" });
  pairOne(app.devices.book);
  const sent = [];
  app.devices.hub.invoke = async (...args) => { sent.push(args); return { value: { captured: "camera" } }; };
  const first = await app.runtime.run({ prompt: "take a photo" });
  assert.equal(first.status, "needs_input");
  const asked = app.store.events(first.id).filter((e) => e.kind === "policy.ask");
  assert.equal(asked.at(-1).data.remember, "never", "the question offers this one call");
  app.runtime.approve(first.sessionId, "allow", asked.at(-1).data.remember);
  const second = await app.runtime.run({ prompt: "and another", sessionId: first.sessionId });
  assert.equal(second.status, "needs_input", "the next photo asks again");
  assert.equal(sent.length, 0, "nothing reached the device");
  // Only if the owner picks "for this conversation" does the next one go ahead.
  app.runtime.approve(first.sessionId, "allow", "session");
  const third = await app.runtime.run({ prompt: "one more", sessionId: first.sessionId });
  assert.equal(third.status, "completed");
  assert.equal(sent.length, 1);
});

test("the phone checks a page's address itself, whatever Branch sent", async () => {
  const { perform } = await import("../apps/mobile/web/phone-node.js");
  const shown = [];
  const env = { showPage: (page) => shown.push(page) };
  for (const args of [{ url: "javascript:alert(1)" }, { url: "file:///etc/hosts" }, {}, { html: "<p>x</p>", url: "https://a.example" }])
    await assert.rejects(perform(env, "canvas", args), /page|address/, JSON.stringify(args));
  assert.equal(shown.length, 0, "nothing was shown");
  await perform(env, "canvas", { url: "https://a.example" });
  await perform(env, "canvas", { html: "<p>hi</p>" });
  assert.equal(shown.length, 2);
});

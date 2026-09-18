/**
 * mac7/channel-leaks: two things an unauthenticated caller could work out before Branch ever looked
 * at its key, and the neighbouring addresses that also answer before the key.
 *
 *   1. `/webhooks/chat/<name>` answered differently for a chat service the owner has connected than
 *      for one they have not, so anyone who could reach the door could read off which services the
 *      owner uses.
 *   2. The pairing answer said whether a window was open at all and how many tries were left, which
 *      turns a twenty-bit number into something worth guessing.
 *
 * Fakes and temporary folders only: no real network, no window, no sound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, WebhookChatAdapter, channelEntry } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SECRET = "SHARED-SECRET-VALUE-0123";
const TOKEN = "SERVICE-ACCESS-TOKEN-4567";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-channel-leaks-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/** A server standing in for the chat service, so nothing here reaches the real internet. */
async function chatService(t) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, id: "sent-1" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
/** Everything a caller can see of one answer: what came back, not how it was reached. */
async function seen(answer) {
  return { status: answer.status, body: await answer.text() };
}
async function served(t) {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 50 } });
  t.after(() => server.close());
  return { app, root, server };
}

// ---------------------------------------------------------------------------
// 1. A connected chat service and one that was never connected answer the same.
// ---------------------------------------------------------------------------

test("a connected and an unconnected chat name answer an unauthenticated caller identically", async (t) => {
  const { app, root } = await fixture(t);
  const base = await chatService(t);
  // "line" is really connected in this launch; "slack" never is.
  const adapter = new WebhookChatAdapter({
    id: "line", entry: channelEntry("line"), webhookUrl: `${base}/line`, token: TOKEN, secret: SECRET,
  });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["user-9"] });
  // The wait after repeated wrong words has its own test below; here there must be room to compare.
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 50 } });
  t.after(() => server.close());

  const post = (path, headers = {}) => fetch(`${server.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ events: [{ type: "message", message: { type: "text", text: "hello" }, source: { userId: "user-9" } }] }),
  });

  // The old shape of address, which carries no word at all: the very case `acceptOldAddresses` is
  // about. Connected or not, the caller is told exactly the same thing.
  const connectedOld = await seen(await post("/webhooks/chat/line", { "x-line-signature": "AAAA" }));
  const unknownOld = await seen(await post("/webhooks/chat/slack", { "x-line-signature": "AAAA" }));
  assert.deepEqual(connectedOld, unknownOld, "the old shape must not say which services are connected");

  // A guessed word on the end says no more.
  const wrong = "0".repeat(32);
  const connectedWrong = await seen(await post(`/webhooks/chat/line/${wrong}`));
  const unknownWrong = await seen(await post(`/webhooks/chat/slack/${wrong}`));
  assert.deepEqual(connectedWrong, unknownWrong, "a guessed word must not say which services are connected");
  assert.deepEqual(connectedWrong, connectedOld, "and the two ways of getting it wrong agree");

  // Nor does the method used: a GET, which some services use to check an address, says no more.
  const getConnected = await seen(await fetch(`${server.url}/webhooks/chat/line/${wrong}`));
  const getUnknown = await seen(await fetch(`${server.url}/webhooks/chat/slack/${wrong}`));
  assert.deepEqual(getConnected, getUnknown, "a GET must not say which services are connected");

  // And nothing in any of it names the service, the owner, the workspace or the version.
  for (const answer of [connectedOld, connectedWrong, getConnected]) {
    assert.doesNotMatch(answer.body, /line|LINE/, "the service is never named");
    assert.doesNotMatch(answer.body, new RegExp(app.runtime.owner, "i"), "the owner is never named");
    assert.doesNotMatch(answer.body, /workspace|[/\\]var[/\\]|[/\\]Users[/\\]/i, "no path is named");
    assert.doesNotMatch(answer.body, /\d+\.\d+\.\d+/, "no version is named");
  }
});

test("the grace for the old shape of address lasts only while the door is on this computer", async (t) => {
  const { app } = await fixture(t);
  const { webhookAddressVerdict, webhookSecret } = await import("../dist/channels/webhook-address.js");
  const owner = app.runtime.owner;
  const word = webhookSecret(app.store, owner, "line");
  // This is the other half of keeping `acceptOldAddresses` on by default: the grace is a door
  // anybody can find by guessing the name, so it closes the moment Branch listens beyond here.
  assert.equal(webhookAddressVerdict(app.store, owner, "line", undefined, false), "old");
  assert.equal(webhookAddressVerdict(app.store, owner, "line", undefined, true), "refused",
    "the old shape is refused outright once the door is wider, whatever the setting says");
  // The whole address keeps working either way; that is what the word on the end is for.
  assert.equal(webhookAddressVerdict(app.store, owner, "line", word, true), "proven");
  assert.equal(webhookAddressVerdict(app.store, owner, "line", word, false), "proven");
  // And a name nobody has connected is refused the same way a wrong word is, on both doors.
  for (const beyond of [false, true])
    assert.equal(webhookAddressVerdict(app.store, owner, "nothing-here", word, beyond), "refused");
});

test("the same holds for WhatsApp's address, which also answers before any key", async (t) => {
  const { server } = await served(t);
  const wrong = "0".repeat(32);
  const one = await seen(await fetch(`${server.url}/webhooks/whatsapp/business/${wrong}`, { method: "POST", body: "{}" }));
  const two = await seen(await fetch(`${server.url}/webhooks/whatsapp/nothing-here/${wrong}`, { method: "POST", body: "{}" }));
  assert.deepEqual(one, two);
  const three = await seen(await fetch(`${server.url}/webhooks/whatsapp/business`, { method: "POST", body: "{}" }));
  assert.deepEqual(one, three, "the old shape says no more than a guessed word");
});

test("a place that keeps posting rubbish to a chat address is made to wait", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 3, lockoutMs: 60_000 } });
  t.after(() => server.close());
  const wrong = "0".repeat(32);
  const post = () => fetch(`${server.url}/webhooks/chat/telegram/${wrong}`, { method: "POST", body: "{}" });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post()).status);
  assert.ok(statuses.includes(429), `a run of wrong words must end in a wait, saw ${statuses.join(",")}`);
});

// ---------------------------------------------------------------------------
// 2. The pairing answer says nothing at all.
// ---------------------------------------------------------------------------

/** A real Ed25519 public key, so a genuine pairing is not refused for the wrong reason. */
const devicePublicKey = generateKeyPairSync("ed25519").publicKey
  .export({ format: "der", type: "spki" }).toString("base64");
const pairBody = (offer, code) => ({
  offer, code, name: "A phone", platform: "android",
  publicKey: devicePublicKey, offers: [],
});

test("a wrong pairing code and no pairing window at all answer identically", async (t) => {
  const { app, root } = await fixture(t);
  // The wait has its own test below; here there must be room to compare every way of getting it wrong.
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 50 } });
  t.after(() => server.close());
  const pair = (value) => fetch(`${server.url}/api/devices/pair`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  const offerId = "b".repeat(32);

  // Devices are switched off at first: that alone must not be readable from outside.
  const whileOff = await seen(await pair(pairBody(offerId, "000000")));
  app.devices.book.setMode({ mode: "on" });
  // Switched on, but nobody has pressed "Pair a device": no window is open.
  const noWindow = await seen(await pair(pairBody(offerId, "000000")));
  assert.deepEqual(noWindow, whileOff, "whether Devices is even switched on must not be readable");

  // A window is open; the number is wrong.
  const invitation = app.devices.book.invite();
  const wrongCode = await seen(await pair(pairBody(invitation.id, "000000" === invitation.code ? "111111" : "000000")));
  assert.deepEqual(wrongCode, noWindow, "a wrong number must say no more than no window at all");

  // A wrong invitation id, which never reaches the number at all.
  const wrongOffer = await seen(await pair(pairBody(offerId, invitation.code)));
  assert.deepEqual(wrongOffer, noWindow, "a wrong invitation must say no more");

  // A body that is not even the right shape.
  const rubbish = await seen(await pair({ offer: 5 }));
  assert.deepEqual(rubbish, noWindow, "a malformed body must say no more");

  // Asking how a request went says no more either.
  const status = await seen(await fetch(`${server.url}/api/devices/pair/status`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "c".repeat(32), signature: "x" }),
  }));
  assert.deepEqual(status, noWindow, "asking after a request nobody made must say no more");

  // Nothing in any of it counts tries down, names the owner, the workspace or the version.
  assert.doesNotMatch(noWindow.body, /tries left|attempts|expired|invitation|switched off|Customize/i);
  assert.doesNotMatch(noWindow.body, new RegExp(app.runtime.owner, "i"));
  assert.doesNotMatch(noWindow.body, /\d+\.\d+\.\d+/);
});

test("the five tries per invitation still burn it, and a run of wrong numbers is made to wait", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 50, lockoutMs: 60_000 } });
  t.after(() => server.close());
  app.devices.book.setMode({ mode: "on" });
  const invitation = app.devices.book.invite();
  const wrong = invitation.code === "000000" ? "111111" : "000000";
  const pair = (code) => fetch(`${server.url}/api/devices/pair`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pairBody(invitation.id, code)),
  });
  for (let i = 0; i < 5; i++) assert.equal((await pair(wrong)).status, 403, `try ${i + 1}`);
  // The invitation is used up underneath, so even the right number no longer works.
  assert.equal((await pair(invitation.code)).status, 403, "the fifth wrong number burns the invitation");
  assert.equal(app.devices.book.invitation(), null, "and the card shows no invitation");

  // Separately, a run of wrong numbers from one address is made to wait, as the local key is.
  const second = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 3, lockoutMs: 60_000 } });
  t.after(() => second.close());
  app.devices.book.setMode({ mode: "on" });
  const offer = app.devices.book.invite();
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const answer = await fetch(`${second.url}/api/devices/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(pairBody(offer.id, offer.code === "000000" ? "111111" : "000000")),
    });
    statuses.push(answer.status);
  }
  assert.ok(statuses.includes(429), `a run of wrong numbers must end in a wait, saw ${statuses.join(",")}`);
});

test("a real pairing still works, and the number is still only right once", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  app.devices.book.setMode({ mode: "on" });
  const invitation = app.devices.book.invite();
  const answer = await fetch(`${server.url}/api/devices/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(pairBody(invitation.id, invitation.code)),
  });
  assert.equal(answer.status, 200);
  const { requestId, status } = await answer.json();
  assert.match(requestId, /^[a-f0-9]{32}$/);
  assert.equal(status, "waiting");
  assert.equal(app.devices.book.invitation(), null, "the invitation is used up");
});

// ---------------------------------------------------------------------------
// 3. The neighbours that also answer before the key.
// ---------------------------------------------------------------------------

test("a shared conversation says only that the link is not available", async (t) => {
  const { app, server } = await served(t);
  const made = app.store.shares.create(app.runtime.owner,
    { sessionId: "11111111-1111-4111-8111-111111111111", title: "A talk", expiresInMinutes: 60 },
    [{ role: "user", content: "hello" }]);
  const page = async (path) => seen(await fetch(`${server.url}${path}`));
  const missing = await page(`/share/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}?code=WRONG1`);
  assert.equal(missing.status, 403);
  const wrongCode = await page(`/share/${made.id}?code=WRONG1`);
  assert.deepEqual(wrongCode, missing, "a real link with a wrong code says no more than no link at all");
  assert.doesNotMatch(missing.body, /not valid|already been used|expired|too many wrong/i,
    "the page must not say why");
  assert.doesNotMatch(missing.body, new RegExp(app.runtime.owner, "i"));
});

test("an artifact, an app page and a trigger say nothing about what exists", async (t) => {
  const { app, server } = await served(t);
  const long = "A".repeat(40);
  const artifact = await seen(await fetch(`${server.url}/artifact/${long}`));
  const mcpApp = await seen(await fetch(`${server.url}/mcp-app/${long}`));
  for (const answer of [artifact, mcpApp]) {
    assert.equal(answer.status, 404);
    assert.doesNotMatch(answer.body, new RegExp(app.runtime.owner, "i"));
    assert.doesNotMatch(answer.body, /\d+\.\d+\.\d+/);
  }
  // A trigger that was never made and one that exists but is not proved answer the same.
  const id = "00000000-0000-4000-8000-000000000000";
  const unknown = await seen(await fetch(`${server.url}/api/triggers/${id}/fire`, { method: "POST", body: "{}" }));
  const made = app.triggers.create(app.runtime.context(), { name: "t", prompt: "do a thing" });
  const real = await seen(await fetch(`${server.url}/api/triggers/${made.id}/fire`, { method: "POST", body: "{}" }));
  assert.deepEqual(real, unknown, "a real trigger and one that was never made answer the same");
  assert.doesNotMatch(unknown.body, /not found|Invalid secret|signature|nonce|timestamp/i);
});

test("the sign-in page says nothing about who is on this computer", async (t) => {
  const { app, root } = await fixture(t);
  const { savePeopleSettings } = await import("../dist/people/settings.js");
  savePeopleSettings(app.store, app.runtime.owner, { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const start = (name) => fetch(`${server.url}/api/people/sign-in/start`, {
    method: "POST", headers: { "content-type": "application/json", origin: server.url },
    body: JSON.stringify({ name, device: "a phone" }),
  }).then(async (answer) => ({ status: answer.status, steps: (await answer.json()).steps }));

  const profile = app.store.profiles.create({ name: "Robin", pin: "1234" });
  // Robin is asked for a passkey as well as a PIN; a name nobody here has is asked for a PIN.
  savePeopleSettings(app.store, app.runtime.owner, { chain: ["pin"], extra: { [profile.id]: ["passkey"] } });
  const known = await start("Robin");
  const unknown = await start("Nobody At All");
  assert.deepEqual(known, unknown, "which people exist must not be readable from the steps offered");
});

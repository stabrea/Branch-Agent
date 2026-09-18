/**
 * mac7/lockout: one chat service being turned away must never turn away another.
 *
 * `requestSource` answered "tunnel" for everything the webhook door passed on, so every chat
 * service on the internet shared one five-minute wait. A service retrying an address the owner had
 * replaced — which happens by itself, with nobody attacking — pushed that single entry into a wait
 * that also turned away correctly addressed messages from every other service. The owner's messages
 * stopped arriving and nothing said why.
 *
 * What is proved here: a sender is now the place it came from AND the service its address names; a
 * post carrying the right address is never made to wait; a caller working through names is still
 * stopped; the answers still say nothing about which services exist; and the owner can see it.
 *
 * Fakes and temporary folders only: no real network, no window, no sound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, WebhookChatAdapter, channelEntry } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { AuthLimiter, requestSource, tunnelMark, webhookLimitKey } from "../dist/auth-limits.js";
import { webhookSecret } from "../dist/channels/webhook-address.js";
import { webhookWaits } from "../dist/channels/webhook-waits.js";

const SECRET = "SHARED-SECRET-VALUE-0123";
const TOKEN = "SERVICE-ACCESS-TOKEN-4567";
const wrongWord = "0".repeat(32);

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

/** Two LINE-shaped services connected under different names, and a door with a short fuse. */
async function twoServices(t, authLimits = { attempts: 3, lockoutMs: 60_000 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-lockout-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const base = await chatService(t);
  for (const id of ["line", "kakao"])
    await app.channels.attach(new WebhookChatAdapter({
      id, entry: channelEntry("line"), webhookUrl: `${base}/${id}`, token: TOKEN, secret: SECRET,
    }), { activation: "always", pairing: false, allowlist: ["user-9"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits });
  t.after(() => server.close());
  const owner = app.runtime.owner;
  const words = { line: webhookSecret(app.store, owner, "line"), kakao: webhookSecret(app.store, owner, "kakao") };
  return { app, owner, server, words };
}

/** A real LINE message, signed the way LINE signs one: HMAC-SHA256 over the exact bytes, base64. */
function signedPost(server, path, id = "m-1") {
  const body = JSON.stringify({ events: [{ type: "message", message: { type: "text", id, text: "hello" }, source: { type: "user", userId: "user-9" } }] });
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": createHmac("sha256", SECRET).update(body).digest("base64") },
    body,
  });
}
/** The same message with the signature of somebody who does not hold the shared word. */
function unsignedPost(server, path) {
  return fetch(`${server.url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", "x-line-signature": "AAAA" },
    body: JSON.stringify({ events: [] }),
  });
}
const seen = async (answer) => ({ status: answer.status, body: await answer.text() });

// ---------------------------------------------------------------------------
// 1. One service's stale address never silences another's correct one.
// ---------------------------------------------------------------------------

test("a stale address on one chat service does not stop a correct message on another", async (t) => {
  const { server, words } = await twoServices(t);
  // LINE keeps posting to an address the owner replaced: five wrong words in a row, past the fuse.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`)).status);
  assert.ok(statuses.includes(429), `the stale address must end up waiting, saw ${statuses.join(",")}`);

  // Kakao, correctly addressed and correctly signed, arrives anyway. This is the whole fault: before
  // this change both services shared the one entry called "tunnel" and this post was refused.
  const good = await signedPost(server, `/webhooks/chat/kakao/${words.kakao}`);
  assert.equal(good.status, 200, "a correct message on another service must not be turned away");
  assert.deepEqual(await good.json(), { accepted: 1 });
});

test("a right address gets through while a wrong one on the same service is being stopped", async (t) => {
  const { server, words } = await twoServices(t);
  for (let i = 0; i < 5; i++) await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`);
  assert.equal((await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`)).status, 429,
    "the wrong address is still being stopped");
  // And at the same moment, on the very same name, the address the owner pasted into LINE works.
  const good = await signedPost(server, `/webhooks/chat/line/${words.line}`);
  assert.equal(good.status, 200, "a proven address must never be held by somebody else's wrong tries");
  assert.equal((await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`)).status, 429,
    "and the wrong address is still stopped afterwards: proving one does not free the other");
});

test("a proven message clears its own wait", async (t) => {
  const { app, owner, server } = await twoServices(t);
  const word = webhookSecret(app.store, owner, "line");
  // The service reaches the right address but signs wrongly — a mistyped shared secret. That is
  // counted and eventually waits, as it always has; the limit is not being weakened here.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await unsignedPost(server, `/webhooks/chat/line/${word}`)).status);
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401], "the service's own words come first");
  assert.equal(statuses.at(-1), 429, "and then it is made to wait");
  // But the wait is only ever read after a post has been found wrong, so the moment one post is
  // right it goes straight through and the count is gone.
  assert.equal((await signedPost(server, `/webhooks/chat/line/${word}`, "m-a")).status, 200,
    "a correctly signed post is never turned away, even mid-wait");
  assert.equal((await signedPost(server, `/webhooks/chat/line/${word}`, "m-b")).status, 200);
  assert.equal((await unsignedPost(server, `/webhooks/chat/line/${word}`)).status, 401,
    "and the count really was cleared, not merely stepped over");
  // A caller who never showed the word cannot feel any of that: the entry is a different one.
  assert.equal((await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`)).status, 404,
    "a wait behind the right address must not tell a stranger the name is real");
});

// ---------------------------------------------------------------------------
// 2. The limit still does its job.
// ---------------------------------------------------------------------------

test("the wrong-address limit still stops a caller working through names", async (t) => {
  const { server } = await twoServices(t);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await unsignedPost(server, `/webhooks/chat/made-up/${wrongWord}`)).status);
  assert.ok(statuses.slice(-1)[0] === 429, `a run of wrong words must end in a wait, saw ${statuses.join(",")}`);
  // Each name costs the guesser its own run of tries, and the number of entries is capped, so
  // working through names buys tries at a price rather than for nothing.
  assert.equal((await unsignedPost(server, `/webhooks/chat/made-up/${wrongWord}`)).status, 429);
});

test("being stopped on one name says nothing about whether another name exists", async (t) => {
  const { server } = await twoServices(t);
  for (let i = 0; i < 6; i++) await unsignedPost(server, `/webhooks/chat/made-up/${wrongWord}`);
  // "line" and "kakao" are really connected here; "nothing-here" never was. An unproven caller must
  // not be able to tell them apart by whether the answer is the wait or the one sentence.
  const connected = await seen(await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`));
  const unknown = await seen(await unsignedPost(server, `/webhooks/chat/nothing-here/${wrongWord}`));
  assert.deepEqual(connected, unknown, "a locked name elsewhere must not make real names answer differently");
  assert.equal(connected.status, 404, "an untouched name still gets the one sentence");
  assert.doesNotMatch(connected.body, /line|kakao/i, "the answer never names a service");
});

test("a guesser cannot drop a request into somebody else's count with a header", async () => {
  // The mark the webhook door sets is believed only on a connection from this computer, which is
  // the only place the door can dial from. Anybody else writing it is counted under their own
  // address, so the mark can never be used to push a stranger's wrong tries onto the door's count.
  assert.equal(requestSource("127.0.0.1", { [tunnelMark]: "1" }), "tunnel");
  assert.equal(requestSource("::ffff:127.0.0.1", { [tunnelMark]: "anything" }), "tunnel");
  assert.equal(requestSource("192.168.1.40", { [tunnelMark]: "1" }), "192.168.1.40",
    "a forged mark from the private network must not reach the door's own count");
  assert.equal(requestSource("127.0.0.1", {}), "127.0.0.1");
  // And the two halves of a sender are the connection and the name posted to — never a header.
  assert.notEqual(webhookLimitKey("tunnel", "chat", "line"), webhookLimitKey("tunnel", "chat", "kakao"));
  assert.notEqual(webhookLimitKey("tunnel", "chat", "line"), webhookLimitKey("192.168.1.40", "chat", "line"));
  assert.notEqual(webhookLimitKey("tunnel", "chat", "line", true), webhookLimitKey("tunnel", "chat", "line", false));
});

test("the count of senders is capped, so nobody can grow it without end", () => {
  const limiter = new AuthLimiter({ attempts: 2, lockoutMs: 60_000, windowMs: 600_000, maxEntries: 8 });
  for (let i = 0; i < 200; i++) { limiter.fail(`sender-${i}`); limiter.fail(`sender-${i}`); }
  assert.ok(limiter.waiting().length <= 8, `at most the cap may be kept, saw ${limiter.waiting().length}`);
  // Dropping the oldest can only end a wait early; it can never start one for somebody else.
  assert.equal(limiter.waitMs("sender-0"), 0, "a dropped entry is free again, not held");
  assert.ok(limiter.waitMs("sender-199") > 0, "the newest guesser is still waiting");
});

// ---------------------------------------------------------------------------
// 3. The owner can see it.
// ---------------------------------------------------------------------------

test("the owner can see that a service was turned away", async (t) => {
  const { app, owner, server } = await twoServices(t);
  for (let i = 0; i < 5; i++) await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`);

  // A line in the record of what the assistant was allowed to do, naming the service in words.
  const refusals = app.store.audit.list(owner, { action: "auth.refused", limit: 50 });
  const named = refusals.filter((entry) => `${entry.actor} ${entry.subject}`.includes("line"));
  assert.ok(named.length >= 1, "the record must name the service that is being turned away");
  assert.match(named[0].reason, /wrong tries in a row/);

  // And a note on that service's own row on the Connections card, beside the address it should use.
  const waits = webhookWaits(app.store, owner);
  assert.equal(waits.length, 1, "one service is being turned away");
  assert.equal(waits[0].channel, "line");
  assert.equal(waits[0].proven, false, "the note says the address was wrong, not the signature");
  assert.ok(waits[0].until > Date.now(), "the card can say how much longer");

  const card = await (await fetch(`${server.url}/api/channels/addresses`, { headers: { authorization: `Bearer ${server.token}` } })).json();
  assert.equal(card.waits.length, 1);
  assert.equal(card.waits[0].channel, "line");
  assert.ok(card.addresses.some((entry) => entry.channel === "kakao"), "the other services are still listed as usual");
});

test("a name nobody connected never fills the owner's card, though the record still says so", async (t) => {
  const { app, owner, server } = await twoServices(t);
  for (let i = 0; i < 8; i++) await unsignedPost(server, `/webhooks/chat/invented-${i % 2}/${wrongWord}`);
  assert.deepEqual(webhookWaits(app.store, owner), [], "made-up names must not be written onto the card");
  assert.ok(app.store.audit.list(owner, { action: "auth.refused", limit: 50 }).length >= 1,
    "the record of refusals still shows somebody was knocking");
});

// ---------------------------------------------------------------------------
// 4. Triggers, the second place one entry stood in for every caller.
// ---------------------------------------------------------------------------

test("a trigger fired with the right secret gets through while another trigger is being stopped", async (t) => {
  const { app, server } = await twoServices(t);
  const context = app.runtime.context();
  const one = app.triggers.create(context, { name: "One", prompt: "Go", rateLimitPerMinute: 30 });
  const two = app.triggers.create(context, { name: "Two", prompt: "Go", rateLimitPerMinute: 30 });
  const fire = (id, secret) => fetch(`${server.url}/api/triggers/${id}/fire`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: "{}",
  });
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await fire(one.id, "not-the-secret")).status);
  assert.ok(statuses.includes(429), `a run of wrong secrets must end in a wait, saw ${statuses.join(",")}`);
  // The other trigger is a different sender, so it never felt any of that.
  assert.equal((await fire(two.id, two.secret)).status, 200, "another trigger must not be held by this one's wait");
  // And the right secret on the very trigger being guessed at clears its own wait.
  assert.equal((await fire(one.id, one.secret)).status, 200, "the right secret is never turned away");
});

// ---------------------------------------------------------------------------
// 5. The same shape next door: a device answering an invitation.
// ---------------------------------------------------------------------------

test("a phone with the right pairing number gets in while a guesser is being made to wait", async (t) => {
  const { app, server } = await twoServices(t);
  app.devices.book.setMode({ mode: "on" });
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pair = (offer, code) => fetch(`${server.url}/api/devices/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer, code, name: "A phone", platform: "android", publicKey: key, offers: [] }),
  });
  // Somebody works through numbers on an invitation of their own until they are made to wait.
  const guessed = app.devices.book.invite();
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await pair(guessed.id, guessed.code === "000000" ? "111111" : "000000")).status);
  assert.ok(statuses.includes(429), `a run of wrong numbers must end in a wait, saw ${statuses.join(",")}`);

  // The owner's own phone, holding the number off the screen, is let in all the same. Behind the
  // never-break gateway every device reaches the engine from 127.0.0.1, so before this they shared
  // the guesser's entry and the owner simply could not pair their phone for five minutes.
  const real = app.devices.book.invite();
  assert.equal((await pair(real.id, real.code)).status, 200, "a right number must never be held by somebody else's wrong ones");
});

// ---------------------------------------------------------------------------
// 6. The old shape of address, which is the address a service was really given.
// ---------------------------------------------------------------------------

test("an address saved before the word existed is never turned away for somebody else's wrong tries", async (t) => {
  const { server } = await twoServices(t);
  // A stranger works through wrong words on this very name until that name's entry is waiting.
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await unsignedPost(server, `/webhooks/chat/line/${wrongWord}`)).status);
  assert.equal(statuses.at(-1), 429, "the name really is waiting");
  // The grace for addresses saved before the word existed is on, and the door is on this computer,
  // so this IS the address LINE was given. A wait must never be what stops it: the wait is read
  // only after an address has been found wrong, and this one is right.
  const good = await signedPost(server, "/webhooks/chat/line", "m-old");
  assert.equal(good.status, 200, "the old shape, correctly signed, must still get through");
  assert.deepEqual(await good.json(), { accepted: 1 });
});

test("the old shape is refused outright once the webhook door is carrying the internet", async (t) => {
  const { server } = await twoServices(t);
  const body = JSON.stringify({ events: [{ type: "message", message: { type: "text", id: "m-t", text: "hi" }, source: { type: "user", userId: "user-9" } }] });
  const post = (headers) => fetch(`${server.url}/webhooks/chat/line`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": createHmac("sha256", SECRET).update(body).digest("base64"), ...headers },
    body,
  });
  // Straight off this computer the grace holds, exactly as the test above showed.
  assert.equal((await post({})).status, 200);
  // Wearing the door's mark it does not: an address anybody can find by guessing the name is worth
  // less than the convenience the moment strangers can reach it, which is the same rule already
  // applied when Branch listens beyond this computer. This is what makes it safe never to hold an
  // old-shape post for waiting — the grace is only ever offered where strangers cannot knock.
  assert.equal((await post({ [tunnelMark]: "1" })).status, 404,
    "the old shape must not be answered through the public webhook door");
});

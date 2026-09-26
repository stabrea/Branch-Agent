/**
 * Q254 (security review): GET /api/runs/:id/stream (SSE) and the run socket /api/runs/:id/ws follow who is at the
 * window, as /api/events/stream does since #339. Each checked the run's owner only when it opened, so a stream or
 * socket opened as the owner on the owner's run kept delivering that run's events after the window switched to a
 * household person. Now, once the window switches, an owner event written after the switch never goes out, and the
 * stream or socket ends by itself with reason "profile". Opening it again as the person is refused (404 / 401); once
 * the window is the owner's again, the owner reopens it and reads their run. Nothing reaches a provider.
 *
 * Mutations that turn this red (each run by hand against a rebuilt dist/, one at a time):
 *  - SSE part: in src/server.ts, drop `{ owner: run.owner, scopeNow: () => app.store.profiles.scope() }` from the
 *    streamRunEvents call on /api/runs/:id/stream (or make `scopeMoved` in streamRunEvents return false). The stream
 *    then delivers "owner.after" to the person's window, failing "no owner event reaches the window on the run stream
 *    after it switched profile".
 *  - WebSocket part: in src/server.ts, drop `owner: run.owner, scopeNow: () => app.store.profiles.scope()` from the
 *    serveRunSocket call in the upgrade handler (or make `inScope` in src/ws.ts return true). The socket then delivers
 *    "owner.after", failing "no owner event reaches the window on the run socket after it switched profile".
 *
 * The live-voice half. A live conversation carried on the run socket writes its lines and sound straight down it,
 * between polls; it hears the lines and sound the browser sends up; and while it is talking it holds the socket open
 * past the socket's own deadline. Once the window switches, nothing goes either way, and the socket still ends with
 * reason "profile" and stops the conversation (onClose), past its deadline too. These tests serve the real run socket
 * (dist/ws.js) on a plain server at port 0, over the real store and the real profile switch, with stand-in live hooks:
 * nothing opens a microphone, a speaker or a provider. Mutations in src/ws.ts that turn them red:
 *  - Drop `&& inScope()` from reply.text and reply.binary. The owner's live line and sound written after the switch
 *    then reach the window, failing "no line of the owner's live conversation reaches the window after it switched
 *    profile".
 *  - Drop `&& inScope()` from the branch that hands the browser's text and binary frames to onClientFrame. The
 *    person's words and sound then reach the owner's live conversation, failing "nothing the browser sends after the
 *    switch reaches the owner's live conversation".
 *  - Make the scope check at the top of pollRun's loop never fire (`if (false)`). A socket a live conversation holds
 *    past its deadline then stays open after the switch, failing "the live conversation's socket stayed open after
 *    the switch".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readFrame, serveRunSocket } from "../dist/ws.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-run-stream-profile-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, { method,
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const ownerScope = app.store.profiles.scope();
  const ownerRun = app.store.createRun(ownerScope, "OWNER PRIVATE: draft my resignation letter");
  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const toPerson = async () => {
    assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
    assert.notEqual(app.store.profiles.scope(), ownerScope, "the window now files records under the person");
  };
  const toOwner = async () => {
    assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
    assert.equal(app.store.profiles.scope(), ownerScope);
  };
  return { app, server, ownerRun, toPerson, toOwner };
}

/** Opens the run's SSE stream; `ended` settles when the engine closes it. */
async function openStream(server, runId, t) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${server.url}/api/runs/${runId}/stream`, {
    headers: { authorization: "Bearer " + server.token }, signal: controller.signal });
  const events = [];
  if (response.status !== 200) return { status: response.status, events, ended: Promise.resolve(), kinds: () => [] };
  const ended = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const blocks = (buffer + decoder.decode(value, { stream: true })).split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const kind = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (kind) events.push({ kind, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted, or cut when the server closes: either way it has ended */ }
  })();
  return { status: 200, events, ended, kinds: () => events.map((e) => e.kind) };
}

/** Opens the run's socket; `opened` says whether the handshake succeeded, `ended` settles on close. */
async function openSocket(server, runId, t) {
  const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, ["bearer", server.token]);
  t.after(() => socket.close());
  const messages = [];
  let opened = false;
  socket.addEventListener("message", (message) => { messages.push(JSON.parse(String(message.data))); });
  const ended = new Promise((resolve) => socket.addEventListener("close", resolve));
  await Promise.race([new Promise((resolve) => socket.addEventListener("open", () => { opened = true; resolve(); })), ended]);
  return { opened, messages, ended, kinds: () => messages.map((m) => m.kind), close: () => socket.close() };
}

async function until(check, what, ms = 5000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (check()) return; await delay(50); }
  assert.fail("timed out waiting for " + what);
}

test("an open run stream stops carrying the owner's run once the window switches to a household person", async (t) => {
  const { app, server, ownerRun, toPerson, toOwner } = await fixture(t);
  const owners = await openStream(server, ownerRun.id, t);
  assert.equal(owners.status, 200, "the owner opens the stream on their own run");
  app.store.event(ownerRun.id, "owner.before", { note: "OWNER PRIVATE before" });
  await until(() => owners.kinds().includes("owner.before"), "the owner's own event on the owner's stream");

  await toPerson();
  app.store.event(ownerRun.id, "owner.after", { note: "OWNER PRIVATE after the switch" });
  // Four of the stream's 250 ms polls: long enough that an unscoped stream would have sent "owner.after".
  await delay(1000);
  assert.ok(!owners.kinds().includes("owner.after"), "no owner event reaches the window on the run stream after it switched profile");
  await Promise.race([owners.ended, delay(5000).then(() => assert.fail("the owner's run stream stayed open after the switch"))]);
  assert.ok(!owners.kinds().includes("owner.after"));
  assert.deepEqual(owners.events.at(-1), { kind: "end", data: { reason: "profile" } }, "it ended because the window switched profile, and says nothing else about the run");
  assert.doesNotMatch(JSON.stringify(owners.events), /OWNER PRIVATE after/);

  // Reconnecting as the person is refused; back at the owner's profile, the owner reads their run again.
  assert.equal((await openStream(server, ownerRun.id, t)).status, 404, "the person cannot reopen the owner's run stream");
  await toOwner();
  const again = await openStream(server, ownerRun.id, t);
  assert.equal(again.status, 200);
  await until(() => again.kinds().includes("owner.after"), "the owner's reconnect carrying on with their run");
});

test("an open run socket stops carrying the owner's run and closes once the window switches to a household person", async (t) => {
  const { app, server, ownerRun, toPerson, toOwner } = await fixture(t);
  const owners = await openSocket(server, ownerRun.id, t);
  assert.ok(owners.opened, "the owner opens the socket on their own run");
  app.store.event(ownerRun.id, "owner.before", { note: "OWNER PRIVATE before" });
  await until(() => owners.kinds().includes("owner.before"), "the owner's own event on the owner's socket");

  await toPerson();
  app.store.event(ownerRun.id, "owner.after", { note: "OWNER PRIVATE after the switch" });
  await delay(1000);
  assert.ok(!owners.kinds().includes("owner.after"), "no owner event reaches the window on the run socket after it switched profile");
  await Promise.race([owners.ended, delay(5000).then(() => assert.fail("the owner's run socket stayed open after the switch"))]);
  assert.ok(!owners.kinds().includes("owner.after"));
  assert.deepEqual(owners.messages.at(-1), { kind: "end", reason: "profile" }, "it closed because the window switched profile, and says nothing else about the run");
  assert.doesNotMatch(JSON.stringify(owners.messages), /OWNER PRIVATE after/);

  // Reconnecting as the person is refused at the handshake; back at the owner's profile, the owner reconnects.
  assert.equal((await openSocket(server, ownerRun.id, t)).opened, false, "the person cannot reopen the owner's run socket");
  await toOwner();
  const again = await openSocket(server, ownerRun.id, t);
  assert.ok(again.opened);
  await until(() => again.kinds().includes("owner.after"), "the owner's reconnect carrying on with their run");
  // Closed here, so the server's shutdown does not wait out the socket's own ceiling.
  again.close();
  await again.ended;
});

/** One short frame masked the way a browser masks it. Opcodes: 0x1 text, 0x2 binary (sound), 0x9 ping. */
function browserFrame(opcode, payload) {
  assert.ok(payload.length < 126, "a short frame");
  const mask = Buffer.from([0x5a, 0x17, 0xc3, 0x08]);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, payload.map((byte, i) => byte ^ mask[i % 4])]);
}
const say = (text) => Buffer.from(JSON.stringify({ live: "say", text }));

/**
 * A bare client on the run socket. Unlike a browser's WebSocket it sees every frame the server writes, the pong and
 * the close included, and it can send a ping.
 */
async function bareClient(port, runId) {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => { /* a reset while closing: `ended` still settles */ });
  const frames = [];
  let pending = Buffer.alloc(0), upgraded = false, closed = false;
  const ended = new Promise((resolve) => socket.once("close", () => { closed = true; resolve(); }));
  const handshake = new Promise((resolve, reject) => socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (!upgraded) {
      const end = pending.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgraded = true;
      const status = pending.subarray(0, end).toString().split("\r\n")[0];
      pending = pending.subarray(end + 4);
      if (status.startsWith("HTTP/1.1 101")) resolve(); else reject(new Error(status));
    }
    for (let frame = readFrame(pending); frame; frame = readFrame(pending)) {
      pending = pending.subarray(frame.consumed);
      frames.push({ opcode: frame.opcode, payload: frame.payload });
    }
  }));
  socket.write([`GET /api/runs/${runId}/ws HTTP/1.1`, "Host: 127.0.0.1", "Upgrade: websocket", "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
  await Promise.race([handshake, delay(5000).then(() => assert.fail("the run socket never answered the handshake"))]);
  const texts = () => frames.filter((f) => f.opcode === 0x1).map((f) => JSON.parse(f.payload.toString()));
  return {
    ended, closed: () => closed, texts, kinds: () => texts().map((m) => m.kind),
    sound: () => frames.filter((f) => f.opcode === 0x2).map((f) => [...f.payload]),
    ponged: () => frames.some((f) => f.opcode === 0xa),
    send: (...parts) => socket.write(Buffer.concat(parts)),
    destroy: () => socket.destroy(),
  };
}

/**
 * The run socket on the owner's run, served by the real serveRunSocket on a plain server at port 0, over the real
 * store and the real profile switch, and scoped as the app's upgrade handler scopes it. The live hooks are stand-ins:
 * `live.reply` is the writer the conversation is handed, `live.heard` what reached it from the browser, `live.closes`
 * how many times it was stopped, and `live.talking` whether it holds the socket open.
 */
async function liveSocket(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-run-socket-live-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const ownerRun = app.store.createRun(app.store.profiles.scope(), "OWNER PRIVATE: plan the surprise party");
  const person = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const live = { reply: undefined, heard: [], closes: 0, talking: true };
  const server = createServer(), clients = [];
  let accepted, served, closed;
  server.on("upgrade", (request, socket) => {
    accepted = socket;
    closed = new Promise((resolve) => socket.once("close", resolve));
    served = serveRunSocket(app.store, ownerRun.id, request, socket, { pollMs: 20, pingMs: 600_000, idleMs: 600_000, ...options,
      owner: ownerRun.owner, scopeNow: () => app.store.profiles.scope(), liveOpen: () => live.talking,
      onClientFrame: (payload, binary, reply) => { live.reply = reply; live.heard.push(binary ? [...payload] : payload.toString()); },
      onClose: () => { live.closes += 1; } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // One cleanup, in order: stop talking, drop every connection, let the socket's loop finish, then close the app.
  t.after(async () => {
    live.talking = false;
    for (const client of clients) client.destroy();
    accepted?.destroy();
    await Promise.race([served?.catch(() => {}), delay(5000)]);
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    await discardTemp(root);
  });
  const open = async () => { const client = await bareClient(server.address().port, ownerRun.id); clients.push(client); return client; };
  const toPerson = () => {
    // The real switch, and synchronous: nothing else runs between it and the caller's next line.
    app.store.profiles.switch({ profileId: person.id, pin: "2468" });
    assert.notEqual(app.store.profiles.scope(), ownerRun.owner, "the window now files records under the person");
  };
  return { live, open, toPerson, accepted: () => accepted, served: () => served, closed: () => closed };
}

const socketEnds = (client) =>
  Promise.race([client.ended, delay(5000).then(() => assert.fail("the live conversation's socket stayed open after the switch"))]);

test("a live conversation's own lines and sound stop going down the run socket once the window switches to a household person", async (t) => {
  const run = await liveSocket(t);
  const client = await run.open();
  // The browser starts talking; the stand-in conversation is handed the socket's writer, as a real one is.
  client.send(browserFrame(0x1, Buffer.from(JSON.stringify({ live: "start" }))));
  await until(() => run.live.reply !== undefined, "the live conversation being handed the socket's writer");
  const line = (text) => JSON.stringify({ kind: "voice.live.transcript", data: { who: "assistant", text, final: true } });
  run.live.reply.text(line("OWNER PRIVATE before the switch"));
  run.live.reply.binary(Buffer.from([7, 7, 7]));
  await until(() => client.kinds().includes("voice.live.transcript") && client.sound().length === 1, "the owner hearing their own live conversation");

  // The switch and the conversation's next line and sound come in one turn, before the socket's next poll could
  // close it: only the writer's own check stands between them and the window.
  run.toPerson();
  run.live.reply.text(line("OWNER PRIVATE after the switch"));
  run.live.reply.binary(Buffer.from([9, 9, 9]));

  await socketEnds(client);
  assert.doesNotMatch(JSON.stringify(client.texts()), /after the switch/, "no line of the owner's live conversation reaches the window after it switched profile");
  assert.deepEqual(client.sound(), [[7, 7, 7]], "no sound of the owner's live conversation reaches the window after it switched profile");
  assert.deepEqual(client.texts().at(-1), { kind: "end", reason: "profile" });
  assert.equal(run.live.closes, 1, "the live conversation is stopped");
});

test("lines and sound the browser sends after a switch to a household person never reach the owner's live conversation", async (t) => {
  const run = await liveSocket(t);
  const client = await run.open();
  client.send(browserFrame(0x1, say("OWNER before the switch")), browserFrame(0x2, Buffer.from([1, 2, 3])));
  await until(() => run.live.heard.length === 2, "the owner's own words and sound reaching their live conversation");

  // The person's words and sound arrive right after the switch. The server holds them unread until the switch has
  // happened, then reads them before its next poll could close the socket. The ping sent after them is answered, so
  // they were read while the socket was still open.
  const late = Buffer.concat([browserFrame(0x1, say("Sam speaking into the owner's conversation")),
    browserFrame(0x2, Buffer.from([4, 5, 6])), browserFrame(0x9, Buffer.from("read"))]);
  const accepted = run.accepted();
  accepted.pause();
  client.send(late);
  await until(() => accepted.readableLength >= late.length, "the browser's frames arriving at the server");
  run.toPerson();
  accepted.resume();
  await until(() => client.ponged(), "the socket reading the browser's frames after the switch");
  assert.deepEqual(run.live.heard, [JSON.stringify({ live: "say", text: "OWNER before the switch" }), [1, 2, 3]],
    "nothing the browser sends after the switch reaches the owner's live conversation");

  await socketEnds(client);
  assert.deepEqual(client.texts().at(-1), { kind: "end", reason: "profile" });
  assert.equal(run.live.closes, 1, "the live conversation is stopped");
});

test("a live conversation holding the run socket past its deadline is still ended by a switch to a household person", async (t) => {
  const run = await liveSocket(t, { maxMs: 100 });
  const client = await run.open();
  // Six times the socket's own deadline: the live conversation is what holds it open.
  await delay(600);
  assert.ok(!client.closed() && client.texts().length === 0 && run.live.closes === 0, "the live conversation holds its socket open past the deadline");

  // Nothing new is written to the run after this, so only the switch itself can end the socket.
  run.toPerson();
  await socketEnds(client);
  await run.served();
  await run.closed();
  assert.deepEqual(client.texts(), [{ kind: "end", reason: "profile" }], "it ended because the window switched profile, and said nothing else");
  assert.equal(run.live.closes, 1, "onClose runs once, which is what stops the live conversation");
});

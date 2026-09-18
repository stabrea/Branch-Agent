/**
 * mac7/reach-leftovers: the four leftovers from the R17-I reach review, and `/platform` held to the
 * caught-up rule. Fakes and temporary folders only: no other computer, relay or video service is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveReachMode } from "../dist/reach/settings.js";
import { RemoteTrunks, pairInboxKey } from "../dist/reach/remote-trunks.js";
import { RelayAdapter, saveRelaySettings, seal } from "../dist/reach/relay.js";
import { platformGate, saveOwnerAccounts } from "../dist/reach/platform.js";
import { makeVideo, saveVideoSettings, videoPrice } from "../dist/reach/video.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { spendCapCheck } from "../dist/knobs/apply.js";
import { reachApi } from "../dist/reach/api.js";

const owner = "local";
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
async function scratchApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-reach-leftovers-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store };
}
const on = (store, ...parts) => { for (const part of parts) saveReachMode(store, owner, part, { mode: "on" }); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("remote Trunks: the sending computer is the one its key was paired with, whatever the message claims", async (t) => {
  const { store } = await scratchApp(t);
  const machines = [
    { id: "mini", name: "Mini", address: "https://mini.example", secret: "K1", labels: [] },
    { id: "studio", name: "Studio", address: "https://studio.example", secret: "K2", labels: [] },
  ];
  const delivered = [];
  const trunks = new RemoteTrunks(store, owner, { list: () => machines }, { fetcher: async () => json({}), secret: async () => "k" }, {
    list: () => [], deliver: async (handle, message) => { delivered.push({ handle, ...message }); return true; },
  });
  on(store, "remote-trunks");
  const message = (machine) => ({ to: "writer", from: `scout-${machine}`, machine, text: "hi" });
  await assert.rejects(trunks.receive(message("mini"), undefined), /key .*paired|paired .*key/i, "no key, no message");
  await assert.rejects(trunks.receive(message("mini"), "aaaaaaaaaaaaaaaa"), /paired/i, "a key paired with nothing");
  assert.throws(() => pairInboxKey(store, owner, { machine: "nowhere", keyId: "aaaaaaaaaaaaaaaa" }, machines), /no computer called nowhere/);
  pairInboxKey(store, owner, { machine: "mini", keyId: "aaaaaaaaaaaaaaaa" }, machines);
  pairInboxKey(store, owner, { machine: "studio", keyId: "bbbbbbbbbbbbbbbb" }, machines);
  // Authenticated as mini's key, claiming to be studio (a computer the owner did add): refused.
  await assert.rejects(trunks.receive(message("studio"), "aaaaaaaaaaaaaaaa"), /paired with mini/);
  assert.equal(delivered.length, 0);
  await trunks.receive(message("mini"), "aaaaaaaaaaaaaaaa");
  assert.match(delivered[0].from, /on the computer mini;/);
  // Re-pairing mini with a new key retires the old one.
  pairInboxKey(store, owner, { machine: "mini", keyId: "cccccccccccccccc" }, machines);
  await assert.rejects(trunks.receive(message("mini"), "aaaaaaaaaaaaaaaa"), /paired/i);
  await trunks.receive(message("mini"), "cccccccccccccccc");
});

test("remote Trunks: the inbox route hands the key the request came with, and pairing is an owner's change", async (t) => {
  const { app, store } = await scratchApp(t);
  on(store, "remote-trunks");
  const seen = [];
  app.reachParts.remoteTrunks.receive = async (input, keyId) => { seen.push(keyId); return { delivered: true }; };
  const deps = (method, body, keyId) => ({ reach: app.reachParts, method, query: new URLSearchParams(), readBody: async () => body, keyId });
  await reachApi(deps("POST", { to: "writer", from: "x-mini", machine: "mini", text: "hi" }, "dddddddddddddddd"), "/api/reach/trunks/inbox");
  assert.deepEqual(seen, ["dddddddddddddddd"]);
  const { shortLivedKeyTaskRoutes } = await import("../dist/short-lived-keys.js");
  assert.equal(shortLivedKeyTaskRoutes.some((route) => route.pattern.test("/api/reach/trunks/keys")), false, "a short-lived key cannot pair itself");
  const listed = await reachApi(deps("GET", undefined), "/api/reach/trunks/keys");
  assert.deepEqual(listed, { keys: [] });
});

test("remote Trunks: a real request with a run key arrives as that key's computer", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "branch-reach-inbox-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const store = app.store;
  app.asks.nodes.save({ nodes: [{ id: "mini", name: "Mini", address: "https://mini.example", secret: "K" }] });
  const { saveAskMode } = await import("../dist/asks/settings.js");
  saveAskMode(store, owner, "nodes", { mode: "on" });
  on(store, "remote-trunks");
  const delivered = [];
  app.reachParts.remoteTrunks.useRoster({ list: () => [], deliver: async (handle, message) => { delivered.push({ handle, ...message }); return true; } });
  const key = app.sessionTokens.create(owner, { name: "the Mini", scope: "run", minutes: 5 });
  const post = (body, token) => fetch(`${server.url}/api/reach/trunks/inbox`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const message = { to: "writer", from: "scout-mini", machine: "mini", text: "hello" };
  const unpaired = await post(message, key.token);
  assert.equal(unpaired.status, 400);
  assert.match(unpaired.body.error, /paired/i);
  app.reachParts.remoteTrunks.pair({ machine: "mini", keyId: key.entry.id });
  const taken = await post(message, key.token);
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(delivered.length, 1, "the key really reached receive()");
  // This computer's own key is not paired with any computer, so it is not a peer either.
  const own = await post(message, server.token);
  assert.equal(own.status, 400);
  assert.match(own.body.error, /computer the owner added/);
});

const pairing = "a".repeat(64);
test("relay: an envelope already taken is refused after a restart too", async (t) => {
  const { store } = await scratchApp(t);
  on(store, "relay");
  const s = saveRelaySettings(store, owner, { address: "https://relay.example", relayId: "relay-1", platforms: ["telegram"] });
  const envelope = seal(pairing, "relay-1", s.machineId, { kind: "message", platform: "telegram", chatId: "100", chatKind: "direct",
    senderId: "42", senderName: "Ann", text: "pay the bill", messageId: randomUUID() });
  const fetcher = async () => json({ envelopes: [envelope] });
  const first = new RelayAdapter({ store, owner, fetcher, secret: async () => pairing });
  const got = [];
  assert.equal(await first.poll(async (m) => { got.push(m); }), 1);
  const restarted = new RelayAdapter({ store, owner, fetcher, secret: async () => pairing });
  assert.equal(await restarted.poll(async (m) => { got.push(m); }), 0, "the same envelope after a restart");
  assert.equal(restarted.refused, 1);
  assert.equal(got.length, 1);
  const seenRecord = JSON.stringify(store.get("settings", owner, "reach-relay-seen")?.data ?? {});
  assert.equal(seenRecord.includes("pay the bill"), false, "only ids are kept, never what the message said");
});

test("relay: the remembered ids expire and are bounded; a full list refuses rather than forgets", async (t) => {
  const { store } = await scratchApp(t);
  on(store, "relay");
  const s = saveRelaySettings(store, owner, { address: "https://relay.example", relayId: "relay-1", platforms: ["telegram"] });
  let now = Date.parse("2026-09-17T10:00:00Z");
  const make = () => seal(pairing, "relay-1", s.machineId, { kind: "message", platform: "telegram", chatId: "1", chatKind: "direct",
    senderId: "42", senderName: "Ann", text: "hi", messageId: randomUUID() }, now);
  const { relaySeenLimit } = await import("../dist/reach/relay.js");
  const old = Array.from({ length: relaySeenLimit }, (_, i) => [i.toString(16).padStart(24, "0"), now]);
  store.save("settings", owner, "reach-relay-seen", { seen: old });
  let inbox = [make()];
  const adapter = new RelayAdapter({ store, owner, fetcher: async () => json({ envelopes: inbox }), secret: async () => pairing, now: () => now });
  assert.equal(await adapter.poll(async () => undefined), 0, "full: nothing new is taken");
  now += 11 * 60_000;
  inbox = [make()];
  assert.equal(await adapter.poll(async () => undefined), 1, "the old ids have expired");
  assert.equal(store.get("settings", owner, "reach-relay-seen").data.seen.length, 1);
});

test("/platform sent while Branch was closed does not pause or resume anything", async (t) => {
  const { app, store } = await scratchApp(t);
  on(store, "platform-pause");
  saveOwnerAccounts(store, owner, [{ channel: "telegram", sender: "owner-7" }]);
  const inbound = (over = {}) => ({ channel: "telegram", chatId: "c1", chatKind: "direct", senderId: "owner-7", senderName: "Me",
    text: "/platform pause", addressed: true, messageId: "1", ...over });
  assert.deepEqual(platformGate(store, owner, inbound({ caughtUp: true })), { reply: null });
  assert.deepEqual((store.get("settings", owner, "reach-platform-settings")?.data ?? {}).paused ?? [], []);
  const sent = [];
  await app.channels.attach({ id: "fake", kind: "fake", botName: () => "Bot", start: async () => undefined,
    send: async (chatId, text) => { sent.push(text); return "m"; }, stop: async () => undefined }, { activation: "always", pairing: true, allowlist: [] });
  saveOwnerAccounts(store, owner, [{ channel: "fake", sender: "owner-7" }]);
  assert.equal(await app.channels.handle(inbound({ channel: "fake", caughtUp: true })), "ignored");
  assert.deepEqual(sent, []);
  assert.deepEqual(store.get("settings", owner, "reach-platform-settings").data.paused, []);
  // A paused app still lets its caught-up messages go.
  assert.match(platformGate(store, owner, inbound({ channel: "fake" })).reply, /fake is paused/);
  assert.equal(await app.channels.handle(inbound({ channel: "fake", caughtUp: true, text: "/platform resume" })), "ignored");
  assert.deepEqual(store.get("settings", owner, "reach-platform-settings").data.paused, ["fake"]);
});

const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);
function videoDeps(app, calls) {
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/v1/videos")) return json({ id: "v1", status: "queued" });
    if (String(url).endsWith("/v1/videos/v1")) return json({ id: "v1", status: "completed" });
    return new Response(mp4());
  };
  return { fetcher, secret: async () => "k", files: app.reachParts.deps.files, sleep: async () => undefined };
}

test("video: each video is priced, and the task's spending cap refuses before the service is asked", async (t) => {
  const { app, store } = await scratchApp(t);
  on(store, "video");
  assert.deepEqual(videoPrice(saveVideoSettings(store, owner, {}), 8), { dollars: 0.8, estimate: false, model: "sora-2" });
  const guessed = videoPrice(saveVideoSettings(store, owner, { model: "sora-9-ultra" }), 4);
  assert.equal(guessed.estimate, true, "a model with no price on file is a conservative estimate");
  assert.ok(guessed.dollars >= 3);
  assert.deepEqual(videoPrice(saveVideoSettings(store, owner, { pricePerSecond: 0.2 }), 4), { dollars: 0.8, estimate: false, model: "sora-9-ultra" });
  saveVideoSettings(store, owner, { model: "", pricePerSecond: null, perDay: 50 });
  const practice = await makeVideo(store, owner, videoDeps(app, []), { prompt: "a fox" }, AbortSignal.timeout(5000), { dryRun: true });
  assert.match(practice.wouldMake, /\$0\.80/);

  const run = store.createRun(owner, "make videos");
  saveKnobs(store, owner, "limits", { spendCapDollars: 1.5 });
  const calls = [];
  await makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox" }, AbortSignal.timeout(5000), { runId: run.id });
  assert.deepEqual(store.events(run.id).filter((e) => e.kind === "spend.recorded").map((e) => e.data.dollars), [0.8]);
  const before = calls.length;
  await assert.rejects(makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox" }, AbortSignal.timeout(5000), { runId: run.id }),
    /\$1\.50 for one task/);
  assert.equal(calls.length, before, "the service was not asked");
  assert.equal(store.get("settings", owner, "reach-video-count").data.count, 1, "a refused video does not use up the day");
  // The task's own check (the runtime's) now sees the video too.
  saveKnobs(store, owner, "limits", { spendCapDollars: 0.5 });
  assert.match(spendCapCheck(store, owner, [run.id], "gpt-4o").refusal ?? "", /reaches the limit/);
  saveKnobs(store, owner, "limits", { spendCapDollars: null });
  saveVideoSettings(store, owner, { perDay: 1 });
  await assert.rejects(makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox" }, AbortSignal.timeout(5000), { runId: run.id }), /used up/);
});

test("video: this month's budget counts videos and refuses one that would go past it", async (t) => {
  const { app, store } = await scratchApp(t);
  on(store, "video");
  saveVideoSettings(store, owner, { perDay: 50 });
  const done = store.createRun(owner, "an earlier task");
  const calls = [];
  await makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox", seconds: 12 }, AbortSignal.timeout(5000), { runId: done.id });
  store.finish(done.id, "completed", "made");
  assert.equal(store.usageStore().getMonthlyStats().estimatedCost, 1.2, "the month's cost includes the video");
  store.save("settings", owner, "usage_budget", { maxMonthlyDollars: 2, pauseAtBudget: true });
  const run = store.createRun(owner, "another");
  await makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox", seconds: 4 }, AbortSignal.timeout(5000), { runId: run.id });
  const before = calls.length;
  await assert.rejects(makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox", seconds: 8 }, AbortSignal.timeout(5000), { runId: run.id }),
    /month's budget/);
  await assert.rejects(makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox", seconds: 8 }, AbortSignal.timeout(5000)), /month's budget/);
  assert.equal(calls.length, before);
  store.save("settings", owner, "usage_budget", { maxMonthlyDollars: 2, pauseAtBudget: false });
  await makeVideo(store, owner, videoDeps(app, calls), { prompt: "a fox", seconds: 8 }, AbortSignal.timeout(5000), { runId: run.id });
});

test("video: the tool hands its task to the spending check", async (t) => {
  const { app, store } = await scratchApp(t);
  await app.reachParts.setMode("video", { mode: "on" });
  saveKnobs(store, owner, "limits", { spendCapDollars: 0.5 });
  app.reachParts.videoDeps = () => videoDeps(app, []);
  const context = app.runtime.context();
  const run = store.createRun(owner, "tool");
  await assert.rejects(app.registry.execute("video.generate", { prompt: "a fox" }, { ...context, runId: run.id }), /\$0\.50 for one task/);
});

/**
 * r17-i integration review (adversarial pass): the holes found and closed. Fakes and temporary
 * folders only — no other computer, video service, git server or screen is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";
import { reachParts, saveReachMode } from "../dist/reach/settings.js";
import { machineCall } from "../dist/reach/machines.js";
import * as background from "../dist/reach/background-screen.js";
const { xdotoolPath } = background;
import { makeVideo, saveVideoSettings } from "../dist/reach/video.js";
import { UsbTrigger } from "../dist/reach/usb.js";
import { gitCommands } from "../dist/reach/agent-git.js";
import { Notes } from "../dist/reach/notes.js";
import { classify } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";

const owner = "local";
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function scratchApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-reach-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, root };
}
const on = (store, ...parts) => { for (const part of parts) saveReachMode(store, owner, part, { mode: "on" }); };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

test("review: a household person, a short-lived key and another assistant's task never reach the reach tools", async (t) => {
  const { app } = await scratchApp(t);
  for (const part of ["machines", "notes", "video", "remote-trunks"]) await app.reachParts.setMode(part, { mode: "on" });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const context = (options = {}) => app.runtime.context(options);
  await assert.rejects(asPerson({ profileId: person.id, keyId: "k" }, () => app.registry.execute("notes.list", {}, context())), /belongs to the owner/);
  await assert.rejects(underShortLivedKey(() => app.registry.execute("machines.list", {}, context())), /short-lived key/);
  for (const source of ["a2a", "mcp", "acp"]) {
    await assert.rejects(app.registry.execute("trunks.remote.roster", {}, context({ source })), /another assistant/, source);
    await assert.rejects(app.registry.execute("machines.look", { machine: "x", view: "health" }, context({ source })), /another assistant/, source);
  }
  const listed = await app.registry.execute("notes.list", {}, context());
  assert.deepEqual(listed.notes ?? listed.output?.notes ?? [], [], "the owner still can");
});

test("review: another computer's key never goes over plain http, except on this computer or Tailscale", async () => {
  const asked = [], sent = [];
  const link = { fetcher: async (url) => { sent.push(String(url)); return json({ ok: true }); }, secret: async (name) => { asked.push(name); return "k"; } };
  const entry = (address) => ({ id: "m", name: "M", address, secret: "M_KEY", labels: [] });
  await assert.rejects(machineCall(link, entry("http://studio.example"), "/api/health"), /https/);
  assert.deepEqual([asked, sent], [[], []], "the key was not even read");
  for (const address of ["https://studio.example", "http://100.101.2.3:3210", "http://desk.tail1234.ts.net", "http://127.0.0.1:3210"])
    assert.equal((await machineCall(link, entry(address), "/api/health")).ok, true, address);
});

function fakeExec(windows) {
  const calls = [];
  const exec = async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === xdotoolPath && args[0] === "getwindowname") return { status: "ok", exitCode: 0, stdout: "Bitwarden\n", stderr: "" };
    if (executable === xdotoolPath && args[0] === "getwindowpid") return { status: "ok", exitCode: 0, stdout: "77\n", stderr: "" };
    if (executable.endsWith("ps")) return { status: "ok", exitCode: 0, stdout: "bitwarden\n", stderr: "" };
    const action = args[args.length - 2];
    const result = action === "windows" ? { windows } : { pressed: "x" };
    return { status: "ok", exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: "" };
  };
  return { exec, calls };
}

test("review: background app use follows the screen switch, the refused windows, the typed-secret rule and the per-task cap", async (t) => {
  const { store } = await scratchApp(t);
  const windows = [{ handle: "10:1", title: "Notes", program: "Notes" }, { handle: "11:1", title: "Vault", program: "1Password 7" }];
  const { exec, calls } = fakeExec(windows);
  const screen = new background.BackgroundScreen({ store, owner, exec, platform: "darwin" });
  const context = { runId: "run-1", signal: AbortSignal.timeout(5000) };
  await assert.rejects(screen.run({ action: "windows" }, context), /not allowed to use your screen/);
  assert.equal(calls.length, 0, "nothing ran while the screen switch is off (and so under Lockdown)");
  saveDesktopSettings(store, owner, { mode: "on", maxActionsPerRun: 2 });
  const listed = await screen.run({ action: "windows" }, context);
  assert.deepEqual(listed.windows.map((w) => w.offLimits), [false, true]);
  await assert.rejects(screen.run({ action: "press", handle: "11:1", name: "Unlock" }, context), /password or sign-in window/);
  await assert.rejects(screen.run({ action: "set-text", handle: "10:1", name: "Body", text: "{{BANK_PASSWORD}}" }, context), /placeholder/);
  assert.equal(calls.filter((c) => c.includes("press")).length, 0, "the refused window was never pressed");
  await assert.rejects(screen.run({ action: "controls", handle: "10:1" }, context), /used the screen 2 times/);

  const linux = fakeExec([]);
  saveDesktopSettings(store, owner, { mode: "on", maxActionsPerRun: 40 });
  const onLinux = new background.BackgroundScreen({ store, owner, exec: linux.exec, platform: "linux" });
  await assert.rejects(onLinux.run({ action: "type", xwindow: 42, text: "hunter2" }, { runId: "run-2", signal: AbortSignal.timeout(5000) }), /password/);
  assert.equal(linux.calls.some((c) => c[1] === "type"), false, "nothing was typed into the password manager");
});

test("review: a video from Google never carries the OpenAI key, a practice run spends nothing, and a day has a cap", async (t) => {
  const { app, store, root } = await scratchApp(t);
  on(store, "video");
  const sent = [];
  const fetcher = async (url, init = {}) => {
    sent.push({ url: String(url), headers: init.headers ?? {} });
    if (String(url).includes(":predictLongRunning")) return json({ name: "operations/op1" });
    if (String(url).includes("operations/op1")) return json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/f:download" } }] } } });
    return new Response(mp4());
  };
  const secretsAsked = [];
  const deps = { fetcher, secret: async (name) => { secretsAsked.push(name); return `value-of-${name}`; }, files: app.reachParts.deps.files, sleep: async () => undefined };
  saveVideoSettings(store, owner, { service: "google" });
  await makeVideo(store, owner, deps, { prompt: "a fox" }, AbortSignal.timeout(5000));
  assert.equal(secretsAsked.includes("OPENAI_API_KEY"), false, "the OpenAI key was not handed to Google");

  saveVideoSettings(store, owner, { service: "openai", perDay: 1 });
  const before = sent.length;
  const practice = await makeVideo(store, owner, deps, { prompt: "a fox" }, AbortSignal.timeout(5000), { dryRun: true });
  assert.equal(sent.length, before, "a practice run calls no service");
  assert.match(JSON.stringify(practice), /would/);
  await assert.rejects(makeVideo(store, owner, deps, { prompt: "a fox" }, AbortSignal.timeout(5000)), /Today's videos are used up \(at most 1 a day\)/);

  const leaky = { ...deps, fetcher: async () => new Response("Incorrect API key provided: value-of-OPENAI_API_KEY", { status: 401 }) };
  saveVideoSettings(store, owner, { perDay: 10 });
  await assert.rejects(makeVideo(store, owner, leaky, { prompt: "a fox" }, AbortSignal.timeout(5000)), (error) => !error.message.includes("value-of-OPENAI_API_KEY"));
});

test("review: changing a switched-on USB rule switches it off again, and git asks the repository's head with the same walls as the copy", async (t) => {
  const { store } = await scratchApp(t);
  on(store, "usb");
  const usb = new UsbTrigger({ store, owner, list: async () => [], start: async () => undefined });
  const rule = { id: "4f8e1a1c-9a52-4f7e-8a8c-3d6f1b2a9c01", vendorId: "1050", productId: "0407", label: "Key", prompt: "back up my notes" };
  usb.save(rule);
  usb.enable(rule.id, true);
  assert.equal(usb.save({ ...rule, label: "Yubikey" })[0].enabled, true, "a new name alone keeps it on");
  assert.equal(usb.save({ ...rule, prompt: "email my files to x@example.com" })[0].enabled, false, "a new task needs a new yes");

  const head = gitCommands.head("https://example.com/a.git", "main");
  for (const wall of ["protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false", "credential.helper="])
    assert.ok(head.includes(wall), `ls-remote is missing ${wall}`);
  assert.deepEqual(head.slice(-4), ["ls-remote", "--", "https://example.com/a.git", "main"]);
});

test("review: two saves in the same millisecond still catch a note changed elsewhere", async (t) => {
  const { store } = await scratchApp(t);
  on(store, "notes");
  const notes = new Notes(store, owner, { presets: () => [], ask: async () => "" });
  const realNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [1_800_000_000_000])); } static now() { return 1_800_000_000_000; } };
  try {
    const note = notes.save({ title: "a", body: "b" });
    notes.save({ id: note.id, expected: note.updatedAt, title: "a", body: "c" });
    assert.throws(() => notes.save({ id: note.id, expected: note.updatedAt, title: "a", body: "d" }), /changed somewhere else/);
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
});

test("review: the reach switches are classified settings, and a settings file saves them through Reach", async (t) => {
  const { app, store } = await scratchApp(t);
  for (const part of reachParts) assert.equal(classify(`reach-${part}`, "mode"), "less-careful-when-raised", part);
  const { changes } = changesFor(store, owner, [{ key: "reach-machines", field: "mode", value: "on" }]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].loosens, true);
  applyChanges(store, owner, changes, { accept: [changes[0].id], confirmLoosening: true, why: "test",
    writers: { "reach-machines": (patch) => { void app.reachParts.setMode("machines", patch); } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.registry.names().includes("machines.look"), "the tools came with the switch");
});

test("review: switching service in the window drops a key name that was saved for the other service", async (t) => {
  const { store } = await scratchApp(t);
  saveVideoSettings(store, owner, { service: "openai", secret: "MY_OPENAI_KEY" });
  // The window posts every field it shows, the old key name included.
  const saved = saveVideoSettings(store, owner, { service: "google", secret: "MY_OPENAI_KEY", model: "", perDay: 3 });
  assert.equal(saved.secret, "", "Google is not handed the OpenAI key's name");
  assert.equal(saveVideoSettings(store, owner, { service: "openai", secret: "OTHER_KEY" }).secret, "OTHER_KEY", "a name typed with the change is kept");
});

test("review: Lockdown stops every reach change, the relay and branch send; switching a part off still works", async (t) => {
  const { app, store } = await scratchApp(t);
  const { reachApi } = await import("../dist/reach/api.js");
  const { setLockdown } = await import("../dist/lockdown.js");
  const { sendToChat } = await import("../dist/reach/platform.js");
  const call = (path, body) => reachApi({ reach: app.reachParts, method: "POST", query: new URLSearchParams(), readBody: async () => body }, path);
  on(store, "send", "relay", "machines", "remote-trunks", "notes");
  setLockdown(store, owner, { on: true });
  for (const [path, body] of [["/api/reach/send", { channel: "t", chat: "1", text: "hi" }], ["/api/reach/machines/start", { machine: "m", prompt: "x" }],
    ["/api/reach/trunks/inbox", { to: "writer", from: "a-b", machine: "zz", text: "hi" }], ["/api/reach/notes", { title: "x" }],
    ["/api/reach/switch", { part: "video", mode: "on" }]])
    await assert.rejects(call(path, body), (e) => e.status === 423 && /Lockdown/.test(e.message), path);
  assert.deepEqual(await call("/api/reach/switch", { part: "notes", mode: "off" }), { part: "notes", mode: "off" });
  const router = { chats: () => [{ channel: "t", chatId: "1" }], deliver: async () => { throw new Error("delivered under Lockdown"); } };
  await assert.rejects(sendToChat(store, owner, router, { channel: "t", chat: "1", text: "hi" }), /Lockdown/);
  saveRelaySettingsForTest(store);
  let fetched = 0;
  app.reachParts.relay.deps.fetcher = async () => { fetched++; return json({ envelopes: [] }); };
  assert.equal(await app.reachParts.relay.poll(async () => undefined), 0);
  await assert.rejects(app.reachParts.relay.send("telegram:1", "hi"), /Lockdown/);
  assert.equal(fetched, 0, "the relay is not asked while Lockdown is on");
});

function saveRelaySettingsForTest(store) {
  store.save("settings", owner, "reach-relay-settings", { address: "https://relay.example", machineId: "0123456789abcdef", relayId: "r1",
    secret: "BRANCH_RELAY_SECRET", platforms: ["telegram"] });
}

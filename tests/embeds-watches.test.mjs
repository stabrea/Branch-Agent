/**
 * Wave 8: the two ways of reaching Branch from outside its own window, and the two kinds of watch.
 *
 * The small box and the extension both refuse this computer's own address outright, because the key
 * the app's own page uses here is the whole of Branch's authority on this machine. The extension
 * folder is a real Manifest V3 folder. A page watch sends its news through a channel the owner has
 * connected; a screen watch compares one rectangle against the last time it looked, with the
 * picture-taking handed in, so no test ever opens a window.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  ScreenWatches, createBranch, embedSettings, isLoopback, saveEmbedSettings, saveScreenWatchSettings,
  widgetOrigin,
} from "../dist/index.js";

const EXTENSION = new URL("../extras/browser-extension/", import.meta.url);

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-embeds-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("E1 the small box and the extension both refuse this computer's own address", async (t) => {
  for (const loopback of ["http://localhost:8765", "http://127.0.0.1:8765", "http://127.9.9.9:1", "http://[::1]:8765", "not an address"])
    assert.equal(isLoopback(loopback), true, `${loopback} was not treated as this computer talking to itself`);
  for (const remote of ["http://desk.tailnet.ts.net:8765", "https://desk.example:443"])
    assert.equal(isLoopback(remote), false, `${remote} was refused although it is a paired address`);

  /* The same rule lives in the two files that actually enforce it, in the same shape. */
  const widget = await readFile(new URL("../public/widget.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("popup.js", EXTENSION), "utf8");
  for (const [what, source] of [["the small box", widget], ["the extension", popup]]) {
    assert.match(source, /isLoopback/, `${what} has no loopback check at all`);
    assert.match(source, /data-key|\$\("key"\)|dataset\.key/, `${what} does not take its key from the owner`);
    assert.equal(/sessionStorage|localStorage\.getItem\(["']branch-token/.test(source), false,
      `${what} reads a key out of storage, which is where this page's own key lives`);
  }
});

test("E1 the small box says why, and does nothing, when it is pointed at this computer", async (t) => {
  /* The file draws itself where its own script tag is; with no page around it there is no tag. */
  globalThis.document = { currentScript: null, createElement: () => ({ setAttribute() {}, append() {}, addEventListener() {} }) };
  t.after(() => { delete globalThis.document; });
  const { settingsFrom } = await import("../public/widget.js");
  const pointed = (attributes) => settingsFrom({ dataset: attributes });
  assert.match(pointed({ branch: "http://127.0.0.1:8765", key: "k" }).why, /will not talk to Branch on this computer/i);
  assert.equal(pointed({ branch: "http://127.0.0.1:8765", key: "k" }).ok, false);
  assert.match(pointed({ branch: "http://desk.tailnet.ts.net:8765" }).why, /key pairing gave you/i);
  assert.match(pointed({ key: "k" }).why, /address of your paired Branch/i);
  const good = pointed({ branch: "http://desk.tailnet.ts.net:8765/", key: "k" });
  assert.equal(good.ok, true);
  assert.equal(good.where, "http://desk.tailnet.ts.net:8765", "the trailing slash was kept");
});

test("E2 the extension folder is a real Manifest V3 folder with install steps", async (t) => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", EXTENSION), "utf8"));
  assert.equal(manifest.manifest_version, 3, "the extension is not Manifest V3");
  assert.ok(manifest.name && manifest.version && manifest.description);
  assert.ok(manifest.action?.default_popup, "the extension has no popup, so there is nothing to press");
  /* Manifest V3 has no background page and no broad host permission here. */
  // w911 (A2144): the right-click page notes add a Manifest V3 service worker and the context menu.
  assert.deepEqual(manifest.background, { service_worker: "background.js", type: "module" }, "a Manifest V2 background page survived");
  assert.deepEqual(manifest.permissions.sort(), ["activeTab", "contextMenus", "scripting", "storage"]);
  assert.equal(manifest.host_permissions, undefined, "the extension asks for every site");
  /* It asks for nothing up front, and for one address at the moment the owner names it. Without
     this the popup's own fetch is blocked by Chrome and the extension can reach no listener at all. */
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  const popup = await readFile(new URL("popup.js", EXTENSION), "utf8");
  assert.match(popup, /chrome\.permissions\?\.request\(\{ origins \}\)/,
    "the popup never asks Chrome for the address the owner typed");

  const files = (await readdir(EXTENSION)).sort();
  assert.deepEqual(files, ["README.md", "address.js", "background.js", "content.js", "manifest.json", "popup.html", "popup.js"]); // w911 (A2144)
  assert.match(await readFile(new URL("README.md", EXTENSION), "utf8"), /Load unpacked/,
    "the README never says how to install it");
});

test("E2 both ways in are off until the owner switches them on", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  assert.deepEqual(embedSettings(app.store, owner), { widget: false, extension: false, widgetSites: [] });
  assert.deepEqual(saveEmbedSettings(app.store, owner, { widget: true }),
    { widget: true, extension: false, widgetSites: [] });
  assert.deepEqual(embedSettings(app.store, owner), { widget: true, extension: false, widgetSites: [] });
});

test("E2 only a website the owner listed is named back to a browser asking for the box", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;

  // Switched off, nothing is named back, however the site asks.
  const off = saveEmbedSettings(app.store, owner, { widgetSites: ["https://notes.example.com"] });
  assert.equal(widgetOrigin(off, "https://notes.example.com"), null, "the switch is still off");

  const on = saveEmbedSettings(app.store, owner, { widget: true });
  assert.equal(widgetOrigin(on, "https://notes.example.com"), "https://notes.example.com",
    "the site the owner listed is named back, exactly and not as a star");
  assert.equal(widgetOrigin(on, "https://notes.example.com:443"), "https://notes.example.com:443",
    "the same origin written with its usual port is the same origin");
  for (const stranger of ["https://notes.example.com.evil.test", "http://notes.example.com",
    "https://other.example.com", "null", undefined, "http://127.0.0.1:8765", "http://localhost:8765"])
    assert.equal(widgetOrigin(on, stranger), null, `${stranger} was named back to the browser`);

  // A browser sends one origin; a header arriving twice must not become a way past the list.
  assert.equal(widgetOrigin(on, ["https://other.example.com", "https://notes.example.com"]), null);
});

test("E3 a page watch sends its news through a channel the owner connected", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  const sent = [];
  /* A made-up channel, so nothing leaves this computer and nothing needs a key. */
  const monitors = new (await import("../dist/monitors.js")).Monitors(
    app.store,
    { fetchPage: async () => ({ text: "the page as it is today", url: "http://example.test" }) },
    async (channel, chatId, text) => { sent.push({ channel, chatId, text }); return { messageId: "m1" }; },
  );
  const watch = await monitors.create(owner, { url: "http://example.test/", every: "6h",
    notifyVia: { channel: "fake", chatId: "42" }, label: "The notice board" });
  assert.deepEqual(sent, [], "a watch shouted before anything had changed");

  monitors.web.fetchPage = async () => ({ text: "the page, now saying something else entirely", url: "http://example.test" });
  const looked = await monitors.check(owner, watch.id, new Date());
  assert.equal(looked.changed, true, "the change was not noticed");
  assert.equal(sent.length, 1, "the news never reached the channel");
  assert.equal(sent[0].channel, "fake");
  assert.equal(sent[0].chatId, "42");
  assert.match(sent[0].text, /Something changed on the page/i);
  assert.match(sent[0].text, /something else entirely/i, "the news does not say what changed");
});

test("E4 a screen watch notices a change, and is off until the owner asks twice", async (t) => {
  const app = await workspace(t);
  const owner = app.runtime.owner;
  let screen = new Uint8Array([1, 2, 3, 4]);
  const sent = [];
  /* The picture-taking is handed in, so this test never opens a window or touches the screen. */
  const watches = new ScreenWatches(app.store, async () => screen, () => true,
    async (channel, chatId, text) => { sent.push({ channel, chatId, text }); return { messageId: "m1" }; });
  const region = { x: 10, y: 20, width: 200, height: 100 };

  await assert.rejects(watches.create(owner, { label: "The progress bar", region }), /switched off/i);
  saveScreenWatchSettings(app.store, owner, { enabled: true });

  /* It also needs using the screen to be switched on, which is a separate switch. */
  const offScreen = new ScreenWatches(app.store, async () => screen, () => false);
  await assert.rejects(offScreen.create(owner, { label: "The progress bar", region }), /using your screen/i);

  const made = await watches.create(owner, { label: "The progress bar", region,
    notifyVia: { channel: "fake", chatId: "42" } });
  const same = await watches.check(owner, made.id);
  assert.equal(same.changed, false, "the same picture was called a change");
  assert.deepEqual(sent, [], "nothing changed but the news went out anyway");

  screen = new Uint8Array([9, 9, 9, 9]);
  const different = await watches.check(owner, made.id);
  assert.equal(different.changed, true, "a different picture was not noticed");
  assert.match(different.summary, /progress bar/i);
  assert.equal(sent.length, 1, "the change never reached the channel");

  /* The picture is never kept: only a fingerprint, which is not the bytes. */
  const kept = app.store.sqlite.prepare("SELECT fingerprint FROM screen_watches WHERE id=?").get(made.id);
  assert.match(String(kept.fingerprint), /^[a-f0-9]{64}$/);
  assert.deepEqual(watches.remove(owner, made.id), { removed: made.id });
});

test("E2 the paired listener really answers the question a browser asks before the box may send", async (t) => {
  // widgetOrigin returning the right string is not proof a browser would be let through: the answer
  // has to come back on the paired door with the exact origin on it. This drives that door.
  // node:http rather than fetch, for two reasons: fetch refuses to set a Host header, and its
  // connection pool keeps the process alive after the server is closed.
  const { startServer } = await import("../dist/server.js");
  const root = await mkdtemp(join(tmpdir(), "branch-embeds-cors-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const handle = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const paired = createServer(handle.remoteHandler);
  await new Promise((done) => paired.listen(0, "127.0.0.1", done));
  const port = paired.address().port;
  // In use the paired door answers on the Tailscale address, which is one of the hosts the server
  // accepts. Here it answers on a spare port, so the request carries a host the server accepts:
  // the host check comes first by design, and this test is about what happens after it.
  const host = new URL(handle.url).host;
  t.after(async () => {
    paired.closeAllConnections?.();
    await new Promise((done) => paired.close(done));
    await handle.close(); await app.close(); await discardTemp(root);
  });

  const ask = (origin, onHost = host) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/run", method: "OPTIONS",
      headers: { origin, host: onHost, connection: "close", "access-control-request-method": "POST",
        "access-control-request-headers": "authorization" } },
      (res) => { res.resume(); resolve(res); });
    req.setTimeout(10000, () => req.destroy(new Error("the paired door never answered")));
    req.on("error", reject);
    req.end();
  });

  // Nothing is listed yet, so no page may ask at all.
  const before = await ask("https://notes.example.com");
  assert.equal(before.headers["access-control-allow-origin"], undefined,
    "a page was let through before the owner listed it");

  saveEmbedSettings(app.store, app.runtime.owner,
    { widget: true, widgetSites: ["https://notes.example.com"] });

  const allowed = await ask("https://notes.example.com");
  assert.equal(allowed.statusCode, 204, "the browser's question went unanswered, so the box could not send");
  assert.equal(allowed.headers["access-control-allow-origin"], "https://notes.example.com");
  assert.notEqual(allowed.headers["access-control-allow-origin"], "*", "any page holding the key could send");
  assert.match(allowed.headers["access-control-allow-headers"] ?? "", /authorization/);
  assert.match(allowed.headers["vary"] ?? "", /Origin/);

  const stranger = await ask("https://other.example.com");
  assert.equal(stranger.headers["access-control-allow-origin"], undefined,
    "a page the owner never listed was let through");

  // The host check still comes first: the right origin on a host the server does not accept is refused.
  const wrongHost = await ask("https://notes.example.com", `127.0.0.1:${port}`);
  assert.equal(wrongHost.statusCode, 403);
  assert.equal(wrongHost.headers["access-control-allow-origin"], undefined);
});

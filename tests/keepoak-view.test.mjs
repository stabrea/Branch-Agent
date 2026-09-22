/**
 * Issue #105, slice 1: KeepOak inside Branch. A window of its own, locked to keepoak.com, with its own
 * session; off as it ships; Sign out and switching it off forget the KeepOak sign-in. Electron is
 * stood in for, so nothing here opens a window or starts a program.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { KeepOakView, keepOakHome, keepOakMayShow, keepOakMayUse, keepOakWindowOptions } from "../dist/desktop/keepoak-view.js";
import { electronKeepOakView, keepOakDisconnectChannel, keepOakOpenChannel, registerKeepOakIpc } from "../dist/desktop/keepoak-ipc.js";
import { keepOakRoute } from "../dist/keepoak.js";
import { openSettingFor } from "./places.mjs";

test("the KeepOak window shows only KeepOak and the sign-in pages it passes through", () => {
  for (const url of ["https://keepoak.com/", "https://keepoak.com/computers/1", "https://www.keepoak.com/x",
    "https://accounts.google.com/o/oauth2/v2/auth?x=1", "https://github.com/login/oauth/authorize", "https://appleid.apple.com/auth/authorize"])
    assert.equal(keepOakMayShow(url), true, url);
  for (const url of ["http://keepoak.com/", "https://keepoak.com.example.com/", "https://evilkeepoak.com/", "https://keepoak.com:8443/",
    "https://app.keepoak.com/", "https://anything.keepoak.com/", // exact addresses only: no sub-domain on trust
    "https://user:pw@keepoak.com/", "https://accounts.google.com/mail", "https://github.com/stabrea/Branch-Agent", "https://example.com/",
    "javascript:alert(1)", "file:///C:/Windows", "not a url"])
    assert.equal(keepOakMayShow(url), false, url);
  for (const permission of ["notifications", "clipboard-sanitized-write", "media", "geolocation", "display-capture", "hid", "usb", "serial", "openExternal", "clipboard-read"])
    assert.equal(keepOakMayUse(permission), false, permission);
});

/** A stand-in for Electron's window, recording what was done to it. */
function fakeWindow({ loadFails = false } = {}) {
  const handlers = {}, contents = {};
  const window = {
    loads: [], shown: 0, hidden: 0, destroyed: false, focused: 0,
    loadURL: async (url) => { window.loads.push(url); if (loadFails) throw new Error("offline"); },
    show: () => { window.shown++; }, focus: () => { window.focused++; }, hide: () => { window.hidden++; },
    destroy: () => { window.destroyed = true; }, isDestroyed: () => window.destroyed,
    on: (event, listener) => { handlers[event] = listener; },
    webContents: { on: (event, listener) => { contents[event] = listener; }, setWindowOpenHandler: (handler) => { window.openHandler = handler; } },
    fire: (event, url) => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; (event === "close" ? handlers.close(e) : contents[event](e, url)); return e.prevented; },
  };
  return window;
}
function viewWith(options = {}) {
  const made = [], outside = [], cleared = [], asked = [];
  const view = new KeepOakView({
    makeWindow: (settings) => { const window = fakeWindow(options); window.settings = settings; made.push(window); return window; },
    openOutside: (url) => { outside.push(url); },
    confirmOutside: async (url) => { asked.push(url); return options.yes ?? true; },
    clearSession: async () => { cleared.push(true); },
  });
  return { view, made, outside, cleared, asked };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("its window has its own session and nothing of Branch in it, and what is not KeepOak opens outside", async () => {
  const { view, made, outside } = viewWith();
  await view.open();
  const window = made[0];
  assert.deepEqual(window.loads, [keepOakHome]);
  assert.equal(window.settings, keepOakWindowOptions);
  assert.deepEqual(window.settings.webPreferences, { partition: "persist:keepoak", nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  assert.equal("preload" in window.settings.webPreferences, false, "no preload: nothing of Branch in the page");
  assert.equal(window.fire("will-navigate", "https://keepoak.com/billing"), false, "KeepOak's own pages stay");
  assert.equal(window.fire("will-navigate", "https://example.com/"), true, "another site does not load here…");
  assert.equal(window.fire("will-redirect", "https://evil.example/"), true, "…nor through a redirect");
  await settle();
  assert.deepEqual(outside, ["https://example.com/", "https://evil.example/"], "…it opens in the person's own browser once they say yes");
  assert.equal(window.fire("will-navigate", "file:///C:/Windows/System32"), true);
  await settle();
  assert.deepEqual(outside, ["https://example.com/", "https://evil.example/"], "and something that is not a web address opens nowhere");
});

test("another site opens in the person's browser only when they say yes", async () => {
  const { view, made, outside, asked } = viewWith({ yes: false });
  await view.open();
  assert.equal(made[0].fire("will-navigate", "https://example.com/"), true);
  await settle();
  assert.deepEqual(asked, ["https://example.com/"], "they are asked");
  assert.deepEqual(outside, [], "no: it stays closed");
});

test("no new windows at all; another site goes to the person's browser once they agree, a program nowhere", async () => {
  const { view, made, outside } = viewWith();
  await view.open();
  const window = made[0];
  assert.deepEqual(window.openHandler({ url: "https://keepoak.com/help" }), { action: "deny" });
  assert.deepEqual(window.loads, [keepOakHome], "not loaded here instead either");
  assert.deepEqual(window.openHandler({ url: "https://example.com/pricing" }), { action: "deny" });
  await settle();
  assert.deepEqual(outside, ["https://example.com/pricing"], "another site: their browser, once they say yes");
  assert.deepEqual(window.openHandler({ url: "ms-settings:privacy" }), { action: "deny" });
  await settle();
  assert.deepEqual(outside, ["https://example.com/pricing"], "a link that would start a program goes nowhere");
  assert.equal(made.length, 1, "no second window");
});

test("closing only hides it, opening again brings the same one back, and Sign out forgets the sign-in", async () => {
  const { view, made, cleared } = viewWith();
  await view.open();
  assert.equal(made[0].fire("close"), true, "closing is turned into hiding");
  assert.equal(made[0].hidden, 1);
  assert.equal(made[0].destroyed, false);
  await view.open();
  assert.equal(made.length, 1, "the same window, where it was");
  assert.equal(made[0].shown, 2);
  await view.disconnect();
  assert.equal(made[0].destroyed, true);
  assert.deepEqual(cleared, [true], "the KeepOak session is cleared");
  await view.open();
  assert.equal(made.length, 2, "a fresh window after signing out");
});

test("offline, the window still opens rather than failing silently", async () => {
  const { view, made } = viewWith({ loadFails: true });
  await view.open();
  assert.equal(made[0].shown, 1);
});

test("the real wiring: KeepOak's session alone, nothing granted or downloaded, and Disconnect clears it all", async () => {
  const calls = [], handlers = {};
  const kept = {
    setPermissionRequestHandler: (fn) => { handlers.request = fn; }, setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    on: (event, fn) => { handlers[event] = fn; },
    clearStorageData: async () => calls.push("storage"), clearCache: async () => calls.push("cache"), clearAuthCache: async () => calls.push("auth"),
  };
  const partitions = [];
  let answer = 1;
  const electron = {
    BrowserWindow: class { constructor(options) { calls.push(["window", options.webPreferences.partition]); electron.made = fakeWindow(); return electron.made; } },
    session: { fromPartition: (partition) => { partitions.push(partition); return kept; } },
    shell: { openExternal: async (url) => calls.push(["outside", url]) },
    dialog: { showMessageBox: async () => ({ response: answer }) },
  };
  const view = await electronKeepOakView(electron);
  assert.deepEqual(partitions, ["persist:keepoak"], "only KeepOak's own session is touched");
  for (const permission of ["notifications", "media", "geolocation"]) {
    let granted = null;
    handlers.request(null, permission, (yes) => { granted = yes; });
    assert.equal(granted, false, permission);
    assert.equal(handlers.check(null, permission), false, permission);
  }
  let stopped = false;
  handlers["will-download"]({ preventDefault() { stopped = true; } });
  assert.equal(stopped, true, "no downloads");
  await view.open();
  assert.deepEqual(calls[0], ["window", "persist:keepoak"]);
  electron.made.fire("will-navigate", "https://example.com/");
  await settle();
  assert.equal(calls.length, 1, "Stay here: nothing opens");
  answer = 0;
  electron.made.fire("will-navigate", "https://example.com/");
  await settle();
  assert.deepEqual(calls[1], ["outside", "https://example.com/"], "Open in my browser: it opens there");
  await view.disconnect();
  assert.deepEqual(calls.slice(2), ["storage", "cache", "auth"], "cookies, storage, cache and saved sign-ins go");
});

/** A stand-in for ipcMain (which refuses a second handler, as Electron does) and Branch's own window. */
function fakeIpc(origin) {
  const handlers = new Map(), removed = [];
  const mainFrame = { url: origin + "/?desktop=1" };
  const window = { webContents: { mainFrame }, on: (event, listener) => { window[event] = listener; } };
  const ipc = {
    handle: (channel, fn) => { if (handlers.has(channel)) throw new Error(`second handler for ${channel}`); handlers.set(channel, fn); },
    removeHandler: (channel) => { removed.push(channel); handlers.delete(channel); },
  };
  const own = { sender: window.webContents, senderFrame: mainFrame };
  return { ipc, window, handlers, removed, own, mainFrame };
}
function fakeViews() {
  const calls = [], made = [];
  const makeView = async () => {
    made.push(true);
    return { open: async () => { calls.push("open"); }, disconnect: async () => { calls.push("disconnect"); }, close: () => { calls.push("close"); } };
  };
  return { calls, made, makeView };
}

test("only Branch's own window may open KeepOak, only while the owner has it on, asked each time", async () => {
  const origin = "http://127.0.0.1:4321";
  const { ipc, window, handlers, own } = fakeIpc(origin);
  const { calls, made, makeView } = fakeViews();
  let on = false, asked = 0;
  registerKeepOakIpc(ipc, window, origin, makeView, async () => { asked++; return on; });
  await assert.rejects(handlers.get(keepOakOpenChannel)(own), /switched off/);
  assert.equal(made.length, 0, "off: KeepOak's session is never made");
  on = true;
  await handlers.get(keepOakOpenChannel)(own);
  await handlers.get(keepOakOpenChannel)(own);
  assert.equal(made.length, 1, "made once, on the first Open allowed");
  on = false; // switched off later in Settings: the next Open is refused, not answered from a stale value
  await assert.rejects(handlers.get(keepOakOpenChannel)(own), /switched off/);
  assert.equal(asked, 4, "the switch is asked on every Open");
  const stranger = { sender: {}, senderFrame: { url: "https://keepoak.com/" } };
  await assert.rejects(handlers.get(keepOakOpenChannel)(stranger), /access denied/);
  await assert.rejects(handlers.get(keepOakDisconnectChannel)({ sender: window.webContents, senderFrame: { url: "https://evil.example/" } }), /access denied/);
  await handlers.get(keepOakDisconnectChannel)(own);
  assert.deepEqual(calls, ["open", "open", "disconnect"]);
});

test("while off, only an explicit Disconnect touches KeepOak's session; a new window takes the channels over; closing twice is harmless", async () => {
  const origin = "http://127.0.0.1:4321";
  const first = fakeIpc(origin);
  const views = fakeViews();
  registerKeepOakIpc(first.ipc, first.window, origin, views.makeView, async () => false);
  assert.equal(views.made.length, 0, "registering makes nothing");
  await first.handlers.get(keepOakDisconnectChannel)(first.own);
  assert.equal(views.made.length, 1, "Disconnect may make it, to clear it");
  assert.deepEqual(views.calls, ["disconnect"]);
  // Branch's window is made again (the same ipcMain): the new handlers replace the old ones.
  const again = { ...first.window, webContents: { mainFrame: first.mainFrame }, on: (event, listener) => { again[event] = listener; } };
  const later = fakeViews();
  registerKeepOakIpc(first.ipc, again, origin, later.makeView, async () => true);
  await first.handlers.get(keepOakOpenChannel)({ sender: again.webContents, senderFrame: first.mainFrame });
  assert.deepEqual(later.calls, ["open"], "the new window's handlers answer");
  first.window.closed(); // the old window's close frees nothing of the new window's…
  await first.handlers.get(keepOakOpenChannel)({ sender: again.webContents, senderFrame: first.mainFrame });
  assert.deepEqual(later.calls, ["open", "open"], "…which still answers");
  again.closed();
  again.closed(); // …and closing twice is harmless
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(later.calls, ["open", "open", "close"], "closed once");
  assert.equal(first.handlers.size, 0, "the channels are free again");
});

async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-keepoak-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (body, key = server.token) => {
    const response = await fetch(server.url + "/api/keepoak", { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, call };
}

test("the switch ships off, is the owner's alone, and a short-lived key can neither read nor change it", async (t) => {
  const { app, call } = await branch(t);
  assert.deepEqual((await call()).body, { on: false });
  assert.deepEqual((await call({ on: true })).body, { on: true });
  assert.deepEqual((await call()).body, { on: true });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call(undefined, key)).status));
  assert.ok([401, 403].includes((await call({ on: false }, key)).status));
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call()).status, 200);
  assert.notEqual((await call({ on: false })).status, 200);
  for (const method of ["GET", "POST"])
    await assert.rejects(keepOakRoute(app.store, app.runtime.owner, method, async () => ({ on: false })), /^Error: KeepOak inside Branch belongs to the owner/);
  app.store.profiles.switch({ profileId: null });
  assert.deepEqual((await call()).body, { on: true }, "nothing was changed");
});

async function page(t, { desktop }) {
  const { chromium } = await import("playwright");
  const branchApp = await branch(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const tab = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  if (desktop) await tab.addInitScript(() => {
    globalThis.__keepoak = [];
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "current", message: "", progress: null }), modelSettings: async () => ({}), openExternal: async () => true,
      openKeepOak: async () => { globalThis.__keepoak.push("open"); return true; },
      disconnectKeepOak: async () => { globalThis.__keepoak.push("disconnect"); return true; },
    };
  });
  await tab.goto(branchApp.server.url);
  await tab.getByLabel("Session token", { exact: true }).fill(branchApp.server.token);
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await tab.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { ...branchApp, tab, errors };
}

test("off, there is no KeepOak entry; on, the sidebar opens it, and off again signs out and takes it away", async (t) => {
  const { tab, errors } = await page(t, { desktop: true });
  await openSettingFor(tab, "#keepoak-card");
  assert.equal(await tab.locator("#keepoak-on").isChecked(), false, "ships off");
  assert.equal(await tab.locator("#keepoak-rail").count(), 0, "no KeepOak entry while off");
  await tab.locator("#keepoak-on").check();
  await tab.locator("#keepoak-rail").waitFor({ state: "attached" });
  await tab.locator("#keepoak-open").click();
  await tab.waitForFunction(() => globalThis.__keepoak.includes("open"));
  await tab.locator("#keepoak-signout").click();
  await tab.waitForFunction(() => globalThis.__keepoak.includes("disconnect"));
  await tab.waitForFunction(() => /Signed out of KeepOak/.test(document.querySelector("#keepoak-card")?.innerText ?? ""));
  await tab.evaluate(() => { globalThis.__keepoak.length = 0; });
  await tab.locator("#keepoak-on").uncheck();
  await tab.waitForFunction(() => globalThis.__keepoak.includes("disconnect"));
  await tab.waitForFunction(() => !document.querySelector("#keepoak-rail"));
  assert.deepEqual(errors, []);
});

test("in a plain browser, switched on, it says KeepOak opens in the desktop app and adds no entry", async (t) => {
  const { tab, call, errors } = await page(t, { desktop: false });
  await call({ on: true });
  await tab.evaluate(() => globalThis.branchKeepOak.refresh());
  await openSettingFor(tab, "#keepoak-card");
  await tab.waitForFunction(() => /opens in the Branch desktop app/.test(document.querySelector("#keepoak-card")?.innerText ?? ""));
  assert.equal(await tab.locator("#keepoak-rail").count(), 0);
  assert.equal(await tab.locator("#keepoak-open").count(), 0);
  assert.deepEqual(errors, []);
});

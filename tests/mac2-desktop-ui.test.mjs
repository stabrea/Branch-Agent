import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveDesktopSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { DesktopBanner, noBannerRefusal, screenControlParts } from "../dist/integrations/desktop-banner.js";
import { DesktopScriptRunner } from "../dist/integrations/desktop-script.js";
import { bannerPage, bannerWindowOptions, electronBannerWindow, stopAddress } from "../dist/desktop/banner-window.js";
import { VoiceService, systemVoiceWords, ttsRouteFor } from "../dist/voice-service.js";
import { microphoneHelp, systemVoices, voicePlan, whereAudioGoes } from "../dist/voice-api.js";
import { VoiceSettingsSchema } from "../dist/voice.js";
import { keychainApi, permissionsContext } from "../dist/keychain-api.js";

/**
 * Wave mac2: the Stop notice, the voice list and the permission screens on a Mac and on Linux.
 * Every window here is a stand-in object and every program a function that records what it was
 * asked: nothing is shown, spoken, or asked of the real Keychain.
 */
const sayVoices = "Albert              en_US    # Hello! My name is Albert.\nAmélie              fr_CA    # Bonjour, je m’appelle Amélie.\n";

/**
 * A fresh app in a temporary folder. Whatever else a test opens (a server, a browser, a screen
 * control) is handed to `closeFirst`, so one hook closes it, then the app, then deletes the folder.
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mac2-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } },
  });
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await app.close();
    await discardTemp(root);
  });
  return { app, root, closeFirst: (close) => closers.push(close) };
}

/** An app with its server and a headless browser page, all closed before the folder goes. */
async function pageFixture(t) {
  const f = await fixture(t);
  const server = await startServer(f.app, { dataDir: join(f.root, "data"), port: 0 });
  f.closeFirst(() => server.close());
  const browser = await chromium.launch({ headless: true });
  f.closeFirst(() => browser.close());
  return { ...f, server, page: await browser.newPage() };
}

/** A pretend macOS runner: every call is written down and answered with one window. */
function fakeMac() {
  const calls = [];
  const exec = async (executable, args) => {
    calls.push({ executable, args });
    return { status: "completed", exitCode: 0, stderr: "",
      stdout: JSON.stringify({ ok: true, result: { windows: [{ handle: "501:1", title: "Notes", program: "Notes", processId: 501, minimised: false, width: 800, height: 600 }] } }) };
  };
  return { calls, exec };
}

/** A pretend notice window, as the desktop app's main process would make one. */
function fakeWindowFactory({ showing = true, fail = false } = {}) {
  const made = [];
  const factory = async (closed) => {
    if (fail) throw new Error("no display");
    const window = { showing, closedBy: null, pressStop() { this.showing = false; closed(); }, close() { this.showing = false; this.closedBy = "hide"; closed(); } };
    made.push(window);
    return window;
  };
  return { made, factory };
}

async function screenFixture(t, window) {
  const { app, closeFirst } = await fixture(t);
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const fake = fakeMac();
  const parts = screenControlParts({ platform: "darwin", posix: { exec: fake.exec }, ...(window ? { window } : {}) });
  const control = new DesktopControl(app.store, parts);
  closeFirst(() => control.close());
  const run = await app.runtime.run({ prompt: "look at my screen" });
  return { app, control, parts, fake, run, context: app.runtime.context({ runId: run.id }) };
}

/* ---------- the Stop notice ---------- */

test("without the desktop app a Mac or Linux refuses screen control in one sentence and starts nothing", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const { app, closeFirst } = await fixture(t);
    saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
    const fake = fakeMac();
    const control = new DesktopControl(app.store, screenControlParts({ platform, posix: { exec: fake.exec, env: { DISPLAY: ":1" }, locate: () => "/usr/bin/xdotool" } }));
    closeFirst(() => control.close());
    const run = await app.runtime.run({ prompt: "list windows" });
    await assert.rejects(control.windows({ action: "list" }, app.runtime.context({ runId: run.id })), (error) => error.message === noBannerRefusal);
    assert.equal(fake.calls.length, 0, `${platform}: nothing was started`);
  }
  assert.match(noBannerRefusal, /from the Branch Agent app/);
});

test("the screen is used only while the notice is really up, and closing it is Stop", async (t) => {
  const windows = fakeWindowFactory();
  const f = await screenFixture(t, windows.factory);
  // Straight to the runner, with no notice, nothing happens.
  await assert.rejects(f.parts.runner.run("windows", {}, AbortSignal.timeout(5000)), /only uses your screen while its notice/);
  assert.equal(f.fake.calls.length, 0);

  const listed = await f.control.windows({ action: "list" }, f.context);
  assert.equal(listed.windows[0].title, "Notes");
  assert.equal(windows.made.length, 1, "one notice was put up");
  assert.equal(f.parts.banner.visible, true);
  assert.equal(f.fake.calls[0].executable, "/usr/bin/osascript");
  await f.control.windows({ action: "list" }, f.context);
  assert.equal(windows.made.length, 1, "the same notice stays up for the next action");

  windows.made[0].pressStop();
  assert.equal(f.parts.banner.visible, false);
  assert.ok(f.app.store.events(f.run.id).some((event) => event.kind === "desktop.stopped"), "Stop is written down");
  const before = f.fake.calls.length;
  await assert.rejects(f.control.windows({ action: "list" }, f.context), /You pressed Stop/);
  assert.equal(f.fake.calls.length, before, "nothing ran after Stop");
});

test("the notice coming down at the end of a task is not a Stop, and the runner goes quiet again", async (t) => {
  const windows = fakeWindowFactory();
  const f = await screenFixture(t, windows.factory);
  await f.control.windows({ action: "list" }, f.context);
  await f.control.closeRun(f.context);
  assert.equal(windows.made[0].closedBy, "hide");
  assert.equal(f.parts.banner.visible, false);
  assert.ok(!f.app.store.events(f.run.id).some((event) => event.kind === "desktop.stopped"), "taking it down is not Stop");
  await assert.rejects(f.parts.runner.run("windows", {}, AbortSignal.timeout(5000)), /only uses your screen while its notice/);
});

test("a notice that fails, or never shows, keeps the screen untouched", async (t) => {
  for (const options of [{ fail: true }, { showing: false }]) {
    const windows = fakeWindowFactory(options);
    const f = await screenFixture(t, windows.factory);
    await assert.rejects(f.control.windows({ action: "list" }, f.context), /could not be shown, so Branch has not touched your screen/);
    assert.equal(f.fake.calls.length, 0);
    assert.equal(f.parts.banner.visible, false);
    if (options.showing === false) assert.equal(windows.made[0].closedBy, "hide", "the half-made notice is closed");
  }
});

test("Windows keeps the notice it always had", () => {
  const parts = screenControlParts({ platform: "win32", window: async () => { throw new Error("never asked"); } });
  assert.ok(parts.runner instanceof DesktopScriptRunner);
  assert.ok(parts.banner instanceof DesktopBanner);
  assert.equal(parts.banner.visible, false);
});

/* ---------- the Electron window behind the notice ---------- */

function fakeHost({ appears = true } = {}) {
  const listeners = {};
  const host = {
    options: null, destroyed: false, visible: false, calls: [], navigate: null,
    isDestroyed() { return this.destroyed; },
    emit(name) { for (const listener of listeners[name] ?? []) listener(); },
    on(name, listener) { (listeners[name] ??= []).push(listener); },
    once(name, listener) { const wrapped = () => { listeners[name] = listeners[name].filter((one) => one !== wrapped); listener(); }; this.on(name, wrapped); },
    showInactive() { this.calls.push("showInactive"); if (appears) { this.visible = true; this.emit("show"); } },
    close() { this.calls.push("close"); this.destroyed = true; this.emit("closed"); },
    destroy() { this.calls.push("destroy"); this.destroyed = true; },
    setAlwaysOnTop(flag, level) { this.calls.push(`top:${flag}:${level}`); },
    setVisibleOnAllWorkspaces(flag) { this.calls.push(`everywhere:${flag}`); },
    async loadURL(url) { this.url = url; },
    webContents: {
      on: (name, listener) => { if (name === "will-navigate") host.navigate = listener; },
      setWindowOpenHandler: (handler) => { host.openHandler = handler; },
    },
  };
  return host;
}

test("the Electron notice is a locked-down frameless window whose Stop link closes it", async () => {
  const host = fakeHost();
  let closedCount = 0;
  const factory = electronBannerWindow({ create: (options) => { host.options = options; return host; },
    workArea: () => ({ x: 0, y: 25, width: 1440, height: 875 }), platform: "darwin" });
  const window = await factory(() => { closedCount += 1; });
  assert.equal(window.showing, true);
  assert.deepEqual({ frame: host.options.frame, top: host.options.alwaysOnTop, x: host.options.x, y: host.options.y },
    { frame: false, top: true, x: 490, y: 37 });
  assert.deepEqual(host.options.webPreferences,
    { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, partition: "branch-banner" });
  assert.ok(host.calls.includes("top:true:screen-saver") && host.calls.includes("everywhere:true"));
  assert.ok(host.calls.includes("showInactive"), "it does not take the keyboard away from the window being worked");
  assert.deepEqual(host.openHandler(), { action: "deny" });
  const page = decodeURIComponent(host.url.replace(/^data:text\/html;charset=utf-8,/, ""));
  assert.match(page, /default-src 'none'/);
  assert.ok(page.includes(`href="${stopAddress}"`) && !/<script/i.test(page));

  let prevented = 0;
  host.navigate({ preventDefault: () => { prevented += 1; } }, "https://example.com/");
  assert.equal(closedCount, 0, "going anywhere else is refused and is not Stop");
  host.navigate({ preventDefault: () => { prevented += 1; } }, stopAddress);
  assert.equal(prevented, 2, "the Stop address is never visited either");
  assert.equal(closedCount, 1);
  assert.equal(window.showing, false);
});

test("an Electron notice that never appears is destroyed and counts as not shown", async () => {
  const host = fakeHost({ appears: false });
  const factory = electronBannerWindow({ create: () => host, workArea: () => ({ x: 0, y: 0, width: 800, height: 600 }), platform: "linux", showTimeoutMs: 30 });
  await assert.rejects(factory(() => undefined), /did not appear/);
  assert.ok(host.calls.includes("destroy"));
  assert.ok(!host.calls.includes("everywhere:true"), "the all-desktops setting is a Mac one");
  // Through the banner, the same failure is the plain refusal.
  const banner = new DesktopBanner(new DesktopScriptRunner(), undefined, { platform: "linux", window: factory });
  await assert.rejects(banner.show(() => undefined), /could not be shown/);
});

test("the Electron notice and the banner together: Stop in the window reaches the task", async () => {
  const host = fakeHost();
  const banner = new DesktopBanner(new DesktopScriptRunner(), undefined, {
    platform: "darwin", window: electronBannerWindow({ create: () => host, workArea: () => ({ x: 0, y: 0, width: 800, height: 600 }), platform: "darwin" }),
  });
  let stopped = 0;
  await banner.show(() => { stopped += 1; });
  assert.equal(banner.visible, true);
  host.navigate({ preventDefault() {} }, stopAddress);
  assert.equal(stopped, 1);
  assert.equal(banner.visible, false);
  assert.equal(bannerWindowOptions({ x: 0, y: 0, width: 460, height: 100 }).x, 0);
  assert.match(bannerPage(), /^data:text\/html/);
});

/* ---------- voice ---------- */

test("the voice service is told which computer it is on, and never starts the real say", async (t) => {
  const { app } = await fixture(t);
  const started = [];
  const runProgram = async (file, args) => {
    started.push({ file, args });
    if (args.includes("?")) return sayVoices;
    const out = args[args.indexOf("-o") + 1];
    await writeFile(out, Buffer.from("RIFF0000WAVE"));
    return "";
  };
  const voice = new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch,
    { platform: "darwin", runProgram, locate: (name) => (name === "say" ? "/pretend/say" : null) });
  assert.equal(voice.platform, "darwin");
  const listed = await systemVoices(voice);
  assert.deepEqual(listed.windows, ["Albert", "Amélie"]);
  assert.deepEqual(listed.system, listed.windows, "the neutral name carries the same list");
  assert.match(listed.label, /^Your computer's own voice/);
  assert.match(listed.microphoneHelp, /System Settings, Privacy & Security, Microphone/);
  const spoken = await voice.speak("local", { text: "hello", voice: "Albert", speed: 1 });
  assert.equal(spoken.route, "windows");
  assert.equal(started.at(-1).file, "/pretend/say");
  assert.ok(started.every((call) => call.file === "/pretend/say"), "only the stand-in was started");
  const deps = { store: app.store, models: app.runtime.models, owner: "local", voice, policy: new NetworkPolicy({}), fetch };
  assert.match(voicePlan(deps).readAloud.reason, /your computer's own voice/);

  // An older caller that hands in only a runner still gets it used.
  const older = new VoiceService(app.store, app.runtime.models, new NetworkPolicy({}), fetch, async () => { throw new Error("stand-in"); });
  assert.equal(older.platform, process.platform);
});

test("owner-facing voice words: Windows keeps its own, every other computer says its own voice", () => {
  const settings = VoiceSettingsSchema.parse({});
  assert.equal(ttsRouteFor(settings, undefined, "win32").reason, "Higher-quality voice is switched off, so the free Windows voice is used");
  assert.equal(ttsRouteFor({ ...settings, ttsRoute: "windows" }, undefined, "win32").reason, "You chose the voice that comes with Windows");
  assert.equal(ttsRouteFor({ ...settings, useProviderVoice: true }, undefined, "win32").reason, "No connected model offers this, so the free Windows voice is used");
  for (const platform of ["darwin", "linux"]) {
    assert.equal(ttsRouteFor({ ...settings, ttsRoute: "windows" }, undefined, platform).reason, "You chose your computer's own voice");
    assert.doesNotMatch(ttsRouteFor(settings, undefined, platform).reason, /Windows/);
    assert.doesNotMatch(whereAudioGoes("local", "windows", platform), /Windows/);
    assert.doesNotMatch(whereAudioGoes("openai", "windows", platform), /Windows/);
    assert.doesNotMatch(microphoneHelp(platform), /Windows/);
  }
  assert.equal(whereAudioGoes("local", "windows", "win32"),
    "Nothing leaves this computer: recordings are written out here, and replies are read aloud by a voice that comes with Windows.");
  assert.match(whereAudioGoes("openai", "windows", "win32"), /a voice that comes with Windows, which costs nothing/);
  assert.match(microphoneHelp("win32"), /in Windows settings/);
  assert.equal(systemVoiceWords("win32").chosen, "the voice that comes with Windows");
});

test("voice.js lists the computer's own voices only when asked, and reads its token itself", async () => {
  const source = await readFile(new URL("../public/voice.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/voice\/voices/);
  assert.match(source, /data\.system/);
  const onLoad = source.slice(source.lastIndexOf("// Initialize when voices are loaded"));
  assert.doesNotMatch(onLoad.replace(/addEventListener\("focus"[^\n]*/g, ""), /void loadSystemVoices\(\)/, "the voices are not asked for when the page opens");
  assert.doesNotMatch(source, /"Bearer " \+ token\b/, "app.js's token is not visible to this classic script");
  assert.doesNotMatch(source, /innerHTML/);
});

/* ---------- the permissions card and the Keychain list ---------- */

test("the Keychain list keeps names only, is off by default, and exists only on a Mac", async (t) => {
  const { app } = await fixture(t);
  const none = async () => ({});
  const first = await keychainApi(app.store, "local", "GET", none, "darwin");
  assert.equal(first.enabled, false);
  assert.deepEqual(first.entries, []);
  assert.equal(first.available, true);
  assert.equal((await keychainApi(app.store, "local", "GET", none, "linux")).available, false);
  const saved = await keychainApi(app.store, "local", "POST",
    async () => ({ enabled: true, entries: [{ name: "github", service: "api.github.com", account: "me" }] }), "darwin");
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.references, { github: "secret://keychain/github" });
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "y", password: "hunter2" }] }), "darwin"), /password|Unrecognized/i);
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "-w" }] }), "darwin"), /cannot start with a dash/);
  await assert.rejects(keychainApi(app.store, "local", "POST",
    async () => ({ entries: [{ name: "x", service: "a" }, { name: "x", service: "b" }] }), "darwin"), /same name/);
  await assert.rejects(keychainApi(app.store, "local", "DELETE", none, "darwin"), /not something Branch can do/);
  assert.equal((await keychainApi(app.store, "local", "GET", none, "darwin")).entries.length, 1, "a refused save changes nothing");
  assert.ok(!JSON.stringify(app.store.get("settings", "local", "keychain-entries")).includes("hunter2"));
});

test("the permissions context names the computer and, on Linux, the session", () => {
  assert.deepEqual(permissionsContext("darwin", {}), { platform: "darwin" });
  assert.deepEqual(permissionsContext("win32", {}), { platform: "win32" });
  assert.deepEqual(permissionsContext("linux", { WAYLAND_DISPLAY: "wayland-0" }), { platform: "linux", session: "wayland" });
  assert.deepEqual(permissionsContext("linux", { DISPLAY: ":0" }), { platform: "linux", session: "x11" });
  assert.deepEqual(permissionsContext("linux", {}), { platform: "linux", session: "none" });
});

test("the routes answer through the server with the session token only", async (t) => {
  const { app, root, closeFirst } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closeFirst(() => server.close());
  const call = (path, init = {}) => fetch(server.url + path, { ...init, headers: { authorization: `Bearer ${server.token}`, ...(init.headers ?? {}) } });
  assert.equal((await fetch(server.url + "/api/keychain/settings")).status, 401);
  const permissions = await (await call("/api/os-permissions")).json();
  assert.equal(permissions.platform, process.platform);
  assert.ok(Array.isArray(permissions.permissions));
  const saved = await call("/api/keychain/settings", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, entries: [{ name: "npm", service: "registry.npmjs.org" }] }) });
  assert.equal(saved.status, 200);
  assert.equal((await (await call("/api/keychain/settings")).json()).entries[0].name, "npm");
  const plan = await (await call("/api/voice/plan")).json();
  assert.equal(plan.systemVoice.label.includes("Windows"), process.platform === "win32");
  assert.equal(plan.systemVoice.platform, process.platform);
  const script = await fetch(server.url + "/os-permissions.js");
  assert.equal(script.status, 200);
  const source = await script.text();
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
});

test("the cards appear under the screen-control card on a Mac or Linux, and a settings link opens only on a click", async (t) => {
  const { server, page } = await pageFixture(t);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The page is told it is a Mac, whatever this computer is, and the app's opener is a recorder.
  await page.route("**/api/os-permissions", (route) => route.fulfill({ json: {
    platform: "darwin",
    permissions: [
      { capability: "screen", state: "unknown", allowed: true, message: "", explanation: "Lets Branch take a picture.",
        settingsLink: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" },
      { capability: "camera", state: "unknown", allowed: true, message: "", explanation: "Lets Branch use the camera.", settingsLink: "javascript:alert(1)" },
    ],
  } }));
  await page.route("**/api/keychain/settings", (route) => route.fulfill({ json: {
    enabled: true, available: true, references: {},
    entries: [{ name: "a-rather-long-name-for-one-entry-here", service: "registry.example-company-with-a-long-name.com", account: "someone@example.com", note: "" }],
  } }));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  // Drawn once already at sign-in, under the screen-control card.
  await page.locator("#os-permissions-card").waitFor({ state: "attached" });
  // Only now is the page given a stand-in for the app's opener, so sign-in is not the desktop app's.
  await page.evaluate(() => {
    globalThis.opened = [];
    globalThis.branchDesktop = { openExternal: async (url) => { globalThis.opened.push(url); } };
  });
  await page.evaluate(() => globalThis.branchOsPermissions.render());
  const card = page.locator("#os-permissions-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => document.getElementById("desktop-card").nextElementSibling?.id), "os-permissions-card");
  assert.equal(await card.getAttribute("hidden"), null);
  assert.equal(await page.evaluate(() => globalThis.opened.length), 0, "nothing opened by itself");
  const buttons = card.locator("button", { hasText: "Open System Settings" });
  assert.equal(await buttons.count(), 2);
  await buttons.nth(0).evaluate((button) => button.click());
  await buttons.nth(1).evaluate((button) => button.click());
  await page.waitForFunction(() => document.getElementById("os-permissions-status").textContent.length > 0);
  assert.deepEqual(await page.evaluate(() => globalThis.opened),
    ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], "only a real settings page is opened");
  assert.equal(await page.locator("#keychain-card").getAttribute("hidden"), null);

  // Settings at 400 px: nothing goes sideways, and both cards are really on the screen.
  await page.setViewportSize({ width: 400, height: 800 });
  const nav = page.locator('.nav[data-view="settings"]').first();
  if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
  await nav.click();
  await page.evaluate(() => document.body.classList.remove("rail-open"));
  await page.locator("#os-permissions-card").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#os-permissions-card").isVisible(), true);
  const sideways = await page.evaluate(() => ["os-permissions-card", "keychain-card"].map((id) => {
    const card = document.getElementById(id);
    return { id, wide: card.scrollWidth - card.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
  }).filter((one) => one.wide > 0 || one.page > 0));
  assert.deepEqual(sideways, []);

  // Every word on the cards is behind a key, so French replaces all of them.
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  assert.equal(await page.locator("#os-permissions-card h2").textContent(), "Ce que cet ordinateur autorise");
  assert.equal(await page.locator("#keychain-card h2").textContent(), "Mots de passe du trousseau de votre Mac");
  assert.equal(await card.locator("button[data-t='action.open-system-settings']").first().textContent(), "Ouvrir les Réglages Système");
  assert.equal(await page.locator("#keychain-service").getAttribute("placeholder"), "par exemple api.github.com");
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#os-permissions-card, #keychain-card")]
    .flatMap((card) => [...card.querySelectorAll("h2, button, label, span, .subtle")])
    .filter((node) => !node.closest("[data-t]") && !node.querySelector("[data-t]") && node.id !== "os-permissions-status" && node.id !== "keychain-status"
      && !node.closest(".card-row p.subtle:not([data-t])") && node.textContent.trim())
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed.filter((text) => !text.includes("·") && !text.includes("example")), [], "these words are not behind a key");
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("en"); });
  assert.deepEqual(errors, []);
});

test("on Windows neither card is shown", async (t) => {
  const { server, page } = await pageFixture(t);
  await page.route("**/api/os-permissions", (route) => route.fulfill({ json: { platform: "win32", permissions: [] } }));
  await page.route("**/api/keychain/settings", (route) => route.fulfill({ json: { enabled: false, entries: [], available: false, references: {} } }));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchOsPermissions.render());
  assert.equal(await page.locator("#os-permissions-card").getAttribute("hidden"), "");
  assert.equal(await page.locator("#keychain-card").getAttribute("hidden"), "");
});

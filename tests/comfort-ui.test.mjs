/**
 * R17-S-C in the window: the comfort cards open where docs/places.md says, every control has its
 * own sentence, and each setting does what it says — rebound shortcuts, vim keys, the status line,
 * message times, the sound and "banner only", push-to-talk and updating by itself. No sound is
 * played, no notification shown, no microphone opened and nothing installed: those go through fakes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readComfort, saveComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openPlace, openSettingFor, closeSettings } from "./places.mjs";

const homes = {
  "comfort-keys-card": "#lx-page-general",
  "comfort-files-card": "#lx-page-general",
  "comfort-display-card": "#lx-page-appearance",
  "comfort-notify-card": "#lx-page-notifications",
  "comfort-updates-card": "#lx-page-about",
  "comfort-voice-card": "#lx-page-voice",
  "comfort-browser-card": "#lx-page-computer",
  "comfort-network-card": "#lx-page-computer",
};

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-comfort-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Nothing may be heard, shown by the computer, or recorded.
  await page.addInitScript(() => {
    globalThis.__sounds = [];
    globalThis.__notified = [];
    globalThis.Notification = class { constructor(title) { globalThis.__notified.push(title); } static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("no microphone in tests"));
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#comfort-network-card").waitFor({ state: "attached" });
  await page.evaluate(() => { globalThis.branchComfort.player = (kind) => globalThis.__sounds.push(kind); });
  return { app, page, errors };
}
const refresh = (page) => page.evaluate(() => globalThis.branchComfort.refresh());

const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

test("each comfort card is in its home, says what it is for, and every control has its own sentence", async (t) => {
  const { app, page, errors } = await openApp(t);
  for (const [id, host] of Object.entries(homes)) {
    await page.waitForFunction(([card, slot]) => document.getElementById(card)?.closest(slot), [id, host]);
    await openSettingFor(page, `#${id}`);
    assert.ok(await page.locator(`#${id}`).isVisible(), `${id} can be seen on its page`);
    assert.equal(await page.locator(`#${id} > h2 + p.subtle`).count(), 1, `${id} says what it is for`);
    assert.deepEqual(await undescribed(page, id), [], `${id} has a control without a sentence`);
  }
  await closeSettings(page);
  await openPlace(page, "customize:connections");
  await page.waitForFunction(() => document.getElementById("comfort-mcp-card")?.offsetParent);
  assert.deepEqual(await undescribed(page, "comfort-mcp-card"), []);

  await openSettingFor(page, "#comfort-keys-card");
  await page.locator("#comfort-vim").selectOption("on");
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").vim, true);
  await page.locator("#comfort-keys-card").getByRole("button", { name: "Put back as shipped" }).click();
  await page.locator("#comfort-keys-card [role=status]").filter({ hasText: "Put back" }).waitFor();
  assert.equal(readComfort(app.store, "local", "keys").vim, false);

  await openSettingFor(page, "#comfort-network-card");
  await page.locator("#comfort-proxy").fill("http://sam:pw@proxy.example.com:8080");
  await page.locator("#comfort-network-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#comfort-network-card [role=status]").filter({ hasText: "user name or password" }).waitFor();
  assert.equal(readComfort(app.store, "local", "network").proxy, null);
  assert.deepEqual(errors, []);
});

test("R17-S15: a rebound shortcut works, the old keys stop, and vim keys move and edit in the message box", async (t) => {
  const { app, page } = await openApp(t);
  saveComfort(app.store, "local", "keys", { newConversation: "Ctrl+J", vim: true });
  await refresh(page);
  await page.evaluate(() => { globalThis.__newClicks = 0; document.getElementById("rail-new").addEventListener("click", () => { globalThis.__newClicks += 1; }); });
  await page.keyboard.press("Control+n");
  assert.equal(await page.evaluate(() => globalThis.__newClicks), 0, "Ctrl+N no longer starts a conversation");
  await page.keyboard.press("Control+j");
  assert.equal(await page.evaluate(() => globalThis.__newClicks), 1, "Ctrl+J does");

  const box = page.locator("#prompt");
  await box.click();
  await box.pressSequentially("hello world");
  await page.keyboard.press("Escape");
  assert.equal(await box.getAttribute("data-vim-mode"), "normal");
  assert.equal(await page.locator("#comfort-vim-mode").textContent(), "Moving (vim)");
  for (const key of ["0", "x", "w", "x"]) await page.keyboard.press(key);
  assert.equal(await box.inputValue(), "ello orld", "0 goes to the start, x deletes, w goes to the next word");
  await page.keyboard.press("i");
  await page.keyboard.type("W");
  assert.equal(await box.inputValue(), "ello World", "i goes back to typing");
  await page.keyboard.press("Escape");
  await page.keyboard.press("d");
  await page.keyboard.press("d");
  assert.equal(await box.inputValue(), "", "dd removes the line");
  const moved = await page.evaluate(() => {
    const { vimMotion } = globalThis.branchComfort;
    return [vimMotion("ab\ncd", 4, "k"), vimMotion("ab\ncd", 1, "j"), vimMotion("ab cd", 4, "b"), vimMotion("ab cd", 0, "$")];
  });
  assert.deepEqual(moved, [1, 4, 3, 4]);
});

test("R17-S16: the status line shows the pieces picked, and each message shows its time", async (t) => {
  const { app, page } = await openApp(t);
  assert.equal(await page.locator("#comfort-status").isVisible().catch(() => false), false, "as shipped there is no extra line");
  saveComfort(app.store, "local", "display", { statusLine: ["model", "context", "cost"], timestamps: true });
  await refresh(page);
  await page.locator("#prompt").fill("Hello there");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator("#conversation .message.assistant").first().waitFor();
  await page.evaluate(() => globalThis.branchComfort.refreshStatus());
  await page.waitForFunction(() => document.querySelectorAll("#conversation .message .message-time").length >= 2);
  const line = await page.locator("#comfort-status").textContent();
  assert.match(line, /^Offline demonstration · \d+% of the room used · /);
  const times = await page.locator("#conversation .message-time").evaluateAll((nodes) => nodes.map((node) => node.dateTime));
  assert.ok(times.every((value) => !Number.isNaN(Date.parse(value))), JSON.stringify(times));
  saveComfort(app.store, "local", "display", { statusLine: null, timestamps: false });
  await refresh(page);
  await page.waitForFunction(() => document.getElementById("comfort-status").hidden && !document.querySelector(".message-time"));
});

test("R17-S17/S18: the owner's sound and banner-only choice, push-to-talk, and the longest recording", async (t) => {
  const { app, page } = await openApp(t);
  assert.equal(await page.evaluate(() => globalThis.branchComfort.attention({ runId: "a" })), "default", "as shipped, the computer is told and nothing is heard");
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), []);
  saveComfort(app.store, "local", "notify", { method: "window", sound: "knock" });
  saveComfort(app.store, "local", "voice", { pushToTalkKey: "F8", maxRecordingSeconds: 30 });
  await refresh(page);
  assert.equal(await page.evaluate(() => globalThis.branchComfort.attention({ runId: "b" })), "handled");
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), ["knock"]);
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /branchComfort\?\.attention\(item\) === "handled"\) continue;\s*if \(typeof Notification/, "the window asks before telling the computer");
  assert.equal(await page.evaluate(() => globalThis.branchComfort.maxRecordingSeconds()), 30);

  await page.evaluate(() => {
    globalThis.__talk = [];
    for (const kind of ["pointerdown", "pointerup"])
      document.getElementById("voice-talk").addEventListener(kind, () => globalThis.__talk.push(kind));
  });
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.down("F8");
  await page.keyboard.down("F8");
  await page.keyboard.up("F8");
  assert.deepEqual(await page.evaluate(() => globalThis.__talk), ["pointerdown", "pointerup"], "holding the key presses Talk once, letting go lets it go");

  await openSettingFor(page, "#comfort-notify-card");
  await page.locator("#comfort-notify-card").getByRole("button", { name: "Try the sound" }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.__sounds), ["knock", "knock"]);
});

test("R17-S17: updating by itself looks once, and installs only through the Update button's own path", async (t) => {
  const { app, page } = await openApp(t);
  await page.evaluate(() => {
    globalThis.__desktop = [];
    /* Only what the automatic update asks counts here. The Updates card also reads the updater's
       status whenever the page redraws, which can come at any moment and is not a look for an
       update, so a status read counts only when it comes from autoUpdate itself. */
    const fromAutoUpdate = () => /\bautoUpdate\b/.test(new Error().stack ?? "");
    window.branchDesktop = {
      updateStatus: async () => { if (fromAutoUpdate()) globalThis.__desktop.push("status"); return { phase: globalThis.__phase ?? "idle", message: "" }; },
      checkForUpdates: async () => { globalThis.__desktop.push("check"); return { phase: "current", message: "" }; },
      installUpdate: async () => { globalThis.__desktop.push("install"); return { phase: "ready", message: "" }; },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  });
  /* The check's own settling point: its settings have been read. Asserting that nothing was
     looked for is only meaningful once the answer to "did the owner want this?" is in. */
  await refresh(page);
  await page.evaluate(() => globalThis.branchComfort.autoUpdate());
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop), [], "off: nothing is looked for");
  saveComfort(app.store, "local", "notify", { autoUpdate: "check" });
  await refresh(page);
  await page.waitForFunction(() => globalThis.__desktop.includes("check"));
  await page.evaluate(() => { globalThis.__desktop = []; return globalThis.branchComfort.autoUpdate(); });
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop), ["status"], "looked for less than a day ago");
  saveComfort(app.store, "local", "notify", { autoUpdate: "install" });
  await page.evaluate(() => { globalThis.__desktop = []; globalThis.__phase = "available"; });
  await refresh(page);
  await page.waitForFunction(() => globalThis.__desktop.includes("install"));
  assert.deepEqual(await page.evaluate(() => globalThis.__desktop.filter((step) => step !== "status")), ["install"]);
  await page.evaluate(() => { globalThis.__desktop = []; globalThis.__phase = undefined; window.branchDesktop = undefined; });
});

test("at 400 px the comfort cards fit without sideways scrolling", async (t) => {
  const { page } = await openApp(t, 400);
  for (const id of ["comfort-keys-card", "comfort-display-card", "comfort-network-card"]) {
    await openSettingFor(page, `#${id}`);
    const box = await page.locator(`#${id}`).evaluate((card) => ({ scroll: card.scrollWidth, client: card.clientWidth }));
    assert.ok(box.scroll <= box.client + 1, `${id} is wider than its card (${box.scroll} > ${box.client})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${id} scrolls the page sideways`);
  }
});

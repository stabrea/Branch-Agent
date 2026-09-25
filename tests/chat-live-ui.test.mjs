/**
 * The chat-app card, reached the way a person reaches it: Customize, then Chat apps. It changes
 * the four switches, says so, and fits a 400-pixel window. Headless browser only; no window opens.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

async function fixture(t, viewport) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-live-ui-"));
  const provider = { name: "chat-live-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  const token = page.getByLabel("Session token", { exact: true });
  await token.waitFor({ state: "visible", timeout: 120000 });
  await token.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("the chat-app card is under Customize, Chat apps, starts off, and saves a change", async (t) => {
  const { app, page, errors } = await fixture(t, { width: 1280, height: 900 });
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  const card = page.locator("#chat-live-form");
  await card.waitFor({ state: "visible" });
  const steering = page.getByLabel("Pass later messages to the task", { exact: true });
  assert.equal(await steering.inputValue(), "off", "a fresh install shows everything off");
  await steering.selectOption("when-needed");
  await card.getByRole("button", { name: "Save chat settings", exact: true }).click();
  await page.locator("#chat-live-state", { hasText: "Saved." }).waitFor();
  assert.equal(app.channels.switches().steering, "when-needed");
  assert.equal(app.channels.switches().commands, "off");
  assert.deepEqual(errors, []);
});

test("the chat-app card fits a 400-pixel window without sideways scrolling", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  const card = page.locator("#chat-live-form");
  await card.waitFor({ state: "visible" });
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#chat-live-form")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 30000 }).then(() => true, () => false);
  assert.ok(fits, "the chat-app card fits inside 400 px");
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(sideways, false);
  assert.deepEqual(errors, []);
});

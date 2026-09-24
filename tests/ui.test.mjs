import test from "node:test";
import { closeSettings, openPlace, openSettingFor } from "./places.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

test("browser UI connects, runs demo, saves memory, and fits mobile viewport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
  });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  /* No model yet is said once, in plain words: practice mode (0.18.1). */
  assert.match(await page.locator("#demo-notice").textContent(), /Practice mode/);
  /* The acorn is off by default and the calm window keeps the side pane away until work runs, so
     both are switched on in Settings (real clicks) to check the artwork. */
  await openSettingFor(page, "#appearance-acorn");
  await page.locator("#appearance-acorn").check();
  await page.locator("#appearance-everything").check();
  await closeSettings(page);
  await verifyArtwork(page);
  /* The welcome card is the greeting on a new workspace; the suggestion chips
     take its place once the owner has chosen how the assistant should think. */
  /* "Try it without an account" finishes first run in one click. */
  await page.getByRole("button", { name: /Try it without an account/ }).click();
  await page.getByRole("button", { name: "Try the file workflow" }).click();
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".message.assistant").waitFor({ timeout: 30000 });
  assert.match(
    await page.locator(".message.assistant").innerText(),
    /wrote, read, and verified/,
  );
  await openPlace(page, "memory");
  await page.getByLabel("Search past conversations", { exact: true }).fill("verified");
  await page.getByRole("button", { name: "Search conversations", exact: true }).click();
  await page.locator("#history-results").getByRole("button", { name: "Read message", exact: true }).first().click();
  await page.locator("#history-message").waitFor({ state: "visible" });
  assert.match(await page.locator("#history-message pre").innerText(), /wrote, read, and verified/);
  await page.getByLabel("Remember something").fill("Browser-created memory");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await page
    .locator("#memory-list h3")
    .filter({ hasText: "Browser-created memory" })
    .waitFor();
  if (process.env.BRANCH_SCREENSHOT_DIR) {
    await mkdir(process.env.BRANCH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-desktop.png"),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  if (process.env.BRANCH_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-mobile.png"),
      fullPage: true,
    });
  assert.deepEqual(errors, []);
});

async function verifyArtwork(page) {
  /* The strip's mark and the greeting's mascot, both loaded. The page has no `.brand-icon` any more,
     so a check of that alone passed on nothing at all; the two marks must be there to be checked. */
  await page.waitForFunction(() => {
    const marks = [...document.querySelectorAll(".strip-brand img, .welcome-mascot")];
    return marks.length === 2 && marks.every((image) => image.complete && image.naturalWidth === 128
      && new URL(image.src).pathname === "/assets/mascot-128.png");
  }, undefined, { timeout: 15000 });
  await page.waitForFunction(() => {
    const canvas = document.getElementById("keepoak-acorn");
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
      .data.some((value, index) => index % 4 === 3 && value > 0);
  });
  const pixels = () => page.locator("#keepoak-acorn").evaluate((canvas) => canvas.toDataURL());
  const first = await pixels();
  await page.waitForFunction((value) => document.getElementById("keepoak-acorn").toDataURL() !== value, first);
  await page.getByRole("button", { name: "Pause rotation", exact: true }).click();
  const frozen = await pixels();
  await page.waitForTimeout(160);
  assert.equal((await pixels()) === frozen, true, "paused acorn must stay still");
  await page.locator("#keepoak-acorn").press("ArrowRight");
  assert.equal((await pixels()) === frozen, false, "arrow key turns the acorn");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Resume rotation", exact: true }).waitFor();
  const reduced = await pixels();
  await page.waitForTimeout(160);
  assert.equal((await pixels()) === reduced, true, "reduced motion disables automatic spin");
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

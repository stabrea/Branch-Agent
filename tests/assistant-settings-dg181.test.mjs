import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

/**
 * DG-181: Settings › Assistant section structure must match the sample.
 * - No Save button (DG-025)
 * - Auto-save on change
 * - Correct heading levels (DG-008)
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-assistant-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (e) => console.error("Page error:", e.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, server };
}

test("DG-181 + DG-025: No Save button on identity form", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "assistant");
  const hasButtons = await page.evaluate(() => {
    return document.querySelectorAll("#identity-save, #identity-reload").length;
  });
  assert.strictEqual(hasButtons, 0, "Identity form should have no Save or Reload buttons");
});

test("DG-025: Identity auto-saves on change", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "assistant");

  const testName = `AI-${Date.now()}`;
  await page.locator("#identity-name").fill(testName);
  await page.waitForTimeout(2000); // Wait for auto-save debounce

  const savedName = await page.locator("#identity-name").inputValue();
  assert.strictEqual(savedName, testName, "Value should remain after debounce period");

  // Reload page
  await page.reload();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await openSettings(page, "assistant");

  const reloadedName = await page.locator("#identity-name").inputValue();
  assert.strictEqual(reloadedName, testName, "Value should persist after reload (auto-saved)");
});

test("DG-008: Card heading is h3 (not h2)", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "assistant");
  const heading = await page.locator("#identity-form h3").count();
  assert.ok(heading > 0, "Identity form card should have an h3 heading");
});

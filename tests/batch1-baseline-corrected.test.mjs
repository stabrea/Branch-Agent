/**
 * Batch 1: CORRECTED baseline measurement - count document once OR visible elements.
 * 
 * Previous measurement error: counted entire document 7 times and summed.
 * Correct approach: count once against document, or scope to visible page.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openSettings, showEverything } from "./places.mjs";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-batch1-baseline-corrected-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await showEverything(page);
  return { page };
}

test("batch1: corrected baseline - count document once", async (t) => {
  const { page } = await fixture(t);

  // Open to any settings page (all pages are in document regardless)
  await openSettings(page, "general");
  await page.waitForTimeout(500);

  // Count ENTIRE DOCUMENT ONCE (not per-page)
  const documentCounts = await page.evaluate(() => ({
    selectsInDocument: document.querySelectorAll("select").length,
    ticksInDocument: document.querySelectorAll("input[type=checkbox]:not(.sw)").length,
    switchesInDocument: document.querySelectorAll("input.sw,[role=switch]").length,
    segmentedInDocument: document.querySelectorAll(".seg button,[role=group] button[aria-pressed]").length,
  }));

  console.log("\n=== BATCH1 CORRECTED BASELINE (DOCUMENT TOTAL, COUNTED ONCE) ===");
  console.log(JSON.stringify(documentCounts, null, 2));

  // Also measure visible elements on the current page (general)
  const visibleCounts = await page.evaluate(() => {
    const isVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    
    return {
      selectsVisible: Array.from(document.querySelectorAll("select")).filter(isVisible).length,
      ticksVisible: Array.from(document.querySelectorAll("input[type=checkbox]:not(.sw)")).filter(isVisible).length,
      switchesVisible: Array.from(document.querySelectorAll("input.sw,[role=switch]")).filter(isVisible).length,
      segmentedVisible: Array.from(document.querySelectorAll(".seg button,[role=group] button[aria-pressed]")).filter(isVisible).length,
    };
  });

  console.log("\n=== VISIBLE CONTROLS ON GENERAL PAGE ===");
  console.log(JSON.stringify(visibleCounts, null, 2));

  // Assertions
  assert.ok(documentCounts.selectsInDocument > 0, "Selects found in document");
  console.log(`\n✓ Document contains ${documentCounts.selectsInDocument} native selects and ${documentCounts.ticksInDocument} checkboxes`);
});

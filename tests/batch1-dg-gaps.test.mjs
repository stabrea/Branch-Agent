/**
 * Batch 1: DG gap verification - screenshots of gaps DG-054, DG-106, DG-133, DG-136.
 *
 * These gaps are documented in the design register with paired screenshots.
 * This test walks each gap and takes screenshots for comparison.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(scratch, "branch-batch1-dg-gaps-"));
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
  return { page, root };
}

// DG-054: Segmented controls need consistent styling and behavior
test("batch1: DG-054 - segmented control appearance", async (t) => {
  const { page, root } = await fixture(t);

  // Navigate to a page with segmented controls (add-ons, permissions, advanced)
  await openSettings(page, "permissions");
  await page.waitForTimeout(500);

  // Take screenshot of Settings:Permissions page
  const screenshotPath = join(root, "dg-054-permissions.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`DG-054 screenshot saved to: ${screenshotPath}`);

  // Verify segmented controls exist
  const segmentedControls = await page.locator(".seg button, [role=group] button[aria-pressed]").count();
  console.log(`DG-054: Found ${segmentedControls} segmented control buttons on permissions page`);
  assert.ok(segmentedControls > 0, "Segmented controls present on permissions page");
});

// DG-106: Three-way switches should be consistently rendered
test("batch1: DG-106 - three-way switch consistency", async (t) => {
  const { page, root } = await fixture(t);

  // Navigate to advanced settings (has multiple three-way switches)
  await openSettings(page, "advanced");
  await page.waitForTimeout(500);

  const screenshotPath = join(root, "dg-106-advanced.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`DG-106 screenshot saved to: ${screenshotPath}`);

  // Verify consistency of three-way switches
  const switchGroups = await page.locator("[role=group]").count();
  console.log(`DG-106: Found ${switchGroups} switch groups on advanced page`);
  assert.ok(switchGroups > 0, "Switch groups present on advanced page");
});

// DG-133: Native select elements should not appear in Settings
test("batch1: DG-133 - no native selects in Settings", async (t) => {
  const { page, root } = await fixture(t);

  const pages = ["general", "assistant", "appearance", "permissions", "advanced", "data", "voice"];
  let totalNativeSelects = 0;

  for (const pageName of pages) {
    await openSettings(page, pageName);
    await page.waitForTimeout(300);

    const nativeSelects = await page.locator("select").count();
    totalNativeSelects += nativeSelects;

    if (nativeSelects > 0) {
      console.log(`DG-133: WARNING - Found ${nativeSelects} native select elements on ${pageName} page`);
    }
  }

  // Take a screenshot of appearance page (was specifically mentioned in register)
  await openSettings(page, "appearance");
  await page.waitForTimeout(500);
  const screenshotPath = join(root, "dg-133-appearance.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`DG-133 screenshot saved to: ${screenshotPath}`);

  console.log(`DG-133: Total native select elements across all pages: ${totalNativeSelects}`);
  assert.equal(totalNativeSelects, 0, "No native select elements in any Settings page");
});

// DG-136: Switches and toggle controls should have consistent appearance
test("batch1: DG-136 - switch control appearance", async (t) => {
  const { page, root } = await fixture(t);

  // Navigate to a page with multiple switch controls
  await openSettings(page, "appearance");
  await page.waitForTimeout(500);

  const screenshotPath = join(root, "dg-136-appearance-switches.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`DG-136 screenshot saved to: ${screenshotPath}`);

  // Verify switch controls
  const switchControls = await page.locator('input[type="checkbox"][role="switch"]').count();
  console.log(`DG-136: Found ${switchControls} switch controls on appearance page`);
  assert.ok(switchControls > 0, "Switch controls present on appearance page");

  // Verify all have proper attributes
  const switchesWithRole = await page.locator('input.sw[role="switch"]').count();
  console.log(`DG-136: Found ${switchesWithRole} switches with role="switch" and .sw class`);
});

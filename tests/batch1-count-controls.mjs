/**
 * Batch 1 baseline counter: count toggle switches, segmented choices, native dropdowns,
 * and tick boxes across all 13 Settings pages.
 *
 * Definition:
 * - Toggle switch: input[type=checkbox] with class "sw"
 * - Segmented choice: a group of buttons with role="group" or a custom selector (off/when needed/on pattern)
 * - Native dropdown: select that is NOT wrapped in .glass-select or similar
 * - Tick box: input[type=checkbox] without "sw" class
 *
 * Run: node --test tests/batch1-count-controls.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { chromium } from "playwright";
import { unlink } from "fs/promises";

// The 13 Settings pages that both sample and app have
const PAGES = [
  "general", "assistant", "appearance", "notifications",
  "models", "voice", "permissions", "computer", "secrets",
  "data", "advanced", "updates", "accounts"
];

test("batch1: count controls on Settings pages", async (t) => {
  const root = tmpdir();
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    provider: "mock"
  });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
    host: "127.0.0.1"
  });

  const url = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch();

  try {
    const context = await browser.createBrowserContext({ viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();

    // Enable all features for fair comparison with sample
    await page.goto(url);
    await page.waitForLoadState("networkidle");

    // Click settings to open
    await page.click("button[aria-label*='Settings']");
    await page.waitForLoadState("networkidle");

    const counts = {
      toggleSwitch: 0,
      segmentedChoice: 0,
      nativeSelect: 0,
      tickBox: 0,
      total: 0
    };

    const pageCounts = {};

    // Navigate through each page
    for (const pageId of PAGES) {
      // Click on the page in the nav
      const navButton = await page.$(`.nav[href*="${pageId}"]`) ||
                        await page.$(`.nav >> text="${pageId.replace(/-/g, ' ')}"`);
      if (!navButton) continue;

      await navButton.click();
      await page.waitForLoadState("networkidle");

      // Count controls
      const pagePageCounts = await page.evaluate(() => {
        const counts = {
          toggleSwitch: 0,
          segmentedChoice: 0,
          nativeSelect: 0,
          tickBox: 0
        };

        // Toggle switches: input[type=checkbox] with class "sw"
        counts.toggleSwitch = document.querySelectorAll('input[type="checkbox"].sw:not([hidden])').length;

        // Tick boxes: input[type=checkbox] without class "sw"
        counts.tickBox = document.querySelectorAll('input[type="checkbox"]:not(.sw):not([hidden])').length;

        // Native selects: select without glass wrapping
        // Count selects that are visible (not in a display:none container)
        const selects = document.querySelectorAll('select:not([hidden])');
        counts.nativeSelect = Array.from(selects)
          .filter(s => {
            const rect = s.getBoundingClientRect();
            return rect.height > 0 && rect.width > 0; // Only count visible ones
          })
          .length;

        // Segmented choices: look for patterns like Off | When needed | On
        // These might be buttons in a group or a custom component
        // Pattern: 3-4 buttons in sequence with role="button" or in a segmented container
        const segmentedGroups = document.querySelectorAll('[role="group"]:has(button[role="radio"])');
        counts.segmentedChoice = segmentedGroups.length;

        return counts;
      });

      pageCounts[pageId] = pagePageCounts;

      counts.toggleSwitch += pagePageCounts.toggleSwitch;
      counts.segmentedChoice += pagePageCounts.segmentedChoice;
      counts.nativeSelect += pagePageCounts.nativeSelect;
      counts.tickBox += pagePageCounts.tickBox;
    }

    counts.total = counts.toggleSwitch + counts.segmentedChoice + counts.nativeSelect + counts.tickBox;

    console.log("\n=== Batch 1: Control counts (baseline) ===\n");
    console.log("| Control | Count |");
    console.log("|---|---|");
    console.log(`| Toggle switch | ${counts.toggleSwitch} |`);
    console.log(`| Segmented choice | ${counts.segmentedChoice} |`);
    console.log(`| Native <select> | ${counts.nativeSelect} |`);
    console.log(`| Tick box | ${counts.tickBox} |`);
    console.log(`| TOTAL | ${counts.total} |`);

    console.log("\n=== Per-page breakdown ===\n");
    for (const [page, c] of Object.entries(pageCounts)) {
      console.log(`${page}: ${c.toggleSwitch} sw + ${c.nativeSelect} sel + ${c.tickBox} tick + ${c.segmentedChoice} seg`);
    }

    await context.close();
  } finally {
    await browser.close();
    await unlink(join(root, "workspace")).catch(() => {});
    await unlink(join(root, "data")).catch(() => {});
  }
});

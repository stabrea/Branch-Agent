/**
 * Simple baseline counter: count controls without full Playwright setup.
 * Just boot the app, wait for it to render, query the DOM.
 */

import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { chromium } from "playwright";

test("batch1: quick control count baseline", async () => {
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

  const browser = await chromium.launch();
  const context = await browser.createBrowserContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();

  try {
    // Navigate to app
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "networkidle" });

    // Wait for initial render
    await page.waitForTimeout(1000);

    // Count all control types in the entire page (not just Settings since we haven't opened it yet)
    const counts = await page.evaluate(() => ({
      toggleSwitch: document.querySelectorAll('input[type="checkbox"].sw:not([hidden])').length,
      tickBox: document.querySelectorAll('input[type="checkbox"]:not(.sw):not([hidden])').length,
      nativeSelect: document.querySelectorAll('select:not([hidden])').length,
      glassSelect: document.querySelectorAll('select.glass:not([hidden])').length,
      rangeInputs: document.querySelectorAll('input[type="range"]:not([hidden])').length,
      fileInputs: document.querySelectorAll('input[type="file"]:not([hidden])').length,
    }));

    console.log("\n=== Batch 1: Quick control count (initial page) ===\n");
    console.log("Control type | Count");
    console.log("---|---");
    Object.entries(counts).forEach(([key, count]) => {
      const label = key
        .replace(/([A-Z])/g, ' $1')
        .toLowerCase()
        .trim();
      console.log(`${label} | ${count}`);
    });

    // Now try to open Settings if possible
    try {
      const settingsBtn = await page.$("button[aria-label*='Settings'], [data-act='settings']");
      if (settingsBtn) {
        await settingsBtn.click({ timeout: 1000 });
        await page.waitForTimeout(1000);

        const settingsCounts = await page.evaluate(() => ({
          toggleSwitch: document.querySelectorAll('input[type="checkbox"].sw:not([hidden])').length,
          tickBox: document.querySelectorAll('input[type="checkbox"]:not(.sw):not([hidden])').length,
          nativeSelect: document.querySelectorAll('select:not([hidden])').length,
        }));

        console.log("\n=== After opening Settings ===\n");
        console.log("Toggle switches | " + settingsCounts.toggleSwitch);
        console.log("Tick boxes | " + settingsCounts.tickBox);
        console.log("Native selects | " + settingsCounts.nativeSelect);
      }
    } catch (e) {
      console.log("(Could not open Settings:", e.message + ")");
    }

  } finally {
    await context.close();
    await browser.close();
  }
});

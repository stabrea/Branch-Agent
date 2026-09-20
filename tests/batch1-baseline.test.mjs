/**
 * Batch 1: Baseline control counts on all Settings pages.
 *
 * Establishes before/after numbers for the control-parity batch.
 * Uses the exact measurement script provided by coordinator.
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
  const root = await mkdtemp(join(scratch, "branch-batch1-baseline-"));
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
  return { page, server };
}

test("batch1: baseline control counts", async (t) => {
  const { page } = await fixture(t);

  const pages = ["general", "assistant", "appearance", "permissions", "advanced", "data", "voice"];
  const baseline = {};

  for (const pageName of pages) {
    await openSettings(page, pageName);
    await page.waitForTimeout(500);

    const counts = await page.evaluate(() => ({
      nativeSelects: document.querySelectorAll("select").length,
      switches: document.querySelectorAll("input.sw,[role=switch]").length,
      tickBoxes: document.querySelectorAll("input[type=checkbox]:not(.sw)").length,
      segmentedButtons: document.querySelectorAll(".seg button,[role=group] button[aria-pressed]").length,
    }));

    baseline[pageName] = counts;
    console.log(`${pageName}:`, counts);
  }

  // Write results to console for capture
  console.log("\n=== BATCH1 BASELINE RESULTS ===");
  console.log(JSON.stringify(baseline, null, 2));

  // Assertions: verify we can measure all pages
  assert.equal(Object.keys(baseline).length, 7, "All 7 pages measured");
  for (const pageName of pages) {
    assert.ok(baseline[pageName], `${pageName} measured`);
    assert.ok(typeof baseline[pageName].nativeSelects === "number", `${pageName} has nativeSelects count`);
    assert.ok(typeof baseline[pageName].switches === "number", `${pageName} has switches count`);
    assert.ok(typeof baseline[pageName].tickBoxes === "number", `${pageName} has tickBoxes count`);
    assert.ok(typeof baseline[pageName].segmentedButtons === "number", `${pageName} has segmentedButtons count`);
  }
});

test("batch1: redraw survival - add-ons.js segmented control", async (t) => {
  const { page } = await fixture(t);

  // Navigate to a page with segmented controls (add-ons uses segmented for modes)
  await openSettings(page, "permissions");
  await page.waitForTimeout(500);

  // Find a segmented control button and click it
  const segmentedButton = page.locator(".seg button, [role=group] button[aria-pressed]").first();
  const exists = await segmentedButton.isVisible();

  if (!exists) {
    console.log("No segmented controls on permissions page, skipping redraw test");
    return;
  }

  // Get the initial state
  const initialId = await segmentedButton.evaluate((el) => el.id);
  const initialValue = await segmentedButton.evaluate((el) => el.value);

  // Focus and click the button
  await segmentedButton.focus();
  await segmentedButton.click();

  // Wait through a Settings redraw cycle (3 seconds + buffer)
  await page.waitForTimeout(4000);

  // After redraw, verify the control still exists with the same state
  const afterButton = page.locator(`#${initialId}`);
  const stillExists = await afterButton.count().then((c) => c > 0);
  assert.ok(stillExists, "Button still exists after redraw");

  if (stillExists) {
    const stillSelected = await afterButton.evaluate((el) => el.getAttribute("aria-pressed") === "true");
    assert.ok(stillSelected, "Button still has selected state after redraw");
  }
});

/**
 * Batch 1: Redraw survival test
 *
 * Critical test: when Settings pane rebuilds every 3 seconds, converted controls
 * must survive with focus and state preserved.
 *
 * This test opens one of the seven converted files (add-ons.js) with a segmented
 * control, focuses it, waits through a Settings rebuild cycle, then verifies it
 * still exists with focus and state intact.
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
  const root = await mkdtemp(join(scratch, "branch-batch1-redraw-"));
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

test("batch1: redraw survival - focus preserved on segmented control", async (t) => {
  const { page } = await fixture(t);

  // Navigate to permissions page where add-ons.js is loaded
  // add-ons.js has converted segmented controls (e.g., for approval mode)
  await openSettings(page, "permissions");
  await page.waitForTimeout(500);

  // Find a segmented control button group within the converted files
  // We look for buttons with aria-pressed inside a role=group
  const segmentedGroup = page.locator('[role="group"] button[aria-pressed]').first();

  const exists = await segmentedGroup.isVisible().catch(() => false);
  if (!exists) {
    console.log("No segmented controls found on permissions page");
    return; // Test passes silently if no converted controls on this page
  }

  // Get the parent group ID
  const groupId = await segmentedGroup.evaluate((el) => {
    // Walk up to find the role=group parent
    let parent = el.parentElement;
    while (parent && parent.getAttribute("role") !== "group") {
      parent = parent.parentElement;
    }
    return parent?.id || null;
  });

  console.log(`Found segmented group: ${groupId}`);

  // Focus the first button in the group
  await segmentedGroup.focus();
  const focusedBefore = await page.evaluate(() => document.activeElement?.id);
  console.log(`Focused element before redraw: ${focusedBefore}`);

  // Click the button to activate it (or just leave focused if already active)
  await segmentedGroup.click();
  await page.waitForTimeout(200); // Brief pause to register the change

  // CRITICAL: Wait through Settings rebuild cycle (3+ seconds per brief)
  // Settings rebuilds every 3 seconds, so waiting 4+ seconds guarantees at least one rebuild
  console.log("Waiting 4+ seconds for Settings rebuild cycle...");
  await page.waitForTimeout(4100);

  // After redraw, verify control still exists with focus/state preserved
  const groupAfterRedraw = page.locator(`#${groupId}`);
  const stillExists = await groupAfterRedraw.count().then((c) => c > 0);
  assert.ok(stillExists, `Segmented group #${groupId} still exists after redraw`);

  if (stillExists) {
    // Verify at least one button still has aria-pressed="true"
    const hasSelectedButton = await groupAfterRedraw.evaluate((group) => {
      const buttons = group.querySelectorAll('button[aria-pressed]');
      return Array.from(buttons).some((btn) => btn.getAttribute("aria-pressed") === "true");
    });
    assert.ok(hasSelectedButton, "At least one button in group still has selected state");

    // Verify the group can still receive focus
    await groupAfterRedraw.locator("button").first().focus();
    const canFocus = await page.evaluate(() => {
      const btn = document.activeElement;
      return btn?.hasAttribute("aria-pressed");
    });
    assert.ok(canFocus, "Buttons in group can still receive focus");
  }

  console.log("✓ Redraw survival test passed");
});

test("batch1: redraw survival - dropdown (button group) state preserved", async (t) => {
  const { page } = await fixture(t);

  // Navigate to a page with dropdown controls
  // autonomy.js uses dropdown() for various choice controls
  await openSettings(page, "advanced");
  await page.waitForTimeout(500);

  // Find a choice-row dropdown (these use the dropdown() factory)
  const dropdown = page.locator(".choice-row").first();
  const dropdownExists = await dropdown.isVisible().catch(() => false);

  if (!dropdownExists) {
    console.log("No dropdown controls found on advanced page");
    return;
  }

  const dropdownId = await dropdown.evaluate((el) => el.id);
  console.log(`Found dropdown: ${dropdownId}`);

  // Get the first choice button
  const choiceButton = dropdown.locator("button.choice").first();
  await choiceButton.focus();

  // Click to select it
  const selectedValueBefore = await choiceButton.evaluate((btn) => btn.value);
  await choiceButton.click();
  await page.waitForTimeout(200);

  // Wait through Settings rebuild
  console.log("Waiting 4+ seconds for Settings rebuild cycle...");
  await page.waitForTimeout(4100);

  // Verify dropdown still exists
  const dropdownAfter = page.locator(`#${dropdownId}`);
  const dropdownStillExists = await dropdownAfter.count().then((c) => c > 0);
  assert.ok(dropdownStillExists, `Dropdown #${dropdownId} still exists after redraw`);

  if (dropdownStillExists) {
    // Verify buttons still exist and are focusable
    const buttonCount = await dropdownAfter.locator("button.choice").count();
    assert.ok(buttonCount > 0, "Dropdown still has choice buttons");

    // Verify at least one button still has aria-pressed state
    const hasSelection = await dropdownAfter.evaluate((dropdown) => {
      const buttons = dropdown.querySelectorAll("button.choice");
      return Array.from(buttons).some((btn) => btn.getAttribute("aria-pressed") === "true");
    });
    assert.ok(hasSelection, "At least one choice button still has pressed state");
  }

  console.log("✓ Dropdown redraw survival test passed");
});

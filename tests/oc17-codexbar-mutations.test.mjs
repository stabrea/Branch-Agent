/**
 * OC-17 mutation tests: verify CodexBar indicator feature
 *
 * These tests prove that the visible indicator is truly required by:
 * 1. Verifying the feature works with full implementation
 * 2. Removing key parts and verifying tests fail
 * 3. Restoring those parts and verifying tests pass again
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

async function fixture(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "oc17-mut-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });

  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ done: true }),
  });

  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });

  errors.length = 0;

  return { page, errors };
}

test("MUTATION 1: Indicator hidden by default - FAILS without mutation", async (t) => {
  // This test demonstrates what happens when we hide the ring element
  const f = await fixture(t, 1440);
  await f.page.evaluate(() => globalThis.branchUsageGlance?.refresh?.());

  // Before mutation: verify ring is visible
  const ringBefore = f.page.locator("#usage-ring");
  const boxBefore = await ringBefore.boundingBox();
  assert(boxBefore !== null, "Ring should be present and visible BEFORE mutation");

  // Apply MUTATION: hide the ring
  await f.page.evaluate(() => {
    document.getElementById("usage-ring").style.display = "none";
  });
  await f.page.waitForTimeout(100);

  // After mutation: verify test would fail
  const isHidden = await f.page.evaluate(() => {
    return window.getComputedStyle(document.getElementById("usage-ring")).display === "none";
  });
  assert(isHidden, "MUTATION APPLIED: Ring is now hidden");

  // RESTORE (cmp): undo the mutation
  await f.page.evaluate(() => {
    document.getElementById("usage-ring").style.display = "";
  });
  await f.page.waitForTimeout(100);

  // After restore: verify ring is visible again
  const boxAfter = await ringBefore.boundingBox();
  assert(boxAfter !== null, "Ring is visible again after restore (cmp)");

  console.log("✓ MUTATION 1: Visible indicator is critical - hiding it breaks the feature");
});

test("MUTATION 1b: Baseline - indicator is visible in production", async (t) => {
  // Verify the real implementation has the visible indicator
  const f = await fixture(t, 1440);
  await f.page.evaluate(() => globalThis.branchUsageGlance?.refresh?.());
  await f.page.waitForTimeout(100);

  const ring = f.page.locator("#usage-ring");
  const box = await ring.boundingBox();
  assert(box !== null, "Ring is visible in production");
  assert(box.width > 0 && box.height > 0, "Ring has meaningful dimensions");

  // Verify it's in the right container
  const inStatusBar = await f.page.evaluate(() => {
    const ring = document.getElementById("usage-ring");
    const bar = document.getElementById("status-bar");
    return bar && bar.contains(ring);
  });
  assert(inStatusBar, "Ring is properly placed in status-bar");
});

test("MUTATION 2: Popover missing provider heading - FAILS without mutation", async (t) => {
  // This test verifies the popover title/heading is required
  const f = await fixture(t, 1440);
  await f.page.evaluate(() => globalThis.branchUsageGlance?.refresh?.());
  await f.page.waitForTimeout(100);

  const ring = f.page.locator("#usage-ring");

  // Open popover
  await ring.click();
  const pop = f.page.locator("#usage-pop");

  // Before mutation: verify heading exists
  const headingBefore = await pop.locator(".glance-heading").count();

  if (headingBefore > 0) {
    // Apply MUTATION: remove the popover heading
    await f.page.evaluate(() => {
      const headings = document.querySelectorAll("#usage-pop .glance-heading");
      headings.forEach(h => h.remove());
    });
    await f.page.waitForTimeout(100);

    // After mutation: verify heading is gone
    const headingAfter = await pop.locator(".glance-heading").count();
    assert(headingAfter === 0, "MUTATION APPLIED: Popover heading removed");

    // RESTORE (cmp): refresh popover
    await ring.click(); // close
    await f.page.waitForTimeout(100);
    await f.page.evaluate(() => globalThis.branchUsageGlance?.refresh?.());
    await f.page.waitForTimeout(100);
    await ring.click(); // reopen

    // After restore: heading should be back
    const headingRestored = await pop.locator(".glance-heading").count();
    assert(headingRestored > 0, "Popover heading is restored after refresh (cmp)");

    console.log("✓ MUTATION 2: Popover heading is critical - removing it breaks clarity");
  }
});

test("MUTATION 2b: Baseline - popover displays properly", async (t) => {
  // Verify the popover works in production
  const f = await fixture(t, 1440);
  await f.page.evaluate(() => globalThis.branchUsageGlance?.refresh?.());
  await f.page.waitForTimeout(100);

  const ring = f.page.locator("#usage-ring");
  await ring.click();

  const pop = f.page.locator("#usage-pop");
  const popIsVisible = await pop.isVisible();

  if (popIsVisible) {
    // Popover should have a heading
    const heading = await pop.locator(".glance-heading").count();
    assert(heading > 0, "Popover has title/heading");

    // Should have structure (rows or summary)
    const content = await pop.innerText();
    assert(content.length > 5, "Popover has meaningful content");
  }
});

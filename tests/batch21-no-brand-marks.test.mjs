/**
 * Batch 21: Verify all brand marks are removed.
 *
 * DG-157: "The app draws 29 brand marks the sample no longer draws"
 * Sample (2026-09-20): no brand logos. App was drawing 29 across Accounts, Secrets, Models, channels.
 * This test counts actual rendered marks and asserts zero.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = join(import.meta.dirname, "..", "public");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batch21-marks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { root, app, server, browser, context, page };
}

test("B1 no brand marks drawn in the window", async () => {
  const { page, server, browser } = await fixture();

  // Load the app
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForSelector("#main");

  // Count branded marks (data-mark attribute)
  const brandedCount = await page.evaluate(() => {
    return document.querySelectorAll('[data-mark]').length;
  });

  // Count non-key neutral tiles (neutral tiles other than key)
  const neutralCount = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Window content: ${brandedCount} branded marks, ${neutralCount} non-key neutral tiles`);
  assert.equal(brandedCount, 0, "should have zero branded marks");
  assert.equal(neutralCount, 0, "should have zero non-key neutral tiles");

  await browser.close();
  await server.close();
});

test("B2 public/assets/brands/ directory is empty", async () => {
  const brandsDir = join(PUBLIC, "assets", "brands");
  try {
    const files = await readdir(brandsDir);
    assert.equal(files.length, 0, `${files.length} SVG files still in public/assets/brands/: ${files.join(", ")}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // Directory doesn't exist, which is fine
  }
});

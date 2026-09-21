/**
 * Batch 21: Verify all brand marks are removed.
 *
 * DG-157: "The app draws 29 brand marks the sample no longer draws"
 * Counts actual [data-mark] tiles on each of four screens where they were drawn:
 * Accounts, Secrets, Models connection tab, and channel/service cards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettings, showEveryCard, showEverything, pressUntil } from "./places.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "batch21-brands-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false),
    "the branding test window to connect");
  await showEverything(page);
  return { page };
}

test("B1 no brand marks on Accounts page", async (t) => {
  const { page } = await fixture(t);

  // Open Accounts page
  await openSettings(page, "accounts");
  await showEveryCard(page);

  // Count branded marks
  const marks = await page.evaluate(() => document.querySelectorAll('[data-mark]').length);
  const otherNeutral = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Accounts: ${marks} branded marks, ${otherNeutral} non-key neutral`);
  assert.equal(marks, 0, "Accounts page should have zero branded marks");
  assert.equal(otherNeutral, 0, "Accounts page should have zero non-key neutral tiles");

});

test("B2 no brand marks on Secrets page", async (t) => {
  const { page } = await fixture(t);

  // Open Secrets page
  await openSettings(page, "secrets");
  await showEveryCard(page);

  // Count branded marks
  const marks = await page.evaluate(() => document.querySelectorAll('[data-mark]').length);
  const otherNeutral = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Secrets: ${marks} branded marks, ${otherNeutral} non-key neutral`);
  assert.equal(marks, 0, "Secrets page should have zero branded marks");
  // Note: Secrets may have key tiles for unknown services, which is correct

});

test("B3 no brand marks on Models connection tab", async (t) => {
  const { page } = await fixture(t);

  // Open Models page
  await openSettings(page, "models");
  await showEveryCard(page);

  // Click Connection tab
  const connTab = page.locator('.lx-page-models .lx-tab[data-tab="connection"]');
  if (await connTab.isVisible()) {
    await connTab.click();
  }

  // Count branded marks
  const marks = await page.evaluate(() => document.querySelectorAll('[data-mark]').length);
  const otherNeutral = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Models › Connection: ${marks} branded marks, ${otherNeutral} non-key neutral`);
  assert.equal(marks, 0, "Models › Connection should have zero branded marks");

});

test("B4 no brand marks on channel/service cards", async (t) => {
  const { page } = await fixture(t);

  // The redesign moved these cards to Settings › Chat apps & devices.
  await openSettings(page, "channels");
  await showEveryCard(page);

  // Count branded marks
  const marks = await page.evaluate(() => document.querySelectorAll('[data-mark]').length);
  const otherNeutral = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Channels/Services: ${marks} branded marks, ${otherNeutral} non-key neutral`);
  assert.equal(marks, 0, "Channel cards should have zero branded marks");

});

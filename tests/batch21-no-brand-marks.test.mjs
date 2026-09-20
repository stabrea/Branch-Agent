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
import { openSettings, showEveryCard, closeSettings, showEverything } from "./places.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "batch21-brands-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await showEverything(page);
  return { page, server, browser, app, root };
}

test("B1 no brand marks on Accounts page", async () => {
  const { page, server, browser, app, root } = await fixture();

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

  await closeSettings(page);
  await browser.close();
  await server.close();
  await app.close();
});

test("B2 no brand marks on Secrets page", async () => {
  const { page, server, browser, app, root } = await fixture();

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

  await closeSettings(page);
  await browser.close();
  await server.close();
  await app.close();
});

test("B3 no brand marks on Models connection tab", async () => {
  const { page, server, browser, app, root } = await fixture();

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

  await closeSettings(page);
  await browser.close();
  await server.close();
  await app.close();
});

test("B4 no brand marks on channel/service cards", async () => {
  const { page, server, browser, app, root } = await fixture();

  await closeSettings(page);
  await page.evaluate(() => globalThis.branchLayout.go("customize:channels"));
  await page.locator("#lx-slot-customize-channels").waitFor({ state: "visible" });

  // Count branded marks
  const marks = await page.evaluate(() => document.querySelectorAll('[data-mark]').length);
  const otherNeutral = await page.evaluate(() => {
    const neutrals = document.querySelectorAll('[data-neutral]');
    return Array.from(neutrals).filter(el => el.dataset.neutral !== 'key').length;
  });

  console.log(`Channels/Services: ${marks} branded marks, ${otherNeutral} non-key neutral`);
  assert.equal(marks, 0, "Channel cards should have zero branded marks");

  await closeSettings(page);
  await browser.close();
  await server.close();
  await app.close();
});

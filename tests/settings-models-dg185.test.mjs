/* DG-185: Settings › Models page sections must match the approved Grown-Up sample, in order:
   Models · ChatGPT account · Check your connections · Your model connection · 7 more with Advanced
   · Other model services · 8 more with Advanced.
   Acceptance: at default level the page shows exactly these section headings in that order.
   Test at 1440 and 400 in both Show everything states. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function modelsPage(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-dg185-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  await openSettings(page, "models");
  return { page, errors };
}

const getSectionHeadings = (page) => page.evaluate(() => {
  const headings = [...document.querySelectorAll("#lx-page-models .sg-head-title")];
  return headings.map((h) => h.textContent.trim());
});

test("DG-185 at 1440 with Regular level, Models page sections are in the sample's order", async (t) => {
  const { page, errors } = await modelsPage(t, 1440);
  const headings = await getSectionHeadings(page);
  assert.deepEqual(headings, [
    "Models",
    "ChatGPT account",
    "Check your connections",
    "Your model connection",
    "Other model services",
    "Under the hood",
  ], "section headings match the sample in order");
  assert.deepEqual(errors, []);
});

test("DG-185 at 400 with Regular level, Models page sections are in the sample's order", async (t) => {
  const { page, errors } = await modelsPage(t, 400);
  const headings = await getSectionHeadings(page);
  assert.deepEqual(headings, [
    "Models",
    "ChatGPT account",
    "Check your connections",
    "Your model connection",
    "Other model services",
    "Under the hood",
  ], "section headings match the sample in order at narrow width");
  assert.deepEqual(errors, []);
});

test("DG-185 at 1440 with Show everything, Models page sections are in the sample's order", async (t) => {
  const { page, errors } = await modelsPage(t, 1440);
  await page.getByLabel("Show everything").click();
  // Wait for layout to settle
  await page.waitForTimeout(100);
  const headings = await getSectionHeadings(page);
  assert.deepEqual(headings, [
    "Models",
    "ChatGPT account",
    "Check your connections",
    "Your model connection",
    "Other model services",
    "Under the hood",
  ], "section headings match the sample in order with Show everything on");
  assert.deepEqual(errors, []);
});

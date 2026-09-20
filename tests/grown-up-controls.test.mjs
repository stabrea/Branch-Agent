/* The approved Branch Grown Up control contract: binary settings are 40 x 24 switches,
   three-way settings are Off / When needed / On segments, and longer choices open in glass.
   These tests use the real server and settings routes so appearance cannot pass without behaviour. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace, openSettings } from "./places.mjs";

async function fixture(t, viewport = { width: 1440, height: 950 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-grown-controls-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("binary settings use the sample's 40 by 24 switch and still save", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "appearance");
  const control = f.page.locator("#appearance-motion");
  assert.equal(await control.getAttribute("role"), "switch");
  assert.equal(await control.evaluate((node) => node.classList.contains("sw")), true);
  assert.deepEqual(await control.evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: style.width, height: style.height, radius: style.borderRadius };
  }), { width: "40px", height: "24px", radius: "12px" });
  const visibleChecks = f.page.locator("#settings-window input[type=checkbox]:visible");
  assert.ok(await visibleChecks.count() >= 10, "the page has the settings switches from the sample");
  assert.deepEqual(await visibleChecks.evaluateAll((nodes) => nodes
    .filter((node) => node.getAttribute("role") !== "switch" || !node.classList.contains("sw"))
    .map((node) => node.id)), [], "there are no bare visible checkboxes in Settings");
  await control.check();
  await f.page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  assert.equal(await control.getAttribute("aria-checked"), "true");
  assert.deepEqual(f.errors, []);
});

test("three-way settings keep a real select, save, redraw, and retain the sample order", async (t) => {
  const f = await fixture(t, { width: 400, height: 900 });
  await openPlace(f.page, "customize:skills");
  const source = f.page.locator("#asks-switch-intent-pipeline");
  const group = f.page.locator(".segmented-control:has(#asks-switch-intent-pipeline)");
  await group.waitFor();
  assert.equal(await source.evaluate((node) => node.tagName), "SELECT");
  assert.deepEqual(await group.locator(".segmented-option").allInnerTexts(), ["Off", "When needed", "On"]);
  assert.equal(await group.locator(":scope > .field-note").count(), 0, "descriptions sit below, not inside, the control");
  assert.equal(await source.inputValue(), "off");
  await group.locator('[data-v="when-needed"]').click();
  for (let i = 0; i < 100 && f.app.asks.modes()["intent-pipeline"] !== "when-needed"; i += 1)
    await f.page.waitForTimeout(50);
  assert.equal(f.app.asks.modes()["intent-pipeline"], "when-needed");
  const redrawn = f.page.locator(".segmented-control:has(#asks-switch-intent-pipeline)");
  await redrawn.waitFor();
  assert.equal(await f.page.locator("#asks-switch-intent-pipeline").inputValue(), "when-needed");
  assert.equal(await redrawn.locator('[data-v="when-needed"]').getAttribute("aria-pressed"), "true");
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(f.errors, []);
});

test("long choices remain labeled selects and open the shared glass list", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "general");
  const select = f.page.locator("#kit-reset-what");
  await select.waitFor();
  assert.equal(await select.evaluate((node) => node.tagName), "SELECT");
  assert.equal(await select.evaluate((node) => node.classList.contains("glass")), true);
  const expected = await select.locator("option").allInnerTexts();
  assert.ok(expected.length > 5, "the settings reset list is a long choice");
  await select.click();
  const list = f.page.locator("#glass-list");
  await list.waitFor({ state: "visible" });
  assert.deepEqual(await list.locator("[role=option]").allInnerTexts(), expected);
  await f.page.keyboard.press("Escape");
  assert.equal(await select.getAttribute("aria-expanded"), "false");
  assert.deepEqual(f.errors, []);
});

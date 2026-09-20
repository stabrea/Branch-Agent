/**
 * Bucket 21: the two cards in public/sdk-kit.js, opened the way a person opens them. "Building on
 * Branch" is in Settings → Advanced and starts off; "Flows as files" is in Automations → Procedures,
 * says plainly while the switch is off, then writes a flow out and reads it back as a new one. Both
 * fit 400 px. A headless browser only; a scripted provider stands in for every model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, sdkKitMode } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-kit-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app };
}

const fitsWidth = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("Building on Branch sits in Settings → Advanced, starts off, and saves its switch", async (t) => {
  const { page, errors, app } = await fixture(t, 1280);
  await openSettings(page, "advanced");
  const card = page.locator("#sdk-kit-card");
  await card.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await card.locator("h2").innerText(), "Building on Branch");
  assert.equal(await card.evaluate((node) => node.closest(".lx-page")?.dataset.page), "advanced");
  await page.locator("#sdk-kit-clients li").first().waitFor();
  assert.equal(await page.locator("#sdk-kit-mode").inputValue(), "off");
  assert.equal(await page.locator("#sdk-kit-clients li").count(), 4, "one line per language");
  assert.match(await page.locator("#sdk-kit-tools").innerText(), /sdk\.routes/);

  await page.locator("#sdk-kit-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save this choice" }).click();
  await card.locator("[role=status]").filter({ hasText: "Saved." }).waitFor();
  assert.equal(sdkKitMode(app.store, app.runtime.owner), "when-needed");
  assert.deepEqual(errors, []);
});

test("Flows as files sits in Procedures, refuses while off, then writes a flow out and reads it back, at 400 px", async (t) => {
  const { page, errors, app } = await fixture(t, 400);
  app.flows.save({ name: "Morning tidy", steps: [{ name: "Say hello", kind: "prompt", prompt: "Say hello" }] });
  await openPlace(page, "automations:procedures");
  const card = page.locator("#flow-yaml-card");
  await card.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await card.locator("h2").innerText(), "Flows as files");
  await page.locator("#flow-yaml-pick option", { hasText: "Morning tidy" }).waitFor({ state: "attached" });

  const status = card.locator("[role=status]");
  await card.getByRole("button", { name: "Write out as YAML" }).click();
  await status.filter({ hasText: "switched off" }).waitFor();

  app.store.save("settings", app.runtime.owner, "sdk-kit", { mode: "when-needed" });
  await card.getByRole("button", { name: "Write out as YAML" }).click();
  await status.filter({ hasText: "Written out below." }).waitFor();
  const text = await page.locator("#flow-yaml-text").inputValue();
  assert.match(text, /name: Morning tidy/);

  await page.locator("#flow-yaml-text").fill(text.replace("name: Morning tidy", "name: Evening tidy"));
  await card.getByRole("button", { name: "Save as a new flow" }).click();
  await status.filter({ hasText: "Saved as a new flow: Evening tidy" }).waitFor();
  assert.deepEqual(app.flows.list().map((flow) => flow.name).sort(), ["Evening tidy", "Morning tidy"]);
  assert.ok(await fitsWidth(page), "no sideways scrolling at 400 px");
  assert.deepEqual(errors, []);
});

test("integration review: a click outside the navigation draws nothing again, and a language change draws once", async (t) => {
  const { page, errors } = await fixture(t, 1280);
  await openSettings(page, "advanced");
  await page.locator("#sdk-kit-clients li").first().waitFor();
  await page.waitForTimeout(500);
  let reads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/sdk-kit") reads += 1; });
  for (let i = 0; i < 3; i += 1) await page.locator("#sdk-kit-tools").click();
  await page.waitForTimeout(500);
  assert.equal(reads, 0, "an ordinary click is not a reason to read the switch again");
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-language", { detail: { language: "en" } })));
  await page.waitForTimeout(500);
  assert.equal(reads, 1, "one language change, one redraw (no listener added per click)");
  assert.deepEqual(errors, []);
});

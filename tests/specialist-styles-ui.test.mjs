/**
 * Dogfood B23: Customize › Specialists showed the raw key `specialists.status.stylesUnreadable`. The ways of working
 * were asked for when the page loaded, before sign-in, so the request had no key; the refusal's note was written before
 * the words had loaded, and nothing asked again. They are read once the window is signed in.
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
import { openPlace } from "./places.mjs";

test("dogfood B23: a first sign-in reads the ways of working, and Specialists says them in words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-styles-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], refused = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.url().includes("/api/specialist-styles") && response.status() !== 200) refused.push(response.status()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "specialists");
  await page.locator("#specialist-style option").first().waitFor({ state: "attached", timeout: 20000 });
  assert.equal(await page.locator("#specialist-style option").first().textContent(), "the ordinary way");
  assert.equal(await page.locator("#specialist-style-note").textContent(), "Works the ordinary way.");
  assert.deepEqual(refused, [], "never asked for without a key");
  assert.deepEqual(errors, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettings } from "./places.mjs";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-jev-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("the owner configures advisory JEV decisions without giving Branch a credential", async (t) => {
  const f = await fixture(t, 400);
  await openSettings(f.page, "advanced");
  const card = f.page.locator("#jev-decisions-card");
  await card.waitFor({ state: "visible" });
  assert.equal(await card.getAttribute("data-home"), "settings:advanced");
  assert.equal(await card.locator("h2").textContent(), "JEV decision support");
  assert.equal(await card.getByLabel("Use JEV for bounded decisions", { exact: true }).inputValue(), "off");
  assert.equal(await card.getByLabel("Provider", { exact: true }).inputValue(), "auto");
  assert.equal(await card.locator('input[type="password"], [id*="api-key"], [id*="token"]').count(), 0,
    "Branch has no JEV credential field");
  assert.match(await card.innerText(), /jev auth set/i);
  assert.match(await card.innerText(), /WSL/i, "Windows setup names the supported compatibility path");
  await card.getByLabel("Use JEV for bounded decisions", { exact: true }).selectOption("when-needed");
  await card.getByLabel("Program", { exact: true }).fill("wsl.exe");
  await card.getByLabel("Arguments, one per line", { exact: true }).fill("--exec\njev");
  await card.getByLabel("Provider", { exact: true }).selectOption("typesafe");
  await card.getByLabel("Model, optional", { exact: true }).fill("jev-1.13.0");
  await card.getByLabel("Timeout in seconds", { exact: true }).fill("4");
  await card.getByLabel("Retries", { exact: true }).fill("2");
  await card.getByLabel("Minimum confidence percent", { exact: true }).fill("84");
  await card.getByRole("button", { name: "Save this setting" }).click();
  await f.page.locator("#jev-decisions-status", { hasText: "Saved." }).waitFor();
  assert.deepEqual(f.app.decisions.settings(), { mode: "when-needed", command: "wsl.exe", args: ["--exec", "jev"],
    provider: "typesafe", model: "jev-1.13.0", timeoutMs: 4000, retries: 2, minConfidence: 0.84 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(f.errors, []);
});

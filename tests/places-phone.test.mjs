/* The places, their tabs and the phone's bars, measured against the approved design (DG-140, DG-143, DG-174).
   Headless only, 127.0.0.1, a temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings, pressUntil } from "./places.mjs";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-places-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false), "the window to connect");
  return { page, errors };
}

test("DG-140: the Inbox's Needs you tab carries the live count, and hides it at none", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => globalThis.branchLayout.go("runs"));
  const count = page.locator('.lx-tab[data-place="inbox"][data-tab="needs"] #lx-needs-tab-count');
  assert.equal(await count.count(), 1, "one count, on the Needs you tab");
  await page.evaluate(() => { const badge = document.getElementById("lx-inbox-badge"); badge.textContent = "2"; badge.hidden = false; });
  await count.waitFor({ state: "visible" });
  assert.equal(await count.innerText(), "2", "the same number as the side list's badge");
  const look = await count.evaluate((node) => { const s = getComputedStyle(node); return [s.fontSize, s.fontWeight, s.marginLeft]; });
  assert.deepEqual(look, ["10.5px", "600", "5px"]);
  await page.evaluate(() => { document.getElementById("lx-inbox-badge").textContent = "3"; });
  await page.waitForFunction(() => document.getElementById("lx-needs-tab-count").textContent === "3");
  await page.evaluate(() => { document.getElementById("lx-inbox-badge").hidden = true; });
  await count.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("DG-143: a phone's bar ends in Customize, and Settings is still behind the gear", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  const bar = page.locator("#ew-places");
  await bar.waitFor({ state: "visible" });
  assert.deepEqual(await bar.locator(".ew-place").evaluateAll((nodes) => nodes.map((node) => node.dataset.place)),
    ["chat", "inbox", "automations", "library", "customize"]);
  await bar.locator('.ew-place[data-place="customize"]').click();
  await page.locator("#customize").waitFor({ state: "visible" });
  assert.equal(await bar.locator('.ew-place[aria-current="page"]').getAttribute("data-place"), "customize");
  await openSettings(page);
  assert.equal(await page.locator("#settings-window").isVisible(), true, "Settings is still reachable from the side list");
  assert.deepEqual(errors, []);
});

test("DG-143: the bar reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal(await page.locator('.ew-place[data-place="customize"] .ew-word').innerText(), "Personnaliser");
  assert.deepEqual(errors, []);
});

/**
 * Q207: after mcp-tools (e155b66c), three cards were still drawn again and again with nothing changed: the devices
 * cards every 5 s, people signing in on every language event, and the days-off part on every 3 s refresh. Each is
 * now swapped in only when what it was drawn from, or how it looks, changed (public/same-card.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function openApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-cards-quiet-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => ["devices-card", "paired-devices-card", "people-signin-admin"].every((id) => document.getElementById(id))
    && document.querySelector('#lx-collab-days-off > [data-part="days-off"]'), undefined, { timeout: 60000 });
  return page;
}
const cards = ['#devices-card', '#paired-devices-card', '#people-signin-admin', '#lx-collab-days-off > [data-part="days-off"]'];

test("with nothing changed, the devices, people and days-off cards are left as they are", async (t) => {
  const page = await openApp(t);
  await page.evaluate((selectors) => { globalThis.q207 = selectors.map((selector) => document.querySelector(selector)); }, cards);
  await page.evaluate(() => { for (let i = 0; i < 3; i++) document.dispatchEvent(new Event("branch-language")); });
  await page.waitForTimeout(7000); // a devices tick (5 s) and two refreshes (3 s)
  const kept = await page.evaluate((selectors) => selectors.map((selector, at) => document.querySelector(selector) === globalThis.q207[at]), cards);
  assert.deepEqual(kept, cards.map(() => true), `each card is still the one first drawn (${cards.filter((_, at) => !kept[at]).join(", ")} was drawn again)`);
});

test("a saved change is still drawn: holding messages overnight shows ticked after the next refresh", async (t) => {
  const page = await openApp(t);
  const part = '#lx-collab-days-off > [data-part="days-off"]';
  await page.evaluate((selector) => { globalThis.q207 = document.querySelector(selector); }, part);
  await page.evaluate(async () => {
    const token = sessionStorage.getItem("branch-token");
    await fetch("/api/calendar", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ quietHours: { enabled: true, from: "22:00", to: "06:00" } }) });
  });
  await page.waitForFunction((selector) => document.querySelector(selector) !== globalThis.q207, part, { timeout: 15000 });
  assert.equal(await page.locator(`${part} #hold-overnight`).isChecked(), true);
});

test("a box clicked whose save was refused is drawn again from what is saved (NAS 11bf954)", async (t) => {
  const page = await openApp(t);
  await page.route("**/api/calendar", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not save" }) }) : route.continue());
  const box = page.locator('#lx-collab-days-off > [data-part="days-off"] #hold-overnight');
  const was = await box.evaluate((input) => input.checked);
  await box.evaluate((input) => { input.checked = !input.checked; input.dispatchEvent(new Event("change")); });
  await page.waitForFunction((value) => document.querySelector('#lx-collab-days-off > [data-part="days-off"] #hold-overnight')?.checked === value, was, { timeout: 15000 });
});

test("a change to something the card does not show still draws it again, so its saves never send an older copy", async (t) => {
  const page = await openApp(t);
  const part = '#lx-collab-days-off > [data-part="days-off"]';
  await page.evaluate((selector) => { globalThis.q207 = document.querySelector(selector); }, part);
  await page.evaluate(async () => {
    const token = sessionStorage.getItem("branch-token");
    await fetch("/api/calendar", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ workingDays: [1, 2, 3, 4] }) });
  });
  await page.waitForFunction((selector) => document.querySelector(selector) !== globalThis.q207, part, { timeout: 15000 });
});

// Mac mini a7d4fd3: the 3 s refresh threw away typing that was not saved yet (the days-off hours, and the number of tasks
// at once on the Scheduled page), on the trunk as well as at Q207. A part being typed in now waits for the owner to leave it.
test("typing in the days-off hours is kept through the refresh, and leaving the field unsaved puts back what is saved", async (t) => {
  const page = await openApp(t);
  await openPlace(page, "settings:notifications");
  const from = '#lx-collab-days-off > [data-part="days-off"] input[type="time"]';
  const was = await page.locator(from).first().inputValue();
  await page.locator(from).first().evaluate((input) => {
    input.focus(); input.value = "23:15"; input.dispatchEvent(new Event("input", { bubbles: true }));
    globalThis.q207typing = input;
  });
  await page.waitForTimeout(7000); // two refreshes
  assert.deepEqual(await page.evaluate(() => [globalThis.q207typing.isConnected, globalThis.q207typing.value]), [true, "23:15"]);
  await page.evaluate(() => globalThis.q207typing.blur());
  await page.waitForFunction(({ selector, value }) => document.querySelector(selector)?.value === value, { selector: from, value: was }, { timeout: 15000 });
});

test("typing the number of tasks at once on the Scheduled page is kept through the refresh", async (t) => {
  const page = await openApp(t);
  await openPlace(page, "automations:scheduled");
  const field = page.locator("#collab-container input[type=number][max='8']");
  await field.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("5");
  await field.evaluate((input) => { globalThis.q207typing = input; });
  await page.waitForTimeout(7000); // two refreshes
  assert.deepEqual(await page.evaluate(() => [globalThis.q207typing.isConnected, globalThis.q207typing.value,
    document.activeElement === globalThis.q207typing]), [true, "5", true]);
});

/* DG-069 / DG-142: Customize opens on a Trunks tab, first before Skills, as the approved sample has it.
   Each Trunk is a row with its face, up and down, Pinned and Edit, all on the Trunk's own record.
   Headless only, 127.0.0.1, a temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { HANDLERS } from "../dist/commands/handlers.js";
import { openPlace, pressUntil, showEverything } from "./places.mjs";

async function fixture(t, { width = 1440, height = 950, colorScheme = "light" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-customize-trunks-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.create({ name: "Ada", title: "Plans trips" });
  app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  const page = await browser.newPage({ viewport: { width, height }, colorScheme, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false), "the window to connect");
  return { app, page, errors };
}
const tabsOf = (page) => page.locator('.lx-tab[data-place="customize"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.tab));
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const order = (app) => app.trunks.records.list().map((trunk) => trunk.name);

for (const everything of [false, true]) {
  test(`Customize opens on Trunks, first before Skills, with Show everything ${everything ? "on" : "off"}`, async (t) => {
    const { page, errors } = await fixture(t);
    if (everything) await showEverything(page);
    await page.evaluate(() => globalThis.branchLayout.go("customize"));
    assert.deepEqual(await tabsOf(page), ["trunks", "skills", "specialists", "plugins", "connections", "channels"]);
    const panel = page.locator('.lx-panel[data-place="customize"][data-tab="trunks"]');
    await panel.waitFor({ state: "visible" });
    assert.equal(await page.locator('.lx-tab[data-place="customize"][data-tab="trunks"]').getAttribute("aria-selected"), "true");
    await panel.locator("#trunks-card #trunks-list .trunk-row").first().waitFor();
    assert.equal(await page.locator('.lx-panel[data-place="customize"][data-tab="specialists"] #trunks-card').count(), 0, "not under Specialists any more");
    assert.deepEqual(errors, []);
  });
}

test("a Trunk's row moves it, pins it and opens its editor, on the Trunk's own record", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "customize:trunks");
  const row = (name) => page.locator("#trunks-list .trunk-row").filter({ hasText: name });
  await row("Bo").waitFor();
  assert.deepEqual(await page.locator("#trunks-list .trunk-row b").allInnerTexts(), ["Ada", "Bo"]);
  assert.match(await row("Ada").locator("small").innerText(), /^Plans trips · @ada$/);

  await row("Bo").getByRole("button", { name: "Move Bo up" }).click();
  await page.waitForFunction(() => document.querySelector("#trunks-list .trunk-row b")?.textContent === "Bo");
  assert.deepEqual(order(app), ["Bo", "Ada"], "the order is kept on the Trunks themselves");

  await row("Ada").getByRole("switch").check();
  await page.waitForFunction(() => document.querySelector("#trunks-list .trunk-row b")?.textContent === "Ada");
  assert.equal(app.trunks.records.list().find((trunk) => trunk.name === "Ada").pinned, true);

  await row("Bo").getByRole("button", { name: "Edit Trunk" }).click();
  assert.equal(await page.locator("#trunks-edit-name").inputValue(), "Bo", "the one editor, inline");

  await page.locator("#trunks-add").click();
  await page.locator("#studio").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("the Trunks tab reads in French on a phone, in dark, without sideways scrolling", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844, colorScheme: "dark" });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.evaluate(() => globalThis.branchLayout.go("customize"));
  const tab = page.locator('.lx-tab[data-place="customize"][data-tab="trunks"]');
  await tab.waitFor({ state: "visible" });
  assert.equal((await tab.innerText()).trim(), "Troncs");
  const bo = page.locator("#trunks-list .trunk-row").filter({ hasText: "Bo" });
  await bo.waitFor();
  assert.equal(await bo.locator(".trunk-pin span").innerText(), "Épinglé");
  assert.equal(await bo.locator(".trunk-move").first().getAttribute("aria-label"), "Monter Bo");
  assert.equal(await page.locator("#trunks-add").innerText(), "Un nouveau Tronc");
  assert.equal(await sideways(page), false);
  assert.deepEqual(errors, []);
});

test("/trunk opens Customize › Trunks, where the Trunks now live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-customize-trunks-cmd-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const host = { runtime: app.runtime, requireOwner: () => undefined };
  const ask = () => HANDLERS.trunk({ host, surface: "window", argument: "", sessionId: undefined, access: "full", mode: "on" });
  const off = await ask();
  assert.deepEqual(off.client, { do: "go", home: "customize:trunks" });
  assert.match(off.text, /Customize → Trunks/);
  app.trunks.setMode("trunks", { mode: "on" });
  assert.deepEqual((await ask()).client, { do: "go", home: "customize:trunks" });
});

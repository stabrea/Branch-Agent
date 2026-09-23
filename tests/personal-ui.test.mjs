/**
 * R17-C: the cards for files, voice, devices and personal connectors, opened the way a person opens
 * them, at 400 px wide, in a headless browser against a scratch workspace. Every word on them is
 * behind a key with real French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the personal cards has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("personal.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(personal\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 50);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/personal.js" type="module"><\/script>/);
});

test("the personal cards sit in their homes, the switches work from the window, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  await openPlace(page, "settings:connections");
  await page.evaluate(() => globalThis.branchSettingsLevel.peekPage()); // its details are Advanced and Technical (DG-195)
  const accounts = page.locator("#personal-accounts-card");
  await accounts.waitFor();
  assert.equal(await accounts.locator("h3.settings-card-title").textContent(), "Your own accounts");
  assert.equal(await page.locator("#personal-switch-google").inputValue(), "off");
  await page.locator("#personal-switch-google").selectOption("when-needed");
  for (let i = 0; i < 100 && app.personal.modes().google !== "when-needed"; i++) await page.waitForTimeout(50);
  assert.equal(app.personal.modes().google, "when-needed");
  await page.locator("#personal-google-client").waitFor();
  await page.locator("#personal-google-client").fill("123.apps.googleusercontent.com");
  await page.locator("#personal-accounts-card").getByRole("button", { name: "Save" }).first().click();
  for (let i = 0; i < 100 && !app.personal.signIns.google.settings().clientId; i++) await page.waitForTimeout(50);
  assert.equal(app.personal.signIns.google.settings().clientId, "123.apps.googleusercontent.com");
  assert.equal(await wide(), false, "no sideways scrolling in Connections");

  for (const [card, home] of [["personal-files-card", "customize:channels"], ["personal-mail-card", "customize:channels"],
    ["personal-tunnel-card", "automations:triggers"], ["personal-voice-card", "settings:voice"], ["personal-x-card", "settings:connections"],
    ["personal-home-card", "settings:connections"]])
    assert.equal(await page.evaluate((id) => document.getElementById(id)?.dataset.home ?? null, card), home, `${card} is not in its home`);
  await openPlace(page, "automations:triggers");
  await page.locator("#personal-tunnel-card").waitFor({ state: "visible" });
  assert.equal(await page.locator("#personal-switch-tunnel").inputValue(), "off");
  assert.equal(await wide(), false, "no sideways scrolling in Triggers");
});

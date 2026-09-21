/**
 * mac7/nodes: the Devices card and the message box's device picker, opened the way a person opens
 * them, at 400 px wide, in English and then in French. The device that asks to join is written in
 * by the test with a key it made; no real device is involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace, openSettings } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { capabilities } from "../dist/devices/capabilities.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the Devices card has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("devices.js", PUBLIC), "utf8");
  const keys = new Set([...source.matchAll(/"(devices\.[a-zA-Z.]+)"/g)].map((m) => m[1]));
  for (const id of capabilities) keys.add(`devices.cap.${id.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`);
  for (const platform of ["darwin", "linux", "win32", "ios", "android"]) keys.add(`devices.platform.${platform}`);
  assert.ok(keys.size > 40);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual([...keys].filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(source), false, "colours come from the tokens only");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/devices.js" type="module"><\/script>/);
  assert.match(await readFile(new URL("../docs/places.md", import.meta.url), "utf8"), /Your devices.*customize:channels/);
});

test("pair, let in, switch on, pick, in English and French at 400 px, with nothing scrolling sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-devices-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  await openPlace(page, "customize:channels");
  const card = page.locator("#devices-card");
  await card.waitFor();
  assert.equal(await card.locator("h2").innerText(), "Your devices");
  assert.equal(await page.evaluate(() => document.getElementById("devices-card")?.parentElement?.id ?? null), "lx-slot-customize-channels", "the card is in its home");
  assert.equal(await page.locator("#devices-mode").inputValue(), "off", "the feature ships off");
  assert.equal(await card.getByRole("button", { name: "Pair a device" }).count(), 0);
  await page.locator("#devices-mode").selectOption("on");
  await card.getByRole("button", { name: "Pair a device" }).click();
  const number = card.locator("#devices-invite p").first();
  await number.waitFor();
  const code = (await number.innerText()).match(/\d{6}/)[0];
  assert.equal(await card.locator("#devices-invite svg rect").count() > 50, true, "the square barcode is drawn");
  assert.match(await card.locator("#devices-invite code").innerText(), /^branch node pair "http:\/\/127\.0\.0\.1:\d+\/devices\/pair\?offer=[a-f0-9]{32}" \d{6}$/);
  assert.equal(await wide(), false, "the invitation fits at 400 px");

  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  app.devices.book.redeem({ offer: app.devices.book.invitation().id, code, name: "action.save", platform: "darwin", publicKey: key,
    offers: ["screen", "notify", "run", "files"] });
  const request = card.locator(".devices-request");
  await request.waitFor({ timeout: 15000 });
  assert.equal(await request.locator("p").first().innerText(), "action.save (Mac computer) asks to join.");
  // phase2/shell integration review: the check code the device shows while it waits, to compare before letting it in.
  assert.match(await request.locator("p.subtle").innerText(), /^Check code [0-9A-F]{4} [0-9A-F]{4}\./);
  // mac7/residuals: "Let it in" waits until the owner ticks that the codes match.
  assert.equal(await request.getByRole("button", { name: "Let it in" }).isDisabled(), true, "not before the codes are compared");
  await request.getByLabel("The code matches").check();
  await request.getByRole("button", { name: "Let it in" }).click();
  const device = card.locator(".devices-device");
  await device.waitFor();
  const [paired] = app.devices.book.devices();
  const boxes = device.locator("input[type=checkbox]");
  assert.equal(await boxes.count(), 4, "one switch for each thing this Mac can offer");
  for (let i = 0; i < 4; i++) assert.equal(await boxes.nth(i).isChecked(), false, "every switch starts off");
  assert.equal(await device.getByText("Not connected yet").count(), 1);
  await device.getByLabel("Take a picture of the screen").check();
  for (let i = 0; i < 100 && !app.devices.book.device(paired.id).enabled.includes("screen"); i++) await page.waitForTimeout(50);
  assert.deepEqual(app.devices.book.device(paired.id).enabled, ["screen"]);
  await device.getByLabel("The one folder it may read and run commands in").fill("/Users/me/Shared");
  await device.getByRole("button", { name: "Save" }).click();
  for (let i = 0; i < 100 && !app.devices.book.device(paired.id).folder; i++) await page.waitForTimeout(50);
  assert.equal(app.devices.book.device(paired.id).folder, "/Users/me/Shared");
  assert.equal(await wide(), false, "the device and its switches fit at 400 px");
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#devices-card :is(h2, p, label, option, button, legend, span)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t && !node.dataset.tTemplate
      && node.getAttribute("role") !== "status" && !node.closest("code") && node.textContent.trim() !== "·")
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "every word on the card comes from a key");

  await openPlace(page, "chat");
  const picker = page.locator("#composer-device");
  await picker.waitFor({ state: "attached", timeout: 15000 });
  assert.deepEqual(await picker.locator("option").allInnerTexts(), ["Any connected device", "action.save"],
    "a device name that resembles a locale key stays literal");
  assert.equal(await wide(), false, "the message box still fits with the picker");

  await openSettings(page, "appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "customize:channels");
  await page.waitForFunction(() => document.querySelector("#devices-card h2")?.textContent === "Vos appareils", null, { timeout: 15000 });
  await card.getByText("Faire une capture de l'écran").waitFor();
  assert.equal(await card.locator(".devices-device h3").innerText(), "action.save");
  assert.equal(await card.getByRole("button", { name: "Retirer cet appareil" }).count(), 1);
  assert.equal(await wide(), false, "French fits at 400 px too");
  await card.getByRole("button", { name: "Retirer cet appareil" }).click();
  for (let i = 0; i < 100 && app.devices.book.devices().length; i++) await page.waitForTimeout(50);
  assert.equal(app.devices.book.devices().length, 0);
  await card.getByText("Aucun appareil n'est encore associé.").waitFor();
  assert.deepEqual(errors, []);
});

/**
 * Settings › Chat apps & devices, the rest of the page (DG-008, DG-025):
 * - every card on the page is titled with one settings card title under its section's heading, never the page-level
 *   h2 it had, and a heading inside a card sits one level lower (DG-008);
 * - a switch the sample saves as you go is kept the moment it changes, with no Save button: More chat apps, Reaching
 *   Branch from other pages, Telegram's switch, While a task works in a chat app and the dashboard. One that will not
 *   save goes back to what is saved and says why. Telegram's token is typed, so it keeps its button (DG-025).
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

const CARDS = ["telegram-setup-card", "channel-setup-card", "channels-more-form", "devices-card", "embeds-card", "personal-mail-card",
  "dashboard-card", "chat-live-form", "chat-permissions-form", "personal-files-card", "reach-chats-card", "reach-relay-card"];
const REFUSED = "Refused for this test.";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-channels-save-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(`/api/${path}`, server.url), {
    method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
  }).then((response) => response.json());
  await call("onboarding", { done: true });
  /* Pausing chat apps switched on, so the card's own heading for the owner's accounts is drawn. */
  await call("reach/switch", { part: "platform-pause", mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.evaluate(() => { globalThis.branchSettingsLevel.set("technical"); globalThis.branchLayout.go("settings:channels"); });
  for (const id of CARDS) await page.locator(`#lx-page-channels > #${id}`).waitFor({ state: "attached", timeout: 20000 });
  await page.locator("#channels-more-list > details").first().waitFor({ state: "attached", timeout: 20000 });
  await page.locator("#telegram-setup-mode").waitFor({ state: "attached", timeout: 20000 });
  await page.locator("#reach-chats-card #reach-owner-sender").waitFor({ state: "attached", timeout: 20000 });
  return { page, errors, call };
}

/** Waits until the saved value reads as wanted, then returns it. */
async function until(read, want) {
  let value;
  for (let i = 0; i < 100; i++) { value = await read(); if (value === want) break; await new Promise((done) => setTimeout(done, 50)); }
  return value;
}

/** Every POST to this address answers with a refusal while `work` runs. */
async function refused(page, path, work) {
  const handler = (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: REFUSED }) }) : route.continue();
  await page.route(`**/api/${path}`, handler);
  try { await work(); } finally { await page.unroute(`**/api/${path}`, handler); }
}

test("DG-008: every card on Chat apps & devices is titled under its section's heading, in both lights", async (t) => {
  const { page, errors } = await fixture(t);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    const shape = await page.evaluate((ids) => ids.map((id) => {
      const card = document.getElementById(id);
      return [id, card.querySelectorAll(":scope > h2").length, card.querySelectorAll(":scope > h3.settings-card-title").length,
        card.querySelectorAll("h1, h2, h3").length];
    }), CARDS);
    assert.deepEqual(shape, CARDS.map((id) => [id, 0, 1, 1]), `${colorScheme}: one card title each, no h2, nothing else at h3 or above`);
    const sizes = await page.evaluate(() => {
      const size = (node) => parseFloat(getComputedStyle(node).fontSize);
      return { section: size(document.getElementById("sg-bucket-channels-talk")),
        cards: [...document.querySelectorAll("#lx-page-channels > .card > h3.settings-card-title")].map(size) };
    });
    assert.ok(sizes.cards.every((size) => size <= sizes.section), `${colorScheme}: no card title is louder than its section's heading`);
  }
  assert.equal(await page.locator("#reach-chats-card > h4.settings-card-subtitle").textContent(), "My own chat accounts",
    "a heading inside a card sits below the card's title");
  assert.deepEqual(errors, []);
});

test("DG-025: Chat apps & devices keeps each switch as it changes, with no Save button, and says why one will not save", async (t) => {
  const { page, errors, call } = await fixture(t);
  /* Set up a chat app keeps "Check and save" for a typed token; tests/settings-channels-dg194.test.mjs covers its switch. */
  const saveButtons = await page.evaluate(() => [...document.querySelectorAll("#lx-page-channels > .card:not(#channel-setup-card) button")]
    .map((button) => `${button.closest(".card").id}: ${button.textContent.trim()}`).filter((line) => /: Save/.test(line)));
  assert.deepEqual(saveButtons, ["telegram-setup-card: Save and connect", "chat-permissions-form: Save what chats may do"],
    "only a typed token and a typed line keep a Save button");

  /* More chat apps: the first chat app that can be switched, with its row left open. */
  const kind = await page.evaluate(() => document.querySelector("#channels-more-list select:not([disabled])").name);
  const parity = async () => (await call("channels/parity")).services.find((service) => service.kind === kind).switch;
  await page.locator(`#channels-more-${kind}`).evaluate((select) => { select.closest("details").open = true; });
  await page.locator(`#channels-more-${kind}`).selectOption("when-needed");
  assert.equal(await until(parity, "when-needed"), "when-needed", "a chat app's switch is kept as it changes");
  await page.locator(`#channels-more-${kind}`).locator("xpath=..").locator("summary", { hasText: /When needed$/ }).waitFor();
  assert.equal(await page.locator(`#channels-more-${kind}`).evaluate((select) => select.closest("details").open), true, "its row stays open");
  await refused(page, "channels/parity", async () => {
    await page.locator(`#channels-more-${kind}`).selectOption("on");
    await page.locator("#channels-more-state", { hasText: REFUSED }).waitFor();
  });
  assert.equal(await page.locator(`#channels-more-${kind}`).inputValue(), "when-needed", "a switch that did not save goes back");

  /* Reaching Branch from other pages: a refusal from before the key was entered is gone once it has loaded. */
  await page.waitForFunction(() => document.getElementById("embeds-status")?.textContent === "", null, { timeout: 10000 }).catch(() => undefined);
  assert.equal(await page.locator("#embeds-status").textContent(), "", "no stale refusal on show");
  await page.locator("#embed-widget").check();
  assert.equal(await until(async () => (await call("embeds")).widget, true), true, "the small ask box is kept as it changes");
  await refused(page, "embeds", async () => {
    await page.locator("#embed-extension").check();
    await page.locator("#embeds-status", { hasText: REFUSED }).waitFor();
  });
  assert.equal(await page.locator("#embed-extension").isChecked(), false, "a switch that did not save goes back");
  assert.equal((await call("embeds")).extension, false);

  /* Telegram: the switch is kept as it changes, and a token being typed stays where it is. */
  await page.locator("#telegram-setup-token").fill("half a token");
  await page.locator("#telegram-setup-mode").selectOption("when-needed");
  assert.equal(await until(async () => (await call("never-break/telegram")).mode, "when-needed"), "when-needed", "Telegram's switch is kept");
  assert.equal(await page.locator("#telegram-setup-token").inputValue(), "half a token", "the typed token is not wiped");
  await refused(page, "never-break/telegram", async () => {
    await page.locator("#telegram-setup-mode").selectOption("on");
    await page.locator("#telegram-setup-card [role=status]", { hasText: REFUSED }).waitFor();
  });
  assert.equal(await page.locator("#telegram-setup-mode").inputValue(), "when-needed", "a switch that did not save goes back");

  /* While a task works in a chat app. */
  await page.locator("#chat-live-steering").selectOption("when-needed");
  assert.equal(await until(async () => (await call("channels")).live.steering, "when-needed"), "when-needed", "a chat switch is kept");
  await refused(page, "channels/live", async () => {
    await page.locator("#chat-live-commands").selectOption("on");
    await page.locator("#chat-live-state", { hasText: REFUSED }).waitFor();
  });
  assert.equal(await page.locator("#chat-live-commands").inputValue(), "off", "a switch that did not save goes back");

  /* The dashboard. */
  await page.locator("#dashboard-mode").selectOption("when-needed");
  assert.equal(await until(async () => (await call("dashboard/settings")).mode, "when-needed"), "when-needed", "the dashboard switch is kept");
  await page.locator("#dashboard-open").waitFor({ state: "visible" });
  await refused(page, "dashboard/settings", async () => {
    await page.locator("#dashboard-mode").selectOption("off");
    await page.locator("#dashboard-card [role=status]", { hasText: REFUSED }).waitFor();
  });
  assert.equal(await page.locator("#dashboard-mode").inputValue(), "when-needed", "a switch that did not save goes back");

  /* In French, the words a switch says when it is kept. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.locator("#chat-live-splitting").selectOption("on");
  await page.locator("#chat-live-state", { hasText: "Enregistré." }).waitFor();
  assert.deepEqual(errors, []);
});

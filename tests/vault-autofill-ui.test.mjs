/**
 * mac7/vault-autofill (R17-068): the "Filling a saved sign-in" card, reached the way a person
 * reaches it — the gear, then Secrets. It starts off, writes down a sign-in without any password
 * going near it, fits a 400-pixel window and reads in French. Headless browser only; no window
 * opens, and no password manager is ever asked anything, because nothing here fills a page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readVaultAutofillSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";

async function fixture(t, viewport) {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-autofill-ui-"));
  const provider = { name: "vault-autofill-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

const settings = (app) => readVaultAutofillSettings(app.store, app.runtime.owner);

test("the card is in Settings, Secrets, starts off, and writes down one sign-in", async (t) => {
  const { app, page, errors } = await fixture(t, { width: 1280, height: 900 });
  await openSettings(page, "secrets");
  const card = page.locator("#vault-autofill");
  await card.waitFor({ state: "visible" });
  assert.equal(settings(app).mode, "off", "a fresh install fills nothing");
  assert.deepEqual(settings(app).logins, []);
  await page.getByText("No sign-ins yet. Add one below and Branch will fill it when you ask.").waitFor();

  await page.getByLabel("Filling a saved sign-in", { exact: true }).selectOption("when-needed");
  await page.getByLabel("What you will call it", { exact: true }).fill("shop");
  await page.getByLabel("The website it belongs to", { exact: true }).fill("example.com");
  await page.getByLabel("The item in your password manager", { exact: true }).fill("My Shop");
  await page.getByLabel("The sign-in page's address", { exact: true }).fill("https://example.com/login");
  // The owner's own extra website names: nothing is worked out from the site above.
  await page.getByLabel("Other website names it signs in on", { exact: true }).fill("accounts.example.com");
  await card.getByRole("button", { name: "Add this sign-in", exact: true }).click();
  await page.locator("#vault-autofill-status", { hasText: "Saved." }).waitFor();

  const saved = settings(app);
  assert.equal(saved.mode, "when-needed");
  assert.deepEqual(saved.logins, [{ name: "shop", site: "example.com", service: "bitwarden", item: "My Shop",
    alsoHosts: ["accounts.example.com"], address: "https://example.com/login", code: false, note: "" }]);
  // The card is a list of names. Nothing on it is a box a password could be typed into.
  assert.equal(await card.locator('input[type="password"]').count(), 0);
  assert.deepEqual(errors, []);
});

test("every control on the card says what it does", async (t) => {
  const { page, errors } = await fixture(t, { width: 1280, height: 900 });
  await openSettings(page, "secrets");
  await page.locator("#vault-autofill").waitFor({ state: "visible" });
  const undescribed = await page.evaluate(() =>
    [...document.querySelectorAll("#vault-autofill :is(input, select, textarea)")]
      .filter((node) => {
        const id = node.getAttribute("aria-describedby");
        const note = id && document.getElementById(id);
        return !note || !note.textContent.trim();
      })
      .map((node) => node.id || node.outerHTML.slice(0, 80)));
  assert.deepEqual(undescribed, [], "these controls have no sentence describing them");
  assert.deepEqual(errors, []);
});

test("the card fits a 400-pixel window and reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openSettings(page, "secrets");
  const card = page.locator("#vault-autofill");
  await card.waitFor({ state: "visible" });
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#vault-autofill")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the vault-autofill card fits inside 400 px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#vault-autofill :is(p, label, button, span, h2, h3)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t
      && node.id !== "vault-autofill-status" && !node.closest(".card-list-row")
      // DG-073: Settings' own "N more" line for the section may sit at the end of this card; it is counted words, said by settings-grown.js.
      && !node.closest(".sg-more-line"))
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "every word on the card has a key");

  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettings(page, "secrets");
  await page.waitForFunction(() =>
    document.querySelector("label[for=vault-autofill-site]")?.textContent === "Le site auquel il appartient");
  // DG-189: the card has no heading of its own; its switch's label names it, as in the sample.
  assert.match(await card.locator("#vault-autofill-mode-label").innerText(), /identifiant enregistré/);
  assert.deepEqual(errors, []);
});

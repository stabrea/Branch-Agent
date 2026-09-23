/* DG-189 and DG-053: Settings › Secrets has the approved sample's sections, in its order: "Keys your commands use",
   then "Passwords and keys", which opens with where Branch reads saved sign-ins from. No card below a section has a
   heading of its own, so the page reads page title, then section titles, whatever the width, level or language.
   The password-manager tiles say only what Branch knows (switched on or not, a Keychain here or not) and save as you
   go. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readCredentialSettings } from "../dist/credential-cli.js";
import { BUCKETS } from "../public/settings-buckets.js";
import { openPlace } from "./places.mjs";

test("DG-189 the Secrets page's sections are the sample's, and every card it had still has a home", () => {
  const sections = BUCKETS.secrets;
  assert.deepEqual(sections.map((bucket) => bucket[2]), ["Keys your commands use", "Passwords and keys"]);
  assert.deepEqual(sections[0][4].map(([card]) => card), ["secrets-form"]);
  assert.deepEqual(sections[1][4].map(([card]) => card), ["secret-managers", "vault-autofill", "keychain-card"]);
});

async function settings(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-secrets-page-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  /* Opened as a person opens it, not through the helper that also shows every card of the page. */
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { app, page, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));
const secrets = async (page) => {
  await page.evaluate(() => globalThis.branchLayout.go("settings:secrets"));
  await page.locator("#secret-managers-grid .secret-manager").first().waitFor();
  await page.waitForTimeout(300);
};
/** The headings a person sees on the page, and its "N more" line. */
const seen = (page) => page.evaluate(() => {
  const shown = (node) => node.getClientRects().length > 0;
  const host = document.getElementById("lx-page-secrets");
  return {
    headings: [...host.querySelectorAll("h1, h2, h3, h4")].filter(shown).map((node) => `${node.tagName} ${node.textContent.trim()}`),
    more: [...host.querySelectorAll(".sg-more")].filter(shown).map((node) => node.textContent.trim()),
  };
});

/* The Keychain card shows only where the computer has a Keychain, so the answer is given here, both ways: the page's
   headings are the sample's with the card on show (as on a Mac) and without it, whatever computer runs the test. */
for (const available of [true, false]) {
  test(`DG-189 the page shows the sample's headings at every width and level, and no card heading of its own (Keychain ${available ? "here" : "not here"})`, async (t) => {
    const { page, errors } = await settings(t, (page) => page.route("**/api/keychain/settings", (route) => route.fulfill({
      json: { enabled: false, mode: "off", entries: [], available, references: [] } })));
    const hiddenAtRegular = available ? "3 more with Advanced" : "1 more with Technical";
    for (const width of [1440, 860, 400]) {
      await page.setViewportSize({ width, height: 950 });
      for (const [one, more] of [["regular", [hiddenAtRegular]], ["advanced", null]]) {
        await level(page, one);
        await secrets(page);
        if (available && one === "advanced") assert.equal(await page.locator("#keychain-card").isVisible(), true, `${width} px: the Keychain card is on show`);
        const { headings, more: line } = await seen(page);
        assert.deepEqual(headings, ["H2 Secrets", "H3 Keys your commands use", "H3 Passwords and keys"], `${width} px, ${one}`);
        if (more) assert.deepEqual(line, more, `${width} px, ${one}: what is out of sight`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${width} px fits`);
      }
    }
    if (available) {
      /* The card's words are its switch's label, in English and in French. */
      assert.equal(await page.locator("#keychain-card").getAttribute("aria-labelledby"), "keychain-card-label");
      assert.equal(await page.locator("#keychain-card-mode").evaluate((node) => node.labels[0].textContent), "Passwords from your Mac's Keychain");
      await openPlace(page, "settings:appearance");
      await page.locator("#appearance-language").selectOption("fr");
      await page.waitForFunction(() => document.getElementById("keychain-card-label")?.textContent === "Mots de passe du trousseau de votre Mac");
    }
    assert.deepEqual(errors, []);
  });
}

test("DG-053 where Branch reads saved sign-ins from: truthful tiles that save as you go, and French", async (t) => {
  const { app, page, errors } = await settings(t);
  await level(page, "regular");
  await secrets(page);
  const tiles = page.locator("#secret-managers .secret-manager");
  const words = () => tiles.evaluateAll((all) => all.map((tile) => [tile.querySelector("b").textContent, tile.querySelector(".secret-manager-pill").textContent]));
  const keychain = process.platform === "darwin" ? "Available" : "Only on a Mac";
  assert.deepEqual(await words(), [["Your Mac's Keychain", keychain], ["Bitwarden", "Not set up"], ["1Password", "Not set up"]]);
  assert.equal(await page.locator("#secret-managers input").count(), 0, "nothing here could hold a password");

  await page.locator("#secret-managers-bitwarden").click();
  await page.locator("#secret-managers-status", { hasText: "Saved." }).waitFor();
  assert.deepEqual(await words(), [["Your Mac's Keychain", keychain], ["Bitwarden", "On"], ["1Password", "Not set up"]]);
  let saved = readCredentialSettings(app.store, app.runtime.owner);
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.services, ["bitwarden"]);
  assert.equal(await page.locator("#secret-managers-bitwarden").getAttribute("title"), "Branch stops reading from it. Nothing in your password manager is changed.");

  await page.locator("#secret-managers-bitwarden").click();
  await page.waitForFunction(() => document.querySelector("#secret-managers-bitwarden")?.textContent === "Set up");
  saved = readCredentialSettings(app.store, app.runtime.owner);
  assert.equal(saved.enabled, false, "the last one off turns reading from a password manager off");
  assert.deepEqual(saved.services, []);

  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await secrets(page);
  await page.waitForFunction(() => document.querySelector("#secret-managers-title")?.textContent === "Où Branch lit les identifiants enregistrés");
  const { headings } = await seen(page);
  assert.deepEqual(headings.slice(1), ["H3 Les clés de vos commandes", "H3 Mots de passe et clés"]);
  assert.deepEqual(errors, []);
});

test("DG-189 the Keychain card saves as you go, with no Save button (DG-025)", async (t) => {
  /* The Keychain is a Mac's: the answer is a Mac's here, so the card shows on any computer, and each save is kept. */
  const posts = [];
  let saved = { enabled: false, mode: "off", entries: [], available: true, references: [] };
  const { page, errors } = await settings(t, (page) => page.route("**/api/keychain/settings", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      posts.push(body);
      saved = { ...saved, ...body, enabled: body.mode !== "off" };
    }
    await route.fulfill({ json: saved });
  }));
  /* The sample's count on a Mac: the Keychain's switch, its list and the saved sign-ins wait for Advanced. */
  await level(page, "regular");
  await secrets(page);
  await page.waitForFunction(() => !document.getElementById("keychain-card")?.hidden);
  assert.deepEqual((await seen(page)).more, ["3 more with Advanced"]);
  await level(page, "advanced");
  await secrets(page);
  const card = page.locator("#keychain-card");
  await card.waitFor({ state: "visible" });
  assert.deepEqual(await card.locator("button:not(.quiet-button, .sg-more)").count(), 0, "no Save button");
  /* As on a Mac in the sample: at Advanced, the Keychain's list and the saved sign-ins are what is out of sight. */
  assert.deepEqual((await seen(page)).more, ["2 more with Technical"]);
  await page.locator("#keychain-card-mode").selectOption("when-needed");
  await page.waitForFunction(() => document.querySelector("#keychain-card .subtle, #keychain-card [role=status]"));
  await page.waitForTimeout(300);
  assert.deepEqual(posts.at(-1), { mode: "when-needed", entries: [] });
  await level(page, "technical");
  await page.locator("#keychain-name").fill("npm");
  await page.locator("#keychain-service").fill("npm registry");
  await page.locator("#keychain-add").click();
  await page.waitForFunction((count) => document.querySelectorAll("#keychain-list .card-row").length === count, 1);
  await page.waitForTimeout(300);
  assert.deepEqual(posts.at(-1), { mode: "when-needed", entries: [{ name: "npm", service: "npm registry", note: "" }] });
  await page.locator("#keychain-list .card-row button").click();
  await page.waitForTimeout(300);
  assert.deepEqual(posts.at(-1), { mode: "when-needed", entries: [] });
  assert.deepEqual(errors, []);
});

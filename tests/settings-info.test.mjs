import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

/*
 * The "i" beside every setting's name, as the sample has it (public/settings-describe.js).
 *
 * This walks every Settings page and every Models tab as a fresh install shows them, and checks each
 * visible control that has a label with words in it: the "i" must sit straight after that label, be
 * visible, and say what it is about. Controls with no label (six on Permissions, one on Data) are not
 * counted; there is no name to hang an "i" on. It then presses one "i" and checks what it opens, and
 * that the control kept its exact name -- an "i" inside the label would have joined the name.
 */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");
const MODEL_TABS = ["connection", "defaults", "local", "second", "media"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-info-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  return { page, errors };
}

/** The "i" straight after the label wrapped round the control `selector` finds. */
const infoFor = (page, selector) => page.locator(selector)
  .locator("xpath=ancestor::label[1]/following-sibling::*[1][contains(@class, 'kit-info')]");

/** Named controls on the open page with no visible "i" after their label, and how many were checked. */
function auditOpenPage(where) {
  const shown = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const missing = [];
  let named = 0;
  for (const control of document.querySelectorAll(".lx-page:not([hidden]) .card :is(input:not([type=hidden]), select, textarea)")) {
    const segmented = control.closest(".segmented-control");
    if (!shown(control) && !(segmented && shown(segmented))) continue;
    const label = [...(control.labels ?? [])].find((node) => node.textContent.trim());
    if (!label) continue;
    named++;
    const info = label.nextElementSibling;
    if (!info?.classList.contains("kit-info") || !shown(info) || info.getAttribute("aria-label") !== "About this setting"
      || document.getElementById(info.getAttribute("aria-describedby")) !== label)
      missing.push(`${where}: ${control.id ? `#${control.id}` : control.name || control.type}`);
  }
  return { named, missing };
}

test("every named setting has an i after its name, on every Settings page", async (t) => {
  const { page, errors } = await fixture(t);
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-page")].map((node) => node.dataset.page));
  assert.ok(pages.length >= 12, "the Settings pages moved; this test is looking in the wrong place");
  const missing = [];
  let named = 0;
  for (const name of pages) {
    await openSettings(page, name);
    for (const tab of name === "models" ? MODEL_TABS : [null]) {
      if (tab) await page.locator(`#lx-page-models .lx-subtab[data-sub="${tab}"]`).click();
      /* A tab that draws its controls from an answer draws them a moment later: wait for the page to
         settle (nothing missing), up to three seconds, and report whatever is still missing then. */
      let result;
      for (let tries = 0; tries < 20; tries++) {
        result = await page.evaluate(auditOpenPage, tab ? `models:${tab}` : name);
        if (!result.missing.length) break;
        await page.waitForTimeout(150);
      }
      named += result.named;
      missing.push(...result.missing);
    }
  }
  assert.ok(named > 250, `only ${named} named controls were found; the walk is not reaching the pages`);
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
});

test("the i opens the setting's name, what it does and when to change it, and leaves the control alone", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  /* The label names this computer's system once the page knows it, so read the words it shows now. */
  const name = await page.locator("#start-with-windows").evaluate((control) => control.labels[0].textContent.trim());
  assert.match(name, /^Start Branch when I sign in to /);
  assert.equal(await page.getByRole("switch", { name, exact: true }).count(), 1, "the switch keeps its exact name");
  /* A loose lookup by the setting's words finds the switch alone: the i's own name does not repeat them. */
  assert.equal(await page.getByLabel(name).count(), 1, "the i is not found by the setting's words");
  const info = infoFor(page, "#start-with-windows");
  assert.equal(await info.getAttribute("aria-label"), "About this setting");
  assert.equal(await info.evaluate((node) => document.getElementById(node.getAttribute("aria-describedby"))?.textContent.trim()), name,
    "and a screen reader hears which setting it is about");
  const before = await page.locator("#start-with-windows").isChecked();
  await info.click();
  const pop = page.getByRole("dialog", { name: "About this setting" });
  await pop.waitFor({ state: "visible" });
  const words = await pop.innerText();
  assert.match(words, new RegExp(`^${name}`));
  assert.match(words, /What this does\s+Branch opens by itself when you sign in/);
  assert.match(words, /When you'd change it\s+If the way it ships doesn't suit you/);
  assert.equal(await info.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#start-with-windows").isChecked(), before, "pressing the i does not flip the switch");

  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });
  assert.equal(await info.evaluate((node) => document.activeElement === node), true, "Escape gives the keyboard back to the i");
  assert.equal(await page.locator("#settings-window").isVisible(), true, "one Escape closes one thing");

  await info.click();
  await pop.waitFor({ state: "visible" });
  await info.click();
  await pop.waitFor({ state: "hidden" });
  await info.click();
  await pop.waitFor({ state: "visible" });
  await page.mouse.click(5, 500);
  await pop.waitFor({ state: "hidden" });
});

test("a setting with its own reason to change says it", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  await infoFor(page, "#phone-switch").click();
  const pop = page.getByRole("dialog", { name: "About this setting" });
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /Switch it on when you want to use Branch from your phone\./);
});

test("the i's words are in English and real French", async () => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  const source = await readFile(join(import.meta.dirname, "..", "public", "settings-describe.js"), "utf8");
  const keys = [...source.matchAll(/"(settings-kit\.info\.[\w.-]+)", "([^"]+)"/g)];
  assert.ok(keys.length >= 7, "the i's words moved out of settings-describe.js");
  for (const [, key, english] of keys) {
    assert.equal(en[key], english, `${key}: en.json should say what settings-describe.js says`);
    assert.ok(fr[key] && fr[key] !== english, `${key} needs real French`);
  }
});

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
 * R17-S01 and R17-S04: every control in Settings says what it does, and every Settings card says how
 * far it reaches.
 *
 * This walks every Settings page (and every Models tab) the way a person does, and checks each
 * visible input, select and text box inside a card, as a fresh install shows them. It covers the
 * Settings window only — the audit row's home is "all Settings" — not the five places, and it does not
 * reach controls that only appear once something is switched on or unfolded (those still get their
 * descriptions from the same table, but nothing here proves it).
 *
 * A control passes when `aria-describedby` points at words on the page. That happens when:
 *   - the card writes its own note and links it (`<p class="field-note" id="x-note">`, and
 *     `aria-describedby="x-note"` on the control), or
 *   - a `.field-note` sits straight after the control (or after the label it is inside), or
 *   - the control has a row in public/settings-descriptions.js (with its words in en.json and fr.json).
 */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");
const MODEL_TABS = ["connection", "defaults", "local", "second", "media"];

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-describe-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#settings-kit-files").waitFor({ state: "attached", timeout: 60000 });
  return { page, errors };
}

/** What is wrong on the Settings page that is open now. */
function auditOpenPage(where) {
  const shown = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const name = (control) => control.id ? `#${control.id}` : `${control.tagName.toLowerCase()}[${control.name || control.type || ""}] in #${control.closest(".card")?.id || "?"}`;
  const problems = [];
  for (const card of document.querySelectorAll(".lx-page:not([hidden]) .card")) {
    if (!shown(card)) continue;
    const heading = card.querySelector(":scope > h2");
    const cardName = card.id || heading?.textContent.trim() || "a card with no id";
    if (!heading || heading.nextElementSibling?.tagName !== "P")
      problems.push(`${where}: card ${cardName} needs an <h2> followed by one sentence saying what it is for`);
    if (!card.querySelector(":scope > .kit-scope[data-t]"))
      problems.push(`${where}: card ${cardName} has no scope chip (public/settings-describe.js adds it; give the card an <h2>)`);
    for (const control of card.querySelectorAll("input:not([type=hidden]), select, textarea")) {
      if (!shown(control)) continue;
      const ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      const words = ids.map((id) => document.getElementById(id)?.textContent.trim() ?? "").join(" ");
      if (!words) problems.push(`${where}: ${name(control)} has no description. Add a row to public/settings-descriptions.js `
        + "(with words in public/locales/en.json and fr.json), or a <p class=\"field-note\"> right after it linked by aria-describedby");
    }
  }
  return problems;
}

test("R17-S01/S04: every Settings control has a description, and every Settings card a purpose and a scope chip", async (t) => {
  const { page, errors } = await fixture(t);
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-page")].map((node) => node.dataset.page));
  assert.ok(pages.length >= 12, "the Settings pages moved; this test is looking in the wrong place");
  const problems = [];
  let checked = 0;
  for (const name of pages) {
    await openSettings(page, name);
    for (const tab of name === "models" ? MODEL_TABS : [null]) {
      if (tab) await page.locator(`#lx-page-models .lx-subtab[data-sub="${tab}"]`).click();
      await page.waitForTimeout(400);
      problems.push(...await page.evaluate(auditOpenPage, tab ? `models:${tab}` : name));
      checked += await page.evaluate(() => document.querySelectorAll(".lx-page:not([hidden]) .card :is(input, select, textarea)").length);
    }
  }
  assert.ok(checked > 150, `only ${checked} controls were found; the walk is not reaching the pages`);
  assert.deepEqual(problems, []);
  assert.deepEqual(errors, []);
});

test("R17-S01: the descriptions are in English and real French, and show in the language chosen", async (t) => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  const { descriptions, switchDescription } = await import("../public/settings-descriptions.js");
  for (const [selector, key, english] of [...descriptions, ["(switch)", ...switchDescription]]) {
    assert.equal(en[key], english, `${selector}: en.json should say what settings-descriptions.js says`);
    assert.ok(fr[key] && fr[key] !== english, `${selector}: ${key} needs real French`);
  }
  const { page } = await fixture(t);
  await openSettings(page, "permissions");
  await page.locator("#loop-guard-mode").waitFor({ state: "visible" });
  const described = () => page.evaluate(() => {
    const id = document.getElementById("loop-guard-mode").getAttribute("aria-describedby");
    return document.getElementById(id)?.textContent;
  });
  assert.equal(await described(), en["describe.loop-guard"]);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction((words) => {
    const id = document.getElementById("loop-guard-mode").getAttribute("aria-describedby");
    return document.getElementById(id)?.textContent === words;
  }, fr["describe.loop-guard"]);
  const chips = await page.evaluate(() => [...document.querySelectorAll(".lx-page:not([hidden]) .kit-scope")].map((node) => node.textContent));
  assert.ok(chips.length && chips.every((words) => words.startsWith("S'applique")), "the scope chips follow the language");
});

test("R17-S04: the scope chip says project for project cards, this computer for appearance, everything otherwise", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  const scopeOf = (id) => page.evaluate((cardId) => document.getElementById(cardId)?.querySelector(":scope > .kit-scope")?.dataset.scope, id);
  await page.waitForFunction(() => document.querySelector("#projects-form > .kit-scope"));
  assert.equal(await scopeOf("projects-form"), "project");
  assert.equal(await scopeOf("context-project"), "project");
  assert.equal(await scopeOf("settings-kit-presets"), "everything");
  await openSettings(page, "appearance");
  assert.equal(await scopeOf("settings-form"), "computer");
  // A card can say for itself; a Trunk card will.
  await page.evaluate(() => { document.getElementById("settings-kit-presets").dataset.scope = "trunk"; globalThis.branchDescribeSettings(); });
  await page.waitForFunction(() => document.querySelector("#settings-kit-presets > .kit-scope")?.dataset.scope === "trunk");
});

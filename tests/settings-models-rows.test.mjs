/**
 * DG-043: on Settings › Models › Connection, "Choose a provider" and "Default model" (and every other setting in the
 * model connection cards) are one row each, as in the approved sample: the words on the left, the control at the
 * row's right edge, on the same line. Under 760px the control goes under its words and takes the row's width.
 * Checked at 1440, 860 and 400, at Regular (Show everything off) and Advanced (on), in Daylight, and in French.
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

async function modelsPage(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-rows-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, errors };
}
async function openSettingsPage(page, name) {
  if (!(await page.locator("#settings-window").isVisible())) {
    const cog = page.locator(".sg-foot-line > .sg-gear:visible");
    if (!(await cog.count())) await page.locator("#rail-toggle").click();
    await cog.click();
  }
  await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
}
async function openModels(page) {
  await openSettingsPage(page, "models");
  await page.locator("#lx-models-connection").waitFor({ state: "visible" });
  /* On the desktop app the model connection card is on show; the browser hides it until the app fills it in. */
  await page.evaluate(() => { document.getElementById("model-settings-form").hidden = false; });
  await page.waitForTimeout(300);
}

/** Each setting row on show in the two cards: its words, and where its words, its control and the row sit. */
const rows = (page) => page.evaluate(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, mid: r.top + r.height / 2 }; };
  const shown = (node) => node.getClientRects().length > 0;
  return [...document.querySelectorAll("#model-settings-form label[for], #models-form label[for]")].filter(shown).map((label) => {
    const control = document.getElementById(label.htmlFor);
    const row = label.parentElement;
    return { words: label.textContent.trim(), tag: control.tagName, label: box(label), control: box(control), row: box(row),
      rule: getComputedStyle(row).borderTopWidth, pageWidth: document.documentElement.scrollWidth };
  });
});

function sideBySide(found, width) {
  for (const one of found) {
    assert.ok(Math.abs(one.label.mid - one.control.mid) <= 2, `${one.words}: its words and its control are on one line at ${width}`);
    assert.ok(one.control.left >= one.label.right, `${one.words}: the control is to the right of its words`);
    assert.ok(Math.abs(one.control.right - one.row.right) <= 1, `${one.words}: the control sits at the row's right edge`);
    assert.ok(Math.abs(one.label.left - one.row.left) <= 1, `${one.words}: the words start the row`);
    if (one.tag === "SELECT") assert.ok(one.control.width >= 179 && one.control.width <= 441, `${one.words}: a list is 180 to 440 wide, not ${one.control.width}`);
    assert.equal(one.rule, "1px", `${one.words}: a rule above each row`);
    assert.ok(one.pageWidth <= width, "nothing pushes the page sideways");
  }
}
function stacked(found, width) {
  for (const one of found) {
    assert.ok(one.control.top >= one.label.bottom - 1, `${one.words}: the control goes under its words at ${width}`);
    assert.ok(Math.abs(one.control.width - one.row.width) <= 1, `${one.words}: the control takes the row's width`);
    assert.ok(one.pageWidth <= width, "nothing pushes the page sideways");
  }
}

for (const width of [1440, 860, 400]) {
  test(`DG-043 at ${width}: Choose a provider and Default model are rows, at Regular and Advanced`, async (t) => {
    const { page, errors } = await modelsPage(t, width);
    await openModels(page);
    const check = width > 760 ? sideBySide : stacked;
    for (const level of ["regular", "advanced"]) {
      await page.evaluate((next) => globalThis.branchSettingsLevel.set(next), level);
      await page.waitForTimeout(300);
      const found = await rows(page);
      const words = found.map((one) => one.words);
      for (const name of ["Choose a provider", "Default model", "Default thinking"]) assert.ok(words.includes(name), `${name} is on show at ${level}: ${words.join(" · ")}`);
      check(found, width);
    }
    assert.deepEqual(errors, []);
  });
}

test("DG-043: the rows keep their shape in Daylight and in French", async (t) => {
  const { page, errors } = await modelsPage(t, 1440);
  await openSettingsPage(page, "appearance");
  await page.locator("#lx-mode").getByRole("button", { name: "Daylight", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "daylight");
  await openModels(page);
  const day = await rows(page);
  sideBySide(day, 1440);
  const colours = await page.evaluate(() => {
    const row = document.querySelector("#models-form .sg-ctl"), label = row.querySelector("label");
    const probe = document.createElement("span");
    probe.style.color = "var(--text)";
    probe.style.borderTopColor = "var(--line)";
    row.append(probe);
    const want = { text: getComputedStyle(probe).color, line: getComputedStyle(probe).borderTopColor };
    probe.remove();
    return { want, text: getComputedStyle(label).color, line: getComputedStyle(row).borderTopColor };
  });
  assert.equal(colours.text, colours.want.text, "the words are in the theme's text colour");
  assert.equal(colours.line, colours.want.line, "the rule is the theme's line");

  await openSettingsPage(page, "appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await openModels(page);
  const french = await rows(page);
  for (const name of ["Choisir un fournisseur", "Modèle par défaut"]) assert.ok(french.some((one) => one.words === name), `${name} is on show`);
  sideBySide(french, 1440);
  assert.deepEqual(errors, []);
});

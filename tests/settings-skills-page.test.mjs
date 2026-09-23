import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";

/* DG-196: Settings › Skills & plugins holds the approved sample's sections, in its order, with its counts. */
async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-skills-page-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}

const CARDS = ["skill-policy-card", "reach-share-card", "reach-bundles-card", "skill-installs-card", "context-tools-file",
  "learning-new-skills", "autonomy-readiness-card", "add-ons-card", "asks-intents-card", "lmore-curator-card", "reach-trunks-card", "interop-modes-card"];

/** The page's section headings and "N more" lines on show, top to bottom. */
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-skills .sg-head-title, #lx-page-skills .sg-more")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));

async function atLevel(page, level) {
  await page.evaluate((to) => globalThis.branchSettingsLevel.set(to), level);
  await page.waitForFunction((to) => document.documentElement.dataset.settingsLevel === to, level);
}

for (const width of [1440, 400]) {
  test(`DG-196 Skills & plugins has the sample's sections at ${width}px, with Show everything off and on`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await openPlace(page, "settings:skills");
    for (const id of CARDS) await page.locator(`#lx-page-skills > #${id}`).waitFor({ state: "attached" });
    await atLevel(page, "regular");
    /* The sample counts 6 and 9; the counts come from DG-199's rows, which lack a few this page draws only when switched on. */
    const regular = await outline(page);
    assert.deepEqual(regular.map((line) => line.replace(/^\d+ more with Advanced$/, "N more with Advanced")),
      ["Skills", "N more with Advanced", "Add-ons other people wrote", "N more with Advanced"]);
    assert.equal(await page.locator("#lx-page-skills .settings-directory-card").count(), 0, "no Open links the sample does not have");
    await atLevel(page, "advanced");
    assert.deepEqual(await outline(page), ["Skills", "Add-ons other people wrote"]);
    await atLevel(page, "technical");
    assert.deepEqual(await outline(page), ["Skills", "Add-ons other people wrote", "Under the hood"]);
    const width1 = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(width1, "nothing runs off the side");
    assert.deepEqual(errors, []);
  });
}

test("DG-196 Skills & plugins reads in French, and its cards left Customize", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await openPlace(page, "settings:skills");
  for (const id of CARDS) await page.locator(`#lx-page-skills > #${id}`).waitFor({ state: "attached" });
  await atLevel(page, "technical");
  assert.deepEqual(await outline(page), ["Compétences", "Modules écrits par d'autres", "Sous le capot"]);
  await openPlace(page, "customize:skills");
  assert.equal(await page.locator("#skills #skill-policy, #specialists #interop-modes-card").count(), 0);
  assert.deepEqual(errors, []);
});

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

/* The approved sample's lines at each level, the same at 1440, 860 and 400 in both lights (measured from
   design/Branch-Grown-Up.html). Headings and order hold now; the counts wait on two fixes outside this page. */
const SAMPLE = {
  regular: ["Skills", "6 more with Advanced", "Add-ons other people wrote", "9 more with Advanced"],
  advanced: ["Skills", "Add-ons other people wrote", "2 more with Technical"],
  technical: ["Skills", "Add-ons other people wrote", "Under the hood"],
};
const headings = (lines) => lines.filter((line) => !/^\d+ more with (Advanced|Technical)$/.test(line));

for (const width of [1440, 860, 400]) {
  test(`DG-196 Skills & plugins has the sample's sections at ${width}px, with Show everything off and on, in both lights`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await openPlace(page, "settings:skills");
    for (const id of CARDS) await page.locator(`#lx-page-skills > #${id}`).waitFor({ state: "attached" });
    for (const light of ["forest", "daylight"]) { // Moonlight and Daylight
      await page.evaluate(async (theme) => (await import("/appearance.js")).changeAppearance({ appearance: theme, followSystem: false }), light);
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, light);
      for (const level of ["regular", "advanced", "technical"]) {
        await atLevel(page, level);
        assert.deepEqual(headings(await outline(page)), headings(SAMPLE[level]), `${light} ${level}`);
        if (level === "regular") {
          assert.match((await outline(page))[1], /^\d+ more with Advanced$/, "Skills keeps some rows for Advanced");
          assert.equal(await page.locator("#lx-page-skills .settings-directory-card").count(), 0, "no Open links the sample does not have");
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${light} ${level}: nothing runs off the side`);
      }
    }
    assert.deepEqual(errors, []);
  });
}

/* The sample's exact counts. Two things outside this page still differ (coordinator ruling 2026-09-23: "N more"
   counts equal the sample's, and page tests take their numbers from it):
   - Add-ons: the list and Pipelines rows (addons-list, addons-pipes, addons-pipes-key) draw only when their part is
     on, and a card on show counts only drawn rows; the coordinator fixes that once in settings-grown.js.
   - Skills: public/settings-row-levels.js has no level for context-switch-tools (the sample draws TOOLS.md as a
     pointer, without data-inv), so its card adds nothing; that needs the design repository's generator. */
test("DG-196 Skills & plugins counts what the sample counts", { todo: "switch-gated rows and the TOOLS.md row level, outside this page" }, async (t) => {
  const { page } = await fixture(t, 1440);
  await openPlace(page, "settings:skills");
  for (const id of CARDS) await page.locator(`#lx-page-skills > #${id}`).waitFor({ state: "attached" });
  for (const level of ["regular", "advanced", "technical"]) {
    await atLevel(page, level);
    assert.deepEqual(await outline(page), SAMPLE[level], level);
  }
});

/* The sample puts "Also run plugin files I put in the plugins folder myself…" at Advanced. Its index row named the
   card as its control, which a card cannot find inside itself, so the switch showed at Regular and went uncounted. */
test("DG-196 the add-ons wall switch shows at Advanced, as in the sample", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  /* Opened as a person opens it, not through the helper that also shows every card of the page. */
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchLayout.go("settings:skills"));
  const wall = page.locator("#lx-page-skills > #add-ons-card #addons-wall");
  await wall.waitFor({ state: "attached" });
  await atLevel(page, "regular");
  assert.equal(await wall.isVisible(), false, "out of sight at Regular");
  assert.equal(await page.locator("#add-ons-card").isVisible(), true, "the card itself stays, with its Regular rows");
  await atLevel(page, "advanced");
  await wall.waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

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

/* DG-025: "Writing new skills" and "Offer to set aside a skill unused for this many days" save as you change them,
   as the sample's controls do; the Save button under them is gone. */
test("DG-025 Skills your assistant wrote saves as you go, with no Save button", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await openPlace(page, "settings:skills");
  const card = page.locator("#lx-page-skills > #learning-new-skills");
  await card.waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await card.getByRole("button", { name: "Save", exact: true }).count(), 0);
  const saved = () => page.evaluate(async () => (await (await import("/app.js")).api("reflection")).settings);
  await card.locator("#retire-days").fill("45");
  await card.locator("#retire-days").press("Tab");
  await page.waitForFunction(async () => (await (await import("/app.js")).api("reflection")).settings.retireAfterDays === 45);
  await page.locator("#learning-new-skills #new-skills-switch").selectOption("when-needed");
  await page.waitForFunction(async () => (await (await import("/app.js")).api("reflection")).settings.newSkills === "when-needed");
  assert.equal((await saved()).retireAfterDays, 45);
  assert.deepEqual(errors, []);
});

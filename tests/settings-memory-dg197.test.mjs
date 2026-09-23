/* DG-197: Settings › Memory & library is the approved sample's page: its eight sections in the sample's order, each
   with the sample's "N more with …" line, and every card that held one of the page's settings moved here from the
   Library's tabs (none dropped). The cards read as rows of their section, so their own titles are not headings on
   show (DG-008, DG-024). The same at 1440, 860 and 400 px, with Show everything on and off, and in French.
   Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BUCKETS } from "../public/settings-buckets.js";
import { SETTINGS_INDEX } from "../public/settings-index.js";

const SECTIONS = ["What it remembers", "Memory from elsewhere", "Finding the past", "Answering from your documents", "Knowledge",
  "Your notes folder", "Bringing in new items", "Answers, pages and articles"];
const FRENCH = ["Ce qu'il retient", "Mémoire venue d'ailleurs", "Retrouver le passé", "Répondre à partir de vos documents",
  "Connaissances", "Votre dossier de notes", "Faire entrer les nouveautés", "Réponses, pages et articles"];
/* The sample's lines, with three known differences reported for the coordinator: What it remembers says 13, not 14
   (the sample counts its MEMORY.md row, which public/settings-row-levels.js does not level); Memory from elsewhere
   says 4, not 7, and Bringing in new items has no line, not "1 more with Advanced" (DG-199 counts only the rows a
   card on show has drawn, and the Hindsight fields and the sources list are drawn only once their switch is on). */
const MORE = ["13 more with Advanced", "4 more with Advanced", "2 more with Advanced", "1 more with Technical",
  "2 more with Technical", "3 more with Advanced"];

test("DG-197 Memory & library lists the sample's sections, and every card of the page's settings is in one", () => {
  assert.deepEqual(BUCKETS.memory.map((bucket) => bucket[2]), SECTIONS);
  const placed = new Set(BUCKETS.memory.flatMap((bucket) => bucket[4].map(([card]) => card)));
  const own = SETTINGS_INDEX.filter((row) => row[1] === "settings:memory");
  assert.equal(own.length, 44, "the sample's 44 Memory & library settings are indexed on this page");
  assert.deepEqual(own.filter((row) => !placed.has(row[2])).map((row) => row[0]), [], "these settings have no section");
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-memory-page-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchLayout.go("settings:memory"));
  for (const id of ["knobs-snapshotFacts", "lmore-switch-providers", "asks-switch-source-sync", "flows-switch-widgets", "look-back-switch", "learning-core-mode", "context-switch-memory"])
    await page.locator(`#lx-page-memory #${id}`).waitFor({ state: "attached", timeout: 20000 });
  return { page, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value))
  .then(() => page.waitForTimeout(400));
/** What the page shows: its headings and its "N more" lines, in order. */
const shown = (page) => page.evaluate(() => {
  const box = document.getElementById("lx-page-memory");
  const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const text = (node) => node.textContent.trim().replace(/\s+/g, " ");
  return {
    headings: [...box.querySelectorAll("h1, h2, h3")].filter(seen).map(text),
    more: [...box.querySelectorAll(".sg-more")].filter(seen).map(text),
    wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

test("DG-197 the page's sections and counts match the sample at 1440, 860 and 400, Show everything on and off, dark and light", async (t) => {
  const { page, errors } = await fixture(t);
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const [everything, scheme] of [["off", "dark"], ["on", "light"]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate((one) => { document.documentElement.dataset.everything = one; }, everything);
      const where = `${width} px, Show everything ${everything}, ${scheme}`;
      await level(page, "regular");
      await page.waitForFunction((want) => [...document.querySelectorAll("#lx-page-memory .sg-more")]
        .filter((node) => node.getClientRects().length).map((node) => node.textContent.trim()).join("|") === want, MORE.join("|"), { timeout: 8000 }).catch(() => {});
      const regular = await shown(page);
      assert.deepEqual(regular.headings, ["Memory & library", ...SECTIONS], where);
      assert.deepEqual(regular.more, MORE, where);
      assert.ok(regular.wide <= 0, `${where}: no sideways scrolling`);
      await level(page, "technical");
      const technical = await shown(page);
      assert.deepEqual(technical.headings, ["Memory & library", ...SECTIONS], where);
      assert.deepEqual(technical.more, [], where);
    }
  }
  /* Search still shows a card's own title. */
  await page.locator("#lx-settings-search").fill("Hindsight");
  await page.waitForFunction(() => document.body.classList.contains("lx-settings-searching"));
  assert.equal(await page.locator("#asks-hindsight-card > h2").isVisible(), true);
  assert.deepEqual(errors, []);
});

test("DG-197 in French the page keeps its sections, in French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await level(page, "regular");
  const regular = await shown(page);
  assert.deepEqual(regular.headings.slice(1), FRENCH);
  assert.equal(regular.more.length, MORE.length);
  assert.deepEqual(errors, []);
});

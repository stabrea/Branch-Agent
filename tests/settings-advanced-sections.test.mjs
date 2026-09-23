/* DG-191 (with DG-056): Settings › Advanced has the approved sample's sections, in its order, with the same
   "N more with …" lines, at every width and in both Show everything states; Under the hood is there only at
   Technical, and last; every card the page had still has a place on it; the headings are French in French. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const { BUCKETS } = await import("../public/settings-buckets.js");
const CARDS = ["health-card", "diagnostics-card", "settings", "event-loop-card", "activity-log-card",
  "developer-card", "sdk-kit-card", "coding-card", "jev-decisions-card", "counters-card", "knobs-retries-card", "knobs-tools-card"];

/* The sample's Advanced page, measured from its rendered sections: Regular, then Advanced (Show everything on). */
const REGULAR = ["Fixing problems", "3 more with Advanced", "For developers", "22 more with Advanced"];
const ADVANCED = ["Fixing problems", "1 more with Technical", "For developers", "3 more with Technical"];
const TECHNICAL = ["Fixing problems", "For developers", "Under the hood"];

test("every Advanced card keeps a section, in the sample's order", () => {
  const placed = BUCKETS.advanced.flatMap((bucket) => bucket[4].map(([ref]) => ref));
  assert.deepEqual([...placed].sort(), [...CARDS].sort());
  assert.deepEqual(BUCKETS.advanced.map((bucket) => bucket[2]), ["Fixing problems", "For developers", "Under the hood"]);
  assert.deepEqual(BUCKETS.advanced[0][4].slice(0, 4).map(([ref]) => ref), ["health-card", "diagnostics-card", "settings", "event-loop-card"]);
  assert.deepEqual(BUCKETS.advanced[1][4].slice(0, 3).map(([ref]) => ref), ["developer-card", "sdk-kit-card", "coding-card"]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-advanced-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.locator('.lx-settings-link[data-page="advanced"]').click();
  await page.locator("#coding-card").waitFor({ state: "attached" });
  return { page, errors };
}
/** The section headings and "N more" lines on show, in page order. */
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-advanced :is(.sg-head-title, .sg-more)")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
async function expect(page, level, want) {
  await page.evaluate((pick) => globalThis.branchSettingsLevel.set(pick), level);
  await page.waitForFunction((pick) => document.documentElement.dataset.settingsLevel === pick, level);
  /* Modules draw their cards when they like; wait for the outline to settle on the sample's, then say what it is. */
  await page.waitForFunction((words) => [...document.querySelectorAll("#lx-page-advanced :is(.sg-head-title, .sg-more)")]
    .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()).join("|") === words, want.join("|"), { timeout: 10000 })
    .catch(() => {});
  assert.deepEqual(await outline(page), want, `${level} at ${page.viewportSize().width}px`);
}

test("Advanced has the sample's sections and counts at 1440, 860 and 400 px, Show everything off and on", async (t) => {
  const { page, errors } = await fixture(t);
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(page, "regular", REGULAR);
    await expect(page, "advanced", ADVANCED);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.everything), "on");
    await expect(page, "technical", TECHNICAL);
  }
  /* Nothing is dropped: at Technical every card of the page shows, in its section, and nothing is left over. */
  for (const id of CARDS) assert.equal(await page.locator(`#lx-page-advanced > #${id}`).isVisible(), true, `${id} shows at Technical`);
  assert.equal(await page.locator("#lx-page-advanced .sg-other").isVisible(), false, "no card is left over under More on this page");
  const under = await page.locator("#lx-page-advanced > [data-sg-bucket]").evaluateAll((nodes, cards) => nodes
    .filter((node) => cards.includes(node.id)).map((node) => node.dataset.sgBucket), CARDS);
  assert.deepEqual(under.slice(-3), ["advanced:under", "advanced:under", "advanced:under"], "Under the hood is last");
  assert.deepEqual(errors, []);
});

test("Advanced's section headings and counts are French in French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-advanced-fix")?.textContent === "Régler les problèmes");
  const heads = await page.locator("#lx-page-advanced .sg-head-title").evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent));
  assert.deepEqual(heads, ["Régler les problèmes", "Pour les développeurs", "Sous le capot"]);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await page.waitForFunction(() => /Avancé/.test(document.querySelector("#lx-page-advanced .sg-more-line:not([hidden]) .sg-more")?.textContent ?? ""));
  assert.deepEqual(errors, []);
});

test("DG-008: on Advanced only the page title is level two; each card's title sits under its section's", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  for (const id of CARDS) await page.locator(`#${id === "settings" ? "adapt-card" : id}`).waitFor({ state: "visible" });
  const host = page.locator("#lx-page-advanced");
  assert.deepEqual(await host.locator("h2").evaluateAll((nodes) => nodes.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim())), ["Advanced"]);
  for (const id of CARDS.filter((id) => id !== "settings").concat("adapt-card"))
    assert.equal(await page.locator(`#${id} > h3.settings-card-title`).count(), 1, `${id} has one card title at level three`);
  /* Headings inside a card sit one level below its title. */
  for (const inner of ["#diagnostics-card h4", "#playground h4", "#sdk-kit-card > h4"])
    assert.equal(await page.locator(inner).count(), 1, `${inner} is level four`);
  assert.deepEqual(errors, []);
});

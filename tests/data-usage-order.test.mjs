/* DG-081: Data & usage reads as the approved sample does (design/Branch-Grown-Up.html, its Data & usage page):
   Usage, What each connection has left, What is kept, What it costs, and Under the hood at Technical. The usage
   itself leads; the connections' allowances are a card of their own; the monthly limit and the model prices sit
   under what it costs; the spreadsheet of the month under the hood. The figures and the limit work as before.
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

async function dataPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-data-usage-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor();
  /* Opened as a person opens it, not through the helper that shows every card of the page. */
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.locator('.lx-settings-link[data-page="data"]').click();
  await page.locator("#usage-left-card #usage-limits").waitFor({ state: "attached" });
  return { page, errors, call };
}

/** Each section on show, in order, with the cards on show under it. */
const sections = (page) => page.evaluate(() => {
  const out = [];
  let current = null;
  for (const child of document.getElementById("lx-page-data").children) {
    if (!child.checkVisibility()) continue;
    if (child.matches(".sg-head")) { current = { head: child.dataset.bucket, cards: [] }; out.push(current); }
    else if (current && child.id) current.cards.push(child.id);
  }
  return out;
});
const level = async (page, value) => {
  await page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value);
  await page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value);
  await page.waitForTimeout(300);
};

test("DG-081 Data & usage leads with usage, in the sample's order, at each level", async (t) => {
  const { page, errors } = await dataPage(t);
  await level(page, "regular");
  const regular = await sections(page);
  /* Under the hood holds only Technical cards, so at the default level its heading is not drawn either. */
  assert.deepEqual(regular.map((one) => one.head), ["data:usage", "data:left", "data:save", "data:kept", "data:cost"]);
  assert.deepEqual(regular.slice(0, 3).map((one) => one.cards), [["usage"], ["usage-left-card"], ["usage-save-card"]]);
  assert.deepEqual(regular[4].cards, ["usage-costs-card", "usage-report-card"], "model prices wait for Technical, as the sample's");
  await level(page, "technical");
  const technical = await sections(page);
  assert.deepEqual(technical.map((one) => one.head), ["data:usage", "data:left", "data:save", "data:kept", "data:cost", "data:under"]);
  assert.deepEqual(technical[4].cards, ["usage-costs-card", "usage-report-card", "usage-prices-card"]);
  assert.deepEqual(technical[5].cards, ["usage-sheet-card", "asks-analytics-card", "asks-forecasts-card", "asks-leads-card"], "the spreadsheet is under the hood");
  /* What moved is what the sample shows under each heading, and nothing is drawn twice. */
  const inside = await page.evaluate(() => ({
    left: !!document.querySelector("#usage-left-card #usage-limits"),
    limit: !!document.querySelector("#usage-costs-card .budget-card") && !document.querySelector("#usage-costs-card #price-model"),
    prices: !!document.querySelector("#usage-prices-card #price-model"),
    save: !!document.querySelector("#usage-save-card #glance-save-progress") && !document.querySelector("#usage-left-card #glance-save-progress"),
    ring: !!document.querySelector("#usage-left-card #glance-ring"),
    sheet: !!document.querySelector("#usage-sheet-card #usage-metering"),
    stillUsage: !!document.querySelector("#usage #usage-month") && !document.querySelector("#usage #usage-limits, #usage .budget-card, #usage #usage-metering"),
    titleOnce: [...document.querySelectorAll("#lx-page-data h2, #lx-page-data h3")].filter((h) => h.checkVisibility() && !h.matches(".sr-only") && h.textContent.trim() === "What each connection has left").length,
  }));
  assert.deepEqual(inside, { left: true, limit: true, prices: true, save: true, ring: true, sheet: true, stillUsage: true, titleOnce: 1 });
  assert.deepEqual(errors, []);
});

test("DG-081 the monthly limit still saves from its new place, and the headings are French in French", async (t) => {
  const { page, errors, call } = await dataPage(t);
  await page.locator("#usage-costs-card #max-dollars").fill("42");
  await page.locator("#usage-costs-card #save-budget").click();
  await page.waitForFunction(async () => {
    const response = await fetch("/api/usage/budget", { headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } });
    return (await response.json()).budget?.maxMonthlyDollars === 42;
  }, null, { timeout: 10000 });
  assert.equal((await call("/api/usage/budget")).budget.maxMonthlyDollars, 42);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const words = await page.evaluate(async () => { const { t } = await import("/i18n.js"); return ["usage", "left"].map((id) => t(`settingsGrown.bucket.data.${id}`)); });
  await page.waitForFunction((first) => document.querySelector('.sg-head[data-bucket="data:usage"]')?.textContent.includes(first), words[0]);
  const heads = await page.evaluate(() => ["usage", "left"].map((id) => document.querySelector(`.sg-head[data-bucket="data:${id}"] h3`)?.textContent.trim()));
  assert.deepEqual(heads, words);
  assert.notDeepEqual(words, ["Usage", "What each connection has left"]);
  assert.deepEqual(errors, []);
});

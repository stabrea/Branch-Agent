/* DG-175 (owner-reported): with Show everything on, the message box was the old tall panel: a big "+", the
   Temporary and Ask-me-questions-first tick boxes, the "Your assistant" dropdown, New conversation and a big Send.
   The approved sample (design/Branch-Grown-Up.html) keeps one slim bar whatever is shown; with everything shown at
   Advanced or Technical it adds a line of small chips under it (its `.c-foot .fchip.full-only`). Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-composer-everything-"));
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
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor();
  return { page, errors };
}
const everything = (page, on) => page.evaluate(async (value) => {
  const { applyAppearance, currentAppearance } = await import("/appearance.js");
  applyAppearance({ ...currentAppearance(), showEverything: value });
}, on).then(() => page.waitForFunction((value) => document.documentElement.dataset.everything === (value ? "on" : "off"), on));
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));

/** What the owner's screenshot showed beside the box, and the two round buttons' size. */
const inline = (page) => page.evaluate(() => {
  const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => node.checkVisibility());
  const round = (id) => { const box = document.getElementById(id).getBoundingClientRect(); return Math.round(box.width) === 34 && Math.round(box.height) === 34; };
  return {
    extras: ["#temporary-toggle", "#ask-first-toggle", "#composer-specialist", "#composer-attach", "#composer-media", "#new-session"].filter(shown),
    plusRound: round("lx-plus"), sendRound: round("send"),
    bar: Math.round(document.getElementById("chat-form").getBoundingClientRect().height),
  };
});

for (const width of [1440, 860, 400]) {
  // Redesign: replaced by the new window (Show everything: the calm and full windows are one window, and its slim bar and
  // the chips under it were the old sample's, design/Branch-Grown-Up.html; the message box is the prototype's).
  test.skip(`DG-175 at ${width} px with Show everything on the box is the sample's slim bar, nothing beside it`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await everything(page, true);
    assert.deepEqual(await inline(page), { extras: [], plusRound: true, sendRound: true, bar: 48 });
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (Show everything: the calm and full windows are one window, and its slim bar and
// the chips under it were the old sample's, design/Branch-Grown-Up.html; the message box is the prototype's).
test.skip("DG-175 the sample's chips under the box show with everything shown at Advanced, and press the real choices", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const chips = () => page.evaluate(() => [...document.querySelectorAll(".lx-foot-chip")].filter((chip) => chip.checkVisibility())
    .map((chip) => `${chip.textContent.trim()}${chip.getAttribute("aria-pressed") === "true" ? " ✓" : ""}`));
  assert.deepEqual(await chips(), [], "the calm window has no chips");
  await everything(page, true);
  await level(page, "regular");
  assert.deepEqual(await chips(), [], "nor has the full window at Regular");
  await level(page, "advanced");
  assert.deepEqual(await chips(), ["Context used 0%", "Ask me questions first", "Temporary", "Your assistant"], "the sample's four, how full the context is first (DG-101)");
  await page.locator(".lx-foot-chip", { hasText: "Temporary" }).click();
  assert.equal(await page.locator("#temporary-toggle").isChecked(), true, "the chip presses the real choice");
  assert.deepEqual(await chips(), ["Context used 0%", "Ask me questions first", "Temporary ✓", "Your assistant"]);
  /* Chosen from the + menu instead, the chip follows. */
  await page.locator("#lx-plus").click();
  await page.locator("#lx-plus-menu").getByRole("menuitem", { name: "Ask me questions first", exact: true }).dispatchEvent("click");
  await page.waitForFunction(() => document.querySelector(".lx-foot-chip[data-target]")?.getAttribute("aria-pressed") === "true");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (Show everything: the calm and full windows are one window, and its slim bar and
// the chips under it were the old sample's, design/Branch-Grown-Up.html; the message box is the prototype's).
test.skip("DG-175 in French the chips are French", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await everything(page, true);
  await level(page, "advanced");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const words = await page.evaluate(async () => { const { t } = await import("/i18n.js"); return [t("more.askFirst"), t("composer.chip.temporary")]; });
  await page.waitForFunction((first) => document.querySelector(".lx-foot-chip[data-target]")?.textContent.trim() === first, words[0]);
  const seen = await page.evaluate(() => [...document.querySelectorAll(".lx-foot-chip[data-target]")].map((chip) => chip.textContent.trim()));
  assert.deepEqual(seen, words);
  assert.notDeepEqual(words, ["Ask me questions first", "Temporary"]);
  assert.deepEqual(errors, []);
});

/** The + menu as drawn: its rows in order, a ✓ on each chosen one, and whether it fits the window. */
const plusMenu = async (page) => {
  await page.locator("#lx-plus").click();
  await page.locator("#lx-plus-menu").waitFor({ state: "visible" });
  return page.evaluate(() => {
    const menu = document.getElementById("lx-plus-menu"), box = menu.getBoundingClientRect();
    return {
      rows: [...menu.querySelectorAll(".lx-more-head, [role^=menuitem]")].map((row) =>
        `${row.textContent.trim()}${row.getAttribute("aria-checked") === "true" ? " ✓" : ""}`),
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    };
  });
};
const planSaved = (page) => page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/plan-act");

// Redesign: Coming soon (plusmenu), checked at afa6ad94; Show everything is replaced by the new window (one window).
test.skip("DG-175 with Show everything on, how it should work and when to check back are the + menu's choices, not a row above the box", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await everything(page, true);
  assert.equal(await page.locator("#plan-controls").isVisible(), false, "no row of plan controls above the box");
  /* The server's choice arrived: nothing checks back until the end unless asked. */
  await page.waitForFunction(() => document.getElementById("session-autonomy").value === "at-the-end");
  const before = await plusMenu(page);
  assert.equal(before.fits, true, "the longer menu still fits a phone");
  const plan = before.rows.slice(before.rows.indexOf("How it should work"));
  assert.deepEqual(plan.slice(0, 8), ["How it should work", "Just do it ✓", "Show me the plan first",
    "Check back with me", "Before every step", "Before steps that change something", "Not until the end ✓", "Use this for the whole project"]);
  /* A choice presses the real select, and the choice is saved for this conversation. */
  let answer = planSaved(page);
  await page.locator("#lx-plus-menu").getByRole("menuitemradio", { name: "Show me the plan first", exact: true }).click();
  const body = (await answer).request().postDataJSON();
  assert.deepEqual([body.planMode, body.scope], ["show-plan", "project"], "before the first message the choice is the project's");
  assert.equal(await page.locator("#session-plan-mode").inputValue(), "show-plan");
  assert.ok((await plusMenu(page)).rows.includes("Show me the plan first ✓"), "shown chosen when the menu opens again");
  answer = planSaved(page);
  await page.locator("#lx-plus-menu").getByRole("menuitem", { name: "Use this for the whole project", exact: true }).click();
  assert.equal((await answer).request().postDataJSON().scope, "project");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (plusmenu), checked at afa6ad94; Show everything is replaced by the new window (one window).
test.skip("DG-175 the calm window's + menu stays the sample's short one", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const { rows } = await plusMenu(page);
  assert.equal(rows.includes("How it should work"), false, JSON.stringify(rows));
  assert.deepEqual(errors, []);
});

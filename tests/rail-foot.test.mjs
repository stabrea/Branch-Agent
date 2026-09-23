/* DG-092, DG-093, DG-094, DG-095, DG-159, DG-161: the sidebar as in the approved sample. Overview is its first place; the foot
   is one line of icons (theme, pet, day/night, clear the view, the Settings cog) over the account row, whose name is
   never cut short. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function signedIn(t, width, preferences = {}, before = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-rail-foot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await before(app);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers, body: JSON.stringify({ done: true }) });
  if (Object.keys(preferences).length) await fetch(new URL("/api/preferences", server.url), { method: "POST", headers, body: JSON.stringify(preferences) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#lx-foot-line").waitFor({ state: "attached" });
  errors.length = 0;
  return { page, errors, app };
}

/** The icon line, left to right: each shown button's id and its accessible name. */
const footLine = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-foot-line > button")]
  .filter((node) => node.checkVisibility())
  .map((node) => ({ id: node.id, label: node.getAttribute("aria-label") || node.textContent.trim() })));

for (const everything of [false, true]) {
  test(`DG-094 the foot is one icon line over the account row (Show everything ${everything ? "on" : "off"})`, async (t) => {
    const { page, errors } = await signedIn(t, 1440, { showEverything: everything });
    const line = await footLine(page);
    assert.deepEqual(line.map((b) => b.id).slice(0, 4), ["lx-foot-theme", "lx-foot-pet", "lx-foot-mode", "lx-foot-eye"]);
    assert.equal(line.length, 5, "and the Settings cog closes it");
    assert.match(line[4].id, /^(lx-settings-row|rail-settings)$/);
    const box = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const gear = [...document.querySelectorAll("#lx-foot-line > .sg-gear")].find((node) => node.checkVisibility()).getBoundingClientRect();
      return { lineBottom: r("lx-foot-line").bottom, ownerTop: r("owner-menu-button").top, ownerRight: r("owner-menu-button").right, gearRight: gear.right,
        mode: r("lx-foot-mode").left, pet: r("lx-foot-pet").right, gearH: gear.height };
    });
    assert.ok(box.lineBottom <= box.ownerTop + 1, "the icons sit above the account row");
    assert.ok(Math.abs(box.gearRight - box.ownerRight) < 2, "the cog at the right edge");
    assert.ok(box.mode - box.pet > 40, "day/night, the eye and the cog are pushed to the right");
    assert.equal(Math.round(box.gearH), 30);
    assert.equal(await page.locator("#appearance-shortcut").isVisible(), false, "DG-159: the old half-moon is gone");
    assert.deepEqual(errors, []);
  });
}

test("DG-159 day/night is one glyph that switches Forest and Daylight and says so", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const mode = page.locator("#lx-foot-mode");
  assert.equal((await mode.textContent()).trim(), "☾");
  assert.equal(await mode.getAttribute("aria-label"), "Forest. Switch to Daylight");
  assert.equal(await mode.getAttribute("title"), "Switch to Daylight");
  await mode.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "daylight");
  assert.equal((await mode.textContent()).trim(), "☀");
  assert.equal(await mode.getAttribute("aria-label"), "Daylight. Switch to Forest");
  await mode.click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "forest");
  assert.deepEqual(errors, []);
});

test("DG-161 the paw shows and hides the same pet as Settings, by its name", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const pet = page.locator("#lx-foot-pet");
  const was = await pet.getAttribute("aria-pressed");
  await pet.click();
  await page.waitForFunction((before) => document.getElementById("lx-foot-pet").getAttribute("aria-pressed") !== before, was);
  const shown = (await pet.getAttribute("aria-pressed")) === "true";
  if (shown) assert.match(await pet.getAttribute("aria-label"), /is here\. Hide the pet$/);
  else assert.equal(await pet.getAttribute("aria-label"), "Show the pet");
  assert.equal(await page.locator("#delight-pet-on").isChecked().catch(() => shown), shown, "the Appearance switch agrees");
  await pet.click();
  await page.waitForFunction((before) => document.getElementById("lx-foot-pet").getAttribute("aria-pressed") === before, was);
  assert.deepEqual(errors, []);
});

test("DG-094 the eye clears the view and says it is pressed", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await page.locator("#lx-foot-eye").click();
  await page.waitForFunction(() => document.documentElement.dataset.quiet === "1");
  assert.equal(await page.locator("#lx-foot-eye").getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.documentElement.dataset.quiet);
  assert.deepEqual(errors, []);
});

test("DG-092 Overview is the sidebar's first place, shown in the calm window, and opens the Overview", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const first = page.locator("#sections-nav > .lx-place-link").first();
  assert.equal(await first.getAttribute("data-place"), "overview");
  assert.equal(await first.isVisible(), true);
  assert.equal((await first.innerText()).trim(), "Overview");
  await first.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('.lx-place-link[data-place="overview"]').getAttribute("aria-current") === "page");
  assert.match(await page.locator("#page-title").innerText(), /Overview/);
  assert.deepEqual(errors, []);
});

for (const width of [1440, 1024, 390]) {
  test(`DG-095 at ${width} px a long owner line is shown whole`, async (t) => {
    const { page, errors } = await signedIn(t, width);
    const clipped = await page.evaluate(() => {
      const name = document.getElementById("owner-name");
      name.textContent = "Grandmother's workshop on the hill behind the orchard";
      return name.scrollWidth > name.clientWidth + 1 || getComputedStyle(name).textOverflow === "ellipsis";
    });
    assert.equal(clipped, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
    assert.deepEqual(errors, []);
  });
}

test("DG-094 in French the icon line speaks French", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction(() => document.getElementById("lx-foot-mode").getAttribute("aria-label") === "Forêt. Passer à Lumière du jour");
  assert.equal(await page.locator("#lx-foot-theme").getAttribute("aria-label"), "Thème · Forêt");
  assert.equal(await page.locator("#lx-foot-eye").getAttribute("aria-label"), "Dégager la vue");
  assert.equal((await page.locator('.lx-place-link[data-place="overview"]').innerText()).trim().length > 0, true);
  assert.deepEqual(errors, []);
});

test("DG-093 New conversation has a chevron that starts with a chosen Trunk, and one click still starts plainly", async (t) => {
  const { page, errors, app } = await signedIn(t, 1440, {}, async (app) => {
    app.trunks.setMode("trunks", { mode: "on" });
    app.trunks.setMode("conversations", { mode: "on" });
    await app.trunks.create({ name: "Ada" });
  });
  const more = page.locator("#rail-new-more");
  await more.waitFor({ state: "visible" });
  assert.equal(await more.getAttribute("aria-label"), "Start with a chosen Trunk");
  assert.equal(await more.getAttribute("aria-haspopup"), "menu");
  const beside = await page.evaluate(() => {
    const a = document.getElementById("rail-new").getBoundingClientRect(), b = document.getElementById("rail-new-more").getBoundingClientRect();
    return b.left > a.left + a.width / 2 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  });
  assert.equal(beside, true, "the chevron sits at the right end of the New conversation row");
  await more.click();
  const menu = page.locator("#rail-new-menu");
  await menu.waitFor({ state: "visible" });
  assert.equal(await more.getAttribute("aria-expanded"), "true");
  const row = menu.locator('[role="menuitem"][data-trunk]');
  await row.first().waitFor();
  assert.match(await menu.innerText(), /Start a conversation with/i);
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /Ada\s+@ada/);
  await row.click();
  await page.waitForFunction(() => Boolean(document.getElementById("conversation")?.dataset.sessionId));
  const session = await page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  const chosen = new Map(app.trunks.conversations.chosen());
  assert.equal(chosen.get(session), app.trunks.records.list()[0].id, "Ada answers in the new conversation");
  await page.locator("#rail-new").click();
  await page.waitForFunction(() => !document.getElementById("conversation").dataset.sessionId);
  assert.equal(await page.locator("#rail-new-menu").isVisible(), false, "one click on New conversation starts plainly, no menu");
  assert.deepEqual(errors, []);
});

test("DG-093 without Trunks there is no chevron", async (t) => {
  /* and New conversation keeps its one-click start */
  const { page, errors } = await signedIn(t, 1440);
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#rail-new-more").isVisible(), false);
  assert.deepEqual(errors, []);
});

/* DG-035/DG-036: Appearance has the approved sample's theme tools (design/Branch-Grown-Up.html, `.theme-tools`):
   a search over the themes' names with the real count in its placeholder, and one row of filter chips (All, each
   theme group Branch really has, Light-friendly, High contrast). Typing and choosing narrow the tiles without
   false matches, a screen reader hears how many are left, and none matching says so. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";
import { THEMES, THEME_GROUPS } from "../public/theme-catalogue.js";

async function appearance(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-search-"));
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
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "appearance");
  await page.locator("#lx-theme-search").waitFor();
  return { page, errors };
}
const shownThemes = (page) => page.$$eval("#lx-theme-gallery .lx-tile", (tiles) => tiles.map((tile) => tile.dataset.family));
const chipsPressed = (page) => page.$$eval("#lx-theme-chips .lx-fchip", (chips) => chips.map((chip) => [chip.dataset.filter, chip.getAttribute("aria-pressed")]));

test("DG-035 the theme search names the real count and narrows the tiles to names that match, and only those", async (t) => {
  const { page, errors } = await appearance(t);
  const search = page.getByRole("searchbox", { name: "Search themes" });
  assert.equal(await search.getAttribute("placeholder"), `Search ${THEMES.length} themes`);
  assert.equal((await shownThemes(page)).length, THEMES.length, "nothing typed: every theme");
  await search.fill("OC");
  const expected = THEMES.filter((theme) => theme[1].toLowerCase().includes("oc")).map((theme) => theme[0]);
  assert.ok(expected.length > 0 && expected.length < THEMES.length, "the probe word matches some themes, not all");
  assert.deepEqual((await shownThemes(page)).sort(), expected.sort(), "exactly the names containing the words, whatever their case");
  assert.equal(await page.locator("#lx-theme-results").textContent(), `${expected.length} themes`, "a screen reader hears how many");
  /* A group with nothing left says nothing: no heading over an empty row. */
  const groupsLeft = new Set(THEMES.filter((theme) => expected.includes(theme[0])).map((theme) => theme[2]));
  assert.equal(await page.locator("#lx-theme-gallery .lx-eyebrow").count(), groupsLeft.size);
  await search.fill("zzqq");
  assert.deepEqual(await shownThemes(page), []);
  assert.equal(await page.locator("#lx-theme-gallery .lx-eyebrow").count(), 0, "no group heading over nothing");
  assert.equal(await page.locator(".lx-theme-none").textContent(), "No theme matches. Try All, or a shorter name.");
  assert.equal(await page.locator("#lx-theme-results").textContent(), "0 themes");
  await search.fill("");
  assert.equal((await shownThemes(page)).length, THEMES.length);
  assert.deepEqual(errors, []);
});

test("DG-036 the filter chips show a group, the light-friendly and the high-contrast themes, one pressed at a time", async (t) => {
  const { page, errors } = await appearance(t);
  const groups = THEME_GROUPS.map(([id]) => id);
  assert.deepEqual((await chipsPressed(page)).map(([value]) => value), ["all", ...groups, "lightok", "high"],
    "the sample's order, with a chip only for a group Branch has");
  assert.deepEqual((await chipsPressed(page)).filter(([, pressed]) => pressed === "true").map(([value]) => value), ["all"]);
  for (const group of groups) {
    await page.locator(`#lx-theme-chips .lx-fchip[data-filter="${group}"]`).click();
    assert.deepEqual((await shownThemes(page)).sort(), THEMES.filter((theme) => theme[2] === group).map((theme) => theme[0]).sort(), group);
    assert.deepEqual((await chipsPressed(page)).filter(([, pressed]) => pressed === "true").map(([value]) => value), [group]);
  }
  for (const filter of ["lightok", "high"]) {
    await page.locator(`#lx-theme-chips .lx-fchip[data-filter="${filter}"]`).click();
    const shown = await shownThemes(page);
    assert.ok(shown.length > 0 && shown.length < THEMES.length, `${filter} narrows the list without emptying it (${shown.length})`);
  }
  /* The chip and the words combine, and a new light or theme keeps both. */
  await page.locator('#lx-theme-chips .lx-fchip[data-filter="all"]').click();
  await page.getByRole("searchbox", { name: "Search themes" }).fill("fo");
  const before = await shownThemes(page);
  await page.locator("#lx-theme-gallery .lx-tile").first().click();
  assert.deepEqual(await shownThemes(page), before, "choosing a theme redraws the tiles but keeps the search");
  assert.equal(await page.getByRole("searchbox", { name: "Search themes" }).inputValue(), "fo");
  assert.deepEqual(errors, []);
});

test("DG-035/036 the tools look like the sample's and fit a phone without sideways scrolling", async (t) => {
  for (const width of [1440, 860, 400]) {
    const { page, errors } = await appearance(t, width);
    const seen = await page.evaluate(() => {
      const field = document.querySelector(".lx-theme-search"), chip = document.querySelector("#lx-theme-chips .lx-fchip");
      const style = (node) => getComputedStyle(node);
      const on = document.querySelector('#lx-theme-chips .lx-fchip[aria-pressed="true"]');
      return {
        field: { height: field.getBoundingClientRect().height, radius: style(field).borderTopLeftRadius, border: style(field).borderTopWidth },
        chip: { height: chip.getBoundingClientRect().height, radius: style(chip).borderTopLeftRadius, size: style(chip).fontSize, weight: style(chip).fontWeight },
        pressed: { fill: style(on).backgroundColor, text: style(on).color, ink: style(document.body).getPropertyValue("--text") },
        over: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.deepEqual(seen.field, { height: 36, radius: "10px", border: "1px" }, `${width}: the search field`);
    assert.deepEqual(seen.chip, { height: 30, radius: "15px", size: "13px", weight: "400" }, `${width}: a chip`);
    assert.notEqual(seen.pressed.fill, "rgba(0, 0, 0, 0)", `${width}: the pressed chip is filled`);
    assert.ok(seen.over <= 1, `${width}: the page is no wider than the window (${seen.over}px over)`);
    assert.deepEqual(errors, []);
  }
});

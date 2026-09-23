/* DG-037: the Appearance theme tiles are the approved sample's (design/Branch-Grown-Up.html, its live `tilesHTML`):
   a 70px window in miniature per theme, with its rail, a surface holding a strong and a quiet line of text, and its
   accent, then the name and the sample's words (Default on Slate, High contrast at 14:1 in the light shown). Columns
   are at least 180px wide, 140px under 760px, and nothing scrolls sideways. Headless only. */
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
import { THEMES, TOKEN_NAMES } from "../public/theme-catalogue.js";

function contrast(theme, mode) {
  const token = (name) => theme[3][mode][TOKEN_NAMES.indexOf(name)];
  const light = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const [a, b] = [light(token("--text")), light(token("--ground"))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function appearance(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-tiles-"));
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
  await page.locator("#lx-theme-gallery .lx-tile").first().waitFor();
  return { page, errors };
}

const measure = (page) => page.evaluate(() => {
  const tile = document.querySelector("#lx-theme-gallery .lx-tile"), grid = tile.parentElement;
  const box = (node) => node.getBoundingClientRect(), style = (node) => getComputedStyle(node);
  const mini = tile.querySelector(".lx-mini"), rail = mini.querySelector("u"), pane = mini.querySelector("i");
  const lines = [...pane.querySelectorAll("em")], accent = pane.querySelector("s"), name = tile.querySelector(".lx-tile-name");
  return {
    tile: { padding: style(tile).paddingTop, radius: style(tile).borderTopLeftRadius, border: style(tile).borderTopWidth },
    mini: { height: box(mini).height, radius: style(mini).borderTopLeftRadius },
    rail: { width: box(rail).width, height: box(rail).height },
    pane: { left: box(pane).left - box(mini).left, top: box(pane).top - box(mini).top, right: box(mini).right - box(pane).right, radius: style(pane).borderTopLeftRadius },
    lines: lines.map((line) => Math.round(box(line).width / box(pane).width * 100) / 100 > 0 && style(line).height),
    accent: { width: box(accent).width, height: box(accent).height },
    name: { size: style(name).fontSize, weight: style(name).fontWeight },
    column: box(tile).width,
    columns: style(grid).gridTemplateColumns.split(" ").length,
    track: box(grid).width,
    over: document.documentElement.scrollWidth - innerWidth,
  };
});

test("DG-037 each tile is the sample's miniature window with its name, at three widths", async (t) => {
  for (const width of [1440, 860, 400]) {
    const { page, errors } = await appearance(t, width);
    const seen = await measure(page);
    assert.deepEqual(seen.tile, { padding: "7px", radius: "14px", border: "1px" }, `${width}: the tile`);
    assert.deepEqual(seen.mini, { height: 70, radius: "9px" }, `${width}: the miniature`);
    assert.deepEqual(seen.rail, { width: 16, height: 70 }, `${width}: the rail`);
    assert.deepEqual(seen.pane, { left: 24, top: 9, right: 9, radius: "7px" }, `${width}: the surface`);
    assert.deepEqual(seen.lines, ["4px", "4px"], `${width}: a strong and a quiet line`);
    assert.deepEqual(seen.accent, { width: 22, height: 11 }, `${width}: the accent`);
    assert.deepEqual(seen.name, { size: "13.5px", weight: "560" }, `${width}: the name`);
    /* The sample's columns: at least 180px wide, 140px under 760px (the gallery sits inside Settings' page). */
    const least = width <= 760 ? 140 : 180;
    assert.ok(seen.column >= least - 0.5, `${width}: a tile is ${seen.column}px wide`);
    assert.equal(seen.columns, Math.max(1, Math.floor((seen.track + 10) / (least + 10))), `${width}: as many ${least}px columns as fit`);
    assert.ok(seen.over <= 1, `${width}: the page is no wider than the window (${seen.over}px over)`);
    assert.deepEqual(errors, []);
  }
});

test("DG-037 the tiles carry the sample's words, and only where they are true", async (t) => {
  const { page, errors } = await appearance(t, 1440);
  const words = await page.$$eval("#lx-theme-gallery .lx-tile", (tiles) => Object.fromEntries(tiles.map((tile) =>
    [tile.dataset.family, [...tile.querySelectorAll(".lx-tile-badge")].map((badge) => badge.textContent)])));
  const mode = await page.evaluate(() => (document.documentElement.dataset.theme === "daylight" ? "light" : "dark"));
  for (const theme of THEMES) {
    const expected = [];
    if (theme[0] === "slate") expected.push("Default");
    if (contrast(theme, mode) >= 14) expected.push("High contrast");
    else if (mode === "light" && contrast(theme, "light") >= 14) expected.push("Easy in daylight");
    assert.deepEqual(words[theme[0]], expected, theme[1]);
  }
  assert.ok(Object.values(words).some((list) => list.includes("High contrast")), "some theme earns High contrast");
  /* The chosen tile is marked the sample's way: a copper edge and a soft copper ring. */
  const chosen = await page.evaluate(() => {
    const tile = document.querySelector('#lx-theme-gallery .lx-tile[aria-pressed="true"]');
    return { edge: getComputedStyle(tile).borderTopColor, ring: getComputedStyle(tile).boxShadow, copper: getComputedStyle(document.documentElement).getPropertyValue("--copper").trim() };
  });
  assert.match(chosen.ring, /0px 0px 0px 3px/, "a 3px ring");
  assert.notEqual(chosen.edge, "rgba(0, 0, 0, 0)");
  /* The miniature's colours are the sample's `fullTokens` blends of the theme's own ground and text. */
  const blend = (from, to, amount) => {
    const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    const [a, b] = [rgb(from), rgb(to)];
    return `rgb(${a.map((value, index) => Math.round(value + (b[index] - value) * amount)).join(", ")})`;
  };
  for (const theme of THEMES.filter((item) => ["slate", "forest", "mono"].includes(item[0]))) {
    const token = (name) => theme[3][mode][TOKEN_NAMES.indexOf(name)];
    const dark = mode === "dark", ground = token("--ground"), text = token("--text");
    const painted = await page.evaluate((id) => {
      const mini = document.querySelector(`#lx-theme-gallery .lx-tile[data-family="${id}"] .lx-mini`);
      return { rail: getComputedStyle(mini.querySelector("u")).backgroundColor, pane: getComputedStyle(mini.querySelector("i")).backgroundColor };
    }, theme[0]);
    assert.deepEqual(painted, {
      rail: dark ? blend(ground, "#000000", 0.4) : blend(text, ground, 0.08),
      pane: dark ? blend(ground, text, 0.045) : blend(ground, "#ffffff", 0.62),
    }, `${theme[1]}: the rail and surface`);
  }
  /* A tile is named by its theme alone and described by its words, so "Slate" finds Slate. */
  const slate = page.getByRole("button", { name: "Slate", exact: true });
  assert.equal(await slate.count(), 1);
  assert.equal(await slate.evaluate((tile) => tile.getAttribute("aria-describedby").split(" ").map((id) => document.getElementById(id).textContent).join(" ")), "Default");
  /* The tooltip gives the numbers the words stand for. */
  assert.match(await page.locator('#lx-theme-gallery .lx-tile[data-family="slate"]').getAttribute("title"), /^Slate · text contrast \d+\.\d to 1 \((Moonlight|Daylight)\), \d+\.\d to 1 in Daylight$/);
  assert.deepEqual(errors, []);
});

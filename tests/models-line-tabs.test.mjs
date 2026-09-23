/* DG-041: the Models page's tabs are the approved sample's line tabs (design/Branch-Grown-Up.html, `.tabs`/`.tab`),
   not pills: one row on a hairline that scrolls sideways instead of wrapping, the chosen tab underlined in copper, a
   focus ring that stays inside the row, and the same tab semantics as before. Headless only. */
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

async function modelsPage(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-tabs-"));
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
  await openSettings(page, "models");
  await page.locator("#lx-page-models .lx-subtab").first().waitFor();
  return { page, errors };
}

const look = (page) => page.evaluate(() => {
  const row = document.querySelector("#lx-page-models .lx-subtabs"), tabs = [...row.querySelectorAll(".lx-subtab")];
  const copper = getComputedStyle(document.body).getPropertyValue("--copper").trim();
  const probe = document.createElement("i");
  probe.style.color = copper;
  document.body.append(probe);
  const copperRgb = getComputedStyle(probe).color;
  probe.remove();
  return {
    row: { line: getComputedStyle(row).boxShadow, overflow: getComputedStyle(row).overflowX, wrap: getComputedStyle(row).flexWrap,
      /* Nothing hangs below the row, so it never scrolls up and down and never clips the underline. */
      tall: row.scrollHeight - row.clientHeight,
      under: tabs.map((tab) => tab.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom).filter((over) => over > 0.5) },
    pills: tabs.filter((tab) => getComputedStyle(tab).borderTopLeftRadius !== "0px" || getComputedStyle(tab).backgroundColor !== "rgba(0, 0, 0, 0)")
      .map((tab) => tab.textContent.trim()),
    chosen: tabs.filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => ({
      name: tab.textContent.trim(), underline: getComputedStyle(tab).borderBottomWidth, colour: getComputedStyle(tab).borderBottomColor,
    })),
    copperRgb,
    others: tabs.filter((tab) => tab.getAttribute("aria-selected") !== "true").map((tab) => getComputedStyle(tab).borderBottomColor),
    rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
  };
});

test("DG-041 the Models tabs are line tabs: one row on a hairline, the chosen one underlined in copper", async (t) => {
  const { page, errors } = await modelsPage(t);
  const seen = await look(page);
  assert.match(seen.row.line, / 0px -1px 0px 0px inset$/, "the row sits on a hairline");
  assert.equal(seen.row.tall, 0, "the row does not scroll up and down");
  assert.deepEqual(seen.row.under, [], "no tab, and so no underline, hangs below the row to be clipped");
  assert.deepEqual(seen.pills, [], "no tab is a filled or rounded pill");
  assert.equal(seen.chosen.length, 1);
  assert.equal(seen.chosen[0].underline, "2px", "the chosen tab is underlined");
  assert.equal(seen.chosen[0].colour, seen.copperRgb, "in copper");
  assert.ok(seen.others.every((colour) => colour === "rgba(0, 0, 0, 0)"), "and only the chosen one");
  assert.equal(seen.rows, 1, "one row");
  /* The semantics are what they were: a tab list whose chosen tab shows its own panel. */
  assert.equal(await page.locator("#lx-page-models .lx-subtabs").getAttribute("role"), "tablist");
  await page.locator('#lx-page-models .lx-subtab[data-sub="defaults"]').click();
  assert.equal(await page.locator('#lx-page-models .lx-subtab[data-sub="defaults"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#lx-models-defaults").isVisible(), true);
  assert.equal(await page.locator("#lx-models-connection").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("DG-041 a tab reached by keyboard shows its focus ring inside the row, and Enter chooses it", async (t) => {
  const { page, errors } = await modelsPage(t);
  const second = page.locator('#lx-page-models .lx-subtab[data-sub="second"]');
  await second.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // arrived by keyboard, so the browser shows the focus ring
  const ring = await second.evaluate((tab) => ({ focused: document.activeElement === tab, visible: tab.matches(":focus-visible"),
    style: getComputedStyle(tab).outlineStyle, offset: getComputedStyle(tab).outlineOffset }));
  assert.equal(ring.focused && ring.visible, true, "the tab has keyboard focus");
  assert.notEqual(ring.style, "none", "a focus ring is drawn");
  assert.ok(parseFloat(ring.offset) < 0, `inside the tab, so the scrolling row cannot cut it off (${ring.offset})`);
  await page.keyboard.press("Enter");
  assert.equal(await second.getAttribute("aria-selected"), "true", "Enter chooses it");
  assert.deepEqual(errors, []);
});

test("DG-041 at 400 px the tabs stay one row that scrolls sideways, and the page itself never does", async (t) => {
  const { page, errors } = await modelsPage(t, 400);
  const seen = await look(page);
  assert.equal(seen.rows, 1, "one row, not wrapped into two");
  assert.equal(seen.row.overflow, "auto", "the row scrolls to its last tab");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(wide <= 1, `the page is no wider than the window (${wide}px over)`);
  /* Its last tab can be reached and chosen. */
  const last = page.locator("#lx-page-models .lx-subtab").last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  assert.equal(await last.getAttribute("aria-selected"), "true");
  assert.deepEqual(errors, []);
});

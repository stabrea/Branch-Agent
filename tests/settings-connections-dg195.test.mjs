/**
 * DG-195: Settings › Connections holds its own cards in the approved sample's sections, in order: Other AI tools,
 * then Your own accounts, each with its "N more with Advanced" line, and Under the hood only at Technical, last.
 * Customize › Connections points there. Checked at 1440, 860 and 400, at every level, dark and light, and in French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const SECTIONS = ["Other AI tools", "Your own accounts"];
const FRENCH = ["Autres outils d'IA", "Vos propres comptes"];
/* The sample counts 21 and 17: it also draws the 18 rows Branch shows only once their switch is on (a client id,
   a saved secret, a step's key), which no level brings into sight here. */
const MORE = [["connections:tools", "12 more with Advanced"], ["connections:accounts", "8 more with Advanced"]];

async function connectionsPage(t, width, scheme = "dark") {
  const root = await mkdtemp(join(tmpdir(), "branch-connections-dg195-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, errors };
}
/** Opens Connections the way a person does (the cog, then the page), so no card is peeked into sight. */
async function openConnections(page) {
  if (!(await page.locator("#settings-window").isVisible())) {
    const cog = page.locator(".sg-foot-line > .sg-gear:visible");
    if (!(await cog.count())) await page.locator("#rail-toggle").click();
    await cog.click();
  }
  await page.locator('.lx-settings-link[data-page="connections"]').click();
  await page.locator("#lx-page-connections").waitFor({ state: "visible" });
  await page.waitForFunction(() => ["mcp-card", "asks-connections-card", "interop-card", "personal-accounts-card", "personal-x-card",
    "personal-home-card", "comfort-mcp-card"].every((id) => document.querySelector(`#lx-page-connections > #${id}[data-sg-bucket]`)));
}
async function level(page, name) {
  await page.evaluate((to) => globalThis.branchSettingsLevel.set(to), name);
  await page.waitForFunction((to) => document.documentElement.dataset.settingsLevel === to, name);
  await page.waitForTimeout(300);
}
/** What a person sees: the section headings, every heading on show, each "N more" line, and sideways scrolling. */
const seen = (page) => page.evaluate(() => {
  const host = document.getElementById("lx-page-connections");
  const shown = (node) => node.getClientRects().length > 0;
  const text = (node) => node.textContent.trim().replace(/\s+/g, " ");
  return {
    sections: [...host.querySelectorAll(".sg-head-title")].filter(shown).map(text),
    headings: [...host.querySelectorAll("h2, h3, h4, h5, h6")].filter(shown).map((node) => [Number(node.tagName[1]), text(node)]),
    more: [...host.querySelectorAll(".sg-more-line:not([hidden])")].filter(shown).map((line) => [line.dataset.bucket, text(line)]),
    directory: host.querySelectorAll(".settings-directory-card").length,
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
});
/** Headings never skip a level going down, and no heading is drawn twice. */
function wellNested(headings) {
  for (let i = 1; i < headings.length; i++) assert.ok(headings[i][0] <= headings[i - 1][0] + 1, `${headings[i][1]} skips a level`);
  const words = headings.map(([, words]) => words);
  assert.equal(new Set(words).size, words.length, `a heading is drawn twice: ${words.join(" · ")}`);
}

for (const [width, scheme] of [[1440, "dark"], [860, "light"], [400, "dark"]]) {
  test(`DG-195 at ${width} (${scheme}): Connections has the sample's sections at every level`, async (t) => {
    const { page, errors } = await connectionsPage(t, width, scheme);
    await openConnections(page);

    await level(page, "regular");
    const regular = await seen(page);
    assert.deepEqual(regular.sections, SECTIONS, "the sample's sections, in its order");
    assert.deepEqual(regular.more, MORE);
    assert.equal(regular.directory, 0, "the cards are here, not a way to somewhere else");
    wellNested(regular.headings);
    assert.equal(regular.wide, false, "no sideways scrolling");
    for (const id of ["mcp-enabled", "asks-switch-app-blocks", "personal-switch-google", "personal-switch-microsoft"])
      assert.ok(await page.locator(`#${id}`).isVisible(), `${id} is a Regular row, as in the sample`);
    for (const id of ["mcp-keep-warm", "interop-switch-modes", "personal-switch-spotify", "comfort-startupTimeoutSeconds"])
      assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} waits for a higher level`);

    await level(page, "advanced");
    const advanced = await seen(page);
    assert.deepEqual(advanced.sections, SECTIONS, "Under the hood is not drawn at Advanced");
    assert.deepEqual(advanced.more, []);
    wellNested(advanced.headings);
    assert.ok(await page.locator("#interop-switch-modes").isVisible());

    await level(page, "technical");
    const technical = await seen(page);
    assert.deepEqual(technical.sections, [...SECTIONS, "Under the hood"], "Under the hood comes last, at Technical");
    wellNested(technical.headings);
    assert.equal(technical.wide, false);
    assert.deepEqual(errors, []);
  });
}

test("DG-195: in French the sections keep their order and words, and Customize › Connections points to Settings", async (t) => {
  const { page, errors } = await connectionsPage(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await openConnections(page);
  await level(page, "regular");
  const french = await seen(page);
  assert.deepEqual(french.sections, FRENCH);
  assert.deepEqual(french.more.map(([bucket]) => bucket), MORE.map(([bucket]) => bucket));

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await openPlace(page, "customize:connections");
  const pointer = page.locator("#lx-slot-customize-connections #customize-connections-pointer");
  assert.equal(await pointer.locator("h2").textContent(), "Connection settings");
  assert.equal(await page.locator("#lx-slot-customize-connections :is(#mcp-card, #interop-card, #personal-accounts-card)").count(), 0);
  await pointer.getByRole("button", { name: "Open Settings › Connections" }).click();
  await page.locator("#lx-page-connections").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

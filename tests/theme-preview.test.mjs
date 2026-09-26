/* DG-039: the Appearance preview is the approved sample's (design/Branch-Grown-Up.html, its live `mirrorsHTML` inside
   `lookHTML`): two live mirrors of this window, Moonlight then Daylight, each with a small chip. On a page 980px or
   wider they stack beside the choices; narrower, a strip names the theme and opens them side by side; at 540px or less
   one shows at a time with a button that flips to the other. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only

async function appearance(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-preview-"));
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
  await call("/api/onboarding", { done: true });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "appearance");
  await page.mouse.move(0, 0); // nothing pointed at, so the preview shows the chosen theme
  await page.locator("#sg-mirrors").waitFor();
  return { page, errors };
}
const shown = (page) => page.$$eval(".sg-mirror", (figures) => figures.filter((figure) => figure.getBoundingClientRect().height > 0)
  .map((figure) => ({ mode: figure.dataset.mode, chip: figure.querySelector("figcaption").textContent, box: figure.getBoundingClientRect().toJSON() })));
const drawn = (page) => page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror")]
  .filter((figure) => figure.getBoundingClientRect().height > 0)
  .every((figure) => figure.querySelector("iframe").contentDocument?.body?.children.length > 0));

/* Redesign: prototype.html's Appearance previews are its "Light or dark" mirrors (settings/pages/appearance.js mirror()):
   a light and a dark picture of this window beside "Match this computer", each drawn from the open conversation's own
   words (its title and last line), never made-up ones. They are pictures, not live copies in frames; the old strip, the
   side-by-side and the one-at-a-time flip are not in the design. */
test("DG-039 the Light and Dark mirrors show this window's own conversation, at every width", async (t) => {
  for (const width of [1440, 1100, 400]) {
    const root = await mkdtemp(join(tmpdir(), "branch-theme-preview-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const run = app.store.createRun(app.runtime.owner, "Plan the allotment");
    app.store.message(run.sessionId, { role: "user", content: run.prompt });
    app.store.message(run.sessionId, { role: "assistant", content: "Beans by the fence, squash in the sun." });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
    const browser = await chromium.launch({ headless: true });
    t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
    await fetch(new URL("/api/onboarding", server.url), {
      method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
    });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
  await call("/api/onboarding", { done: true });
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="appearance"]').click();
    const mirrors = page.locator('.set-col .mirrors [data-act="themeset"]');
    await mirrors.first().waitFor();
    for (const mode of ["light", "dark"]) {
      const text = await page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${mode}"]`).innerText();
      assert.match(text, /Plan the allotment/, `${width} ${mode}: the open conversation's title`);
      assert.match(text, /Beans by the fence, squash in the sun\./, `${width} ${mode}: and its last line`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), `${width}: nothing scrolls sideways`);
    assert.deepEqual(errors, []);
  }
});

// Redesign: replaced by the new window (prototype.html's mirrors are pictures beside "Match this computer", not framed live
// copies with chips, a strip or a flip; checked live above).
test.skip("DG-039 wide: Moonlight above Daylight beside the choices, each a live copy with the sample's chip", async (t) => {
  const { page, errors } = await appearance(t, 1440);
  await drawn(page);
  const mirrors = await shown(page);
  assert.deepEqual(mirrors.map(({ mode, chip }) => [mode, chip]), [["dark", "Moonlight"], ["light", "Daylight"]]);
  assert.ok(mirrors[1].box.top >= mirrors[0].box.bottom - 1 && Math.abs(mirrors[0].box.left - mirrors[1].box.left) < 1, "stacked");
  assert.equal(await page.locator(".sg-strip").isVisible(), false, "no strip when wide");
  const look = await page.evaluate(() => {
    const figure = document.querySelector(".sg-mirror"), chip = figure.querySelector("figcaption"), style = (node) => getComputedStyle(node);
    return {
      mirror: { radius: style(figure).borderTopLeftRadius, border: style(figure).borderTopWidth },
      chip: { right: figure.getBoundingClientRect().right - chip.getBoundingClientRect().right, bottom: figure.getBoundingClientRect().bottom - chip.getBoundingClientRect().bottom,
        size: style(chip).fontSize, weight: style(chip).fontWeight, padding: style(chip).padding, fill: style(chip).backgroundColor, ink: style(chip).color },
      column: document.getElementById("sg-mirrors").getBoundingClientRect().width / document.querySelector(".sg-look").getBoundingClientRect().width,
      palette: figure.querySelector("iframe").contentDocument.documentElement.dataset.palette,
    };
  });
  assert.deepEqual(look.mirror, { radius: "12px", border: "1px" });
  assert.deepEqual({ ...look.chip, right: Math.round(look.chip.right), bottom: Math.round(look.chip.bottom) },
    { right: 9, bottom: 9, size: "11px", weight: "500", padding: "4px 8px", fill: "rgba(0, 0, 0, 0.55)", ink: "rgb(255, 255, 255)" },
    "the chip sits 8px in from the corner, inside the 1px edge");
  assert.ok(look.column >= 0.4 && look.column <= 0.46, `the preview column is the sample's 44% (${look.column.toFixed(3)})`);
  assert.equal(look.palette, "slate", "the mirror wears the chosen theme");
  /* Pointing at a tile dresses both mirrors in it without choosing it. */
  await page.locator('#lx-theme-gallery .lx-tile[data-family="cherry"]').hover();
  await page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror iframe")].every((frame) => frame.contentDocument.documentElement.dataset.palette === "cherry"));
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "slate");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (prototype.html's mirrors are pictures beside "Match this computer", not framed live
// copies with chips, a strip or a flip; checked live above).
test.skip("DG-039 narrower: a strip names the theme and opens both mirrors side by side", async (t) => {
  /* The breakpoints are the page's width, not the window's. Since DG-174 Settings keeps its 272px list down to 761px,
     as the sample's does, so an 860px window leaves a page under 540px (one mirror, as in the sample); 1100px leaves
     about 720px, between the phone's one mirror and the wide column. */
  const { page, errors } = await appearance(t, 1100);
  const strip = page.locator(".sg-strip");
  assert.equal(await strip.isVisible(), true);
  assert.equal(await strip.getAttribute("aria-expanded"), "false");
  assert.deepEqual(await shown(page), [], "closed, no mirror takes room above the themes");
  const words = await strip.evaluate((node) => ({ name: node.querySelector("b").textContent, sub: node.querySelector("small").textContent,
    thumb: node.querySelector(".sg-strip-thumb").getBoundingClientRect().width }));
  assert.equal(words.name, "Slate");
  assert.match(words.sub, /^Moonlight · (spring|summer|autumn|winter)$/);
  assert.equal(words.thumb, 96);
  assert.equal(await strip.evaluate((node) => getComputedStyle(node).backdropFilter), "blur(24px) saturate(1.3)", "the strip is the sample's glass");
  await strip.click();
  assert.equal(await strip.getAttribute("aria-expanded"), "true");
  await drawn(page);
  const mirrors = await shown(page);
  assert.deepEqual(mirrors.map(({ mode }) => mode), ["dark", "light"]);
  assert.ok(Math.abs(mirrors[0].box.top - mirrors[1].box.top) < 1 && mirrors[1].box.left > mirrors[0].box.right, "side by side");
  await strip.click();
  assert.deepEqual(await shown(page), [], "closing folds them away");
  /* Pointing at a theme names it in the strip as a preview, as the sample's strip does. */
  await page.locator('#lx-theme-gallery .lx-tile[data-family="cherry"]').hover();
  await page.waitForFunction(() => document.querySelector(".sg-strip b").textContent === "Cherry (preview)");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (prototype.html's mirrors are pictures beside "Match this computer", not framed live
// copies with chips, a strip or a flip; checked live above).
// Its French is Coming soon (sw:lang), checked at e5b8a610.
test.skip("DG-039 on a phone one mirror shows at a time, and a button flips to the other", async (t) => {
  const { page, errors } = await appearance(t, 400);
  await page.locator(".sg-strip").click();
  await drawn(page);
  assert.deepEqual((await shown(page)).map(({ mode }) => mode), ["dark"]);
  const flip = page.locator(".sg-mirror-flip");
  assert.equal(await flip.textContent(), "Show Daylight");
  assert.deepEqual(await flip.evaluate((node) => {
    const style = getComputedStyle(node), icon = node.querySelector("svg");
    return { height: node.getBoundingClientRect().height, size: style.fontSize, radius: style.borderRadius, padding: style.padding,
      icon: icon && icon.getAttribute("aria-hidden") === "true" ? icon.getBoundingClientRect().width : null };
  }), { height: 30, size: "12.5px", radius: "9px", padding: "0px 11px", icon: 15 }, "the sample's `btn sm` with its swap icon");
  await flip.click();
  await drawn(page);
  assert.deepEqual((await shown(page)).map(({ mode }) => mode), ["light"]);
  assert.equal(await flip.textContent(), "Show Moonlight");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.querySelector(".sg-mirror-flip span")?.textContent !== "Show Moonlight");
  assert.equal(await flip.locator("svg").count(), 1, "a language change re-words the button and keeps its icon");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

/**
 * DG-097: the approved sample has a search box in the top bar — "Search" with its key hint — that opens
 * the same finder as Ctrl K. The window had no such box; the finder was only reachable from the sidebar.
 *
 * The box is checked for what it does, not only for being there: it opens the real finder, Ctrl K still
 * opens that same finder, the key hint it shows is the owner's own binding rather than a fixed "Ctrl K",
 * and where the top bar is narrow it folds to an icon that still has a name to be read out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-topbar-search-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

const finderOpen = (page) => page.locator("#cmd-input").isVisible();
async function closeFinder(page) {
  await page.keyboard.press("Escape");
  await page.locator("#cmd-input").waitFor({ state: "hidden" });
}

test("the top bar has the sample's search box, and it opens the same finder as Ctrl K", async (t) => {
  const { page, errors } = await openApp(t);
  const box = page.locator("header #head-search");
  assert.ok(await box.isVisible(), "a search box is in the top bar");
  assert.equal((await box.locator("span").textContent()).trim(), "Search", "its words are the sample's");
  // The main key is Command on a Mac (public/comfort.js), and the hint says so.
  assert.equal((await box.locator("kbd").textContent()).trim(), process.platform === "darwin" ? "Cmd K" : "Ctrl K", "and it shows the keys that open it");
  // The parts of the sample's box that do not depend on how a font is drawn on this computer. The
  // window's buttons are bold by default; the sample's search box is not.
  assert.deepEqual(await box.evaluate((element) => {
    const style = getComputedStyle(element), icon = element.querySelector("svg").getBoundingClientRect();
    return { height: element.getBoundingClientRect().height, radius: style.borderTopLeftRadius,
      weight: getComputedStyle(element.querySelector("span")).fontWeight, icon: [icon.width, icon.height] };
  }), { height: 32, radius: "10px", weight: "400", icon: [15, 15] });

  await box.click();
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  assert.ok(await finderOpen(page), "clicking it opens the finder");
  const byClick = await page.locator(".cmd-panel").getAttribute("aria-label");
  await closeFinder(page);

  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  assert.equal(await page.locator(".cmd-panel").getAttribute("aria-label"), byClick, "Ctrl K opens that same finder");
  assert.equal(await page.locator(".cmd-panel").count(), 1, "one finder, not a second one for the box");
  await closeFinder(page);
  assert.deepEqual(errors, []);
});

test("the key hint is the owner's own binding, and says nothing when there is none", async (t) => {
  const { app, page } = await openApp(t);
  const box = page.locator("#head-search");
  saveComfort(app.store, "local", "keys", { palette: "Ctrl+Shift+F" });
  await page.evaluate(() => globalThis.branchComfort.refresh());
  // Stored keys say Ctrl for the main key, which is Command on a Mac (public/comfort.js).
  const mac = process.platform === "darwin";
  await page.waitForFunction((shown) => document.getElementById("head-search-keys").textContent === shown, mac ? "Cmd Shift F" : "Ctrl Shift F");
  assert.equal(await box.getAttribute("aria-keyshortcuts"), mac ? "Meta+Shift+F" : "Control+Shift+F", "a screen reader hears the same keys");

  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.locator("#cmd-input").waitFor({ state: "visible" });
  await closeFinder(page);

  saveComfort(app.store, "local", "keys", { palette: "" });
  await page.evaluate(() => globalThis.branchComfort.refresh());
  await page.waitForFunction(() => document.getElementById("head-search-keys").hidden);
  assert.equal(await box.getAttribute("aria-keyshortcuts"), null, "no keys are promised that do nothing");
  await box.click();
  await page.locator("#cmd-input").waitFor({ state: "visible" });
});

/**
 * The box folds by the top bar's own width (720px), as the sample's does. At 960px the window is far
 * too wide to be called narrow, but the sidebar leaves the top bar under 720px, and it folds anyway.
 */
test("the box folds by the top bar's own width, even in a window too wide to fold it", async (t) => {
  const { page } = await openApp(t, 960);
  const widths = await page.evaluate(() => ({
    window: innerWidth,
    bar: document.querySelector("header").clientWidth,
  }));
  assert.ok(widths.window > 760 && widths.bar < 720, `a window wide but a top bar narrow: ${JSON.stringify(widths)}`);
  assert.equal(await page.locator("#head-search span").isVisible(), false, "the word folds by the top bar's width");
  assert.equal(Math.round((await page.locator("#head-search").boundingBox()).width), 34);
});

/**
 * The narrowest top bar a person can get to: a 760px window with the sidebar folded away. The sample
 * folds here by the window's width too; this window has no such rule, because its top bar is still
 * under 720px here (measured 714px) and folds by its own width, as the assertion below records.
 */
test("where the window is narrow the box folds to an icon that can still be named and used", async (t) => {
  const { page } = await openApp(t, 760);
  const box = page.locator("#head-search");
  await page.locator("#rail-toggle").click();
  await page.waitForFunction(() => document.body.classList.contains("no-rail"));
  const bar = await page.evaluate(() => {
    const header = document.querySelector("header"), style = getComputedStyle(header);
    return header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  assert.ok(bar <= 720, `the widest a top bar gets in a 760px window is still one its own width folds (${bar}px)`);
  assert.ok(await box.isVisible(), "the icon is there");
  assert.equal(await box.locator("span").isVisible(), false, "the word folds away");
  assert.equal(await box.locator("kbd").isVisible(), false, "and so does the key hint");
  const size = await box.boundingBox();
  assert.equal(Math.round(size.width), 34, "at the sample's icon width");
  assert.equal(await page.getByRole("button", { name: "Search", exact: true }).count(), 1, "it still has a name");
  await box.click();
  await page.locator("#cmd-input").waitFor({ state: "visible" });
});

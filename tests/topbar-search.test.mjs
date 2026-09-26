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
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then((response) => response.json());
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await call("/api/onboarding", { done: true });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

/* Redesign: prototype.html has no search box in the top bar; its Search box is at the top of the sidebar (#side-q,
   shell/shell.js), with the key hint of the finder (Ctrl K opens the palette, shell/palette.js). The hint and the keys
   are checked there; the top-bar box, its looks and its folding are replaced. */
const finderOpen = (page) => page.locator("#pal-in").isVisible();
async function closeFinder(page) {
  await page.keyboard.press("Escape");
  await page.locator("#pal-in").waitFor({ state: "detached" });
}
const hint = (page) => page.locator("#side .sq9 kbd");

// Redesign: replaced by the new window (prototype.html has no top-bar search box; the sidebar's Search box is checked
// in the next test).
test.skip("the top bar has the sample's search box, and it opens the same finder as Ctrl K", async (t) => {
  const { page, errors } = await openApp(t);
  const box = page.locator("header #head-search");
  assert.ok(await box.isVisible(), "a search box is in the top bar");
  assert.equal((await box.locator("span").textContent()).trim(), "Search", "its words are the sample's");
  assert.equal((await box.locator("kbd").textContent()).trim(), process.platform === "darwin" ? "Cmd K" : "Ctrl K", "and it shows the keys that open it");
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

test("the sidebar's Search box shows the keys that open the finder, and Ctrl K opens one finder", async (t) => {
  const { page, errors } = await openApp(t);
  const box = page.locator("#side-q");
  assert.ok(await box.isVisible(), "a search box is at the top of the list");
  assert.equal(await box.getAttribute("placeholder"), "Search", "its words are the prototype's");
  // The main key is Command on a Mac (shell/keys.js), and the hint says so.
  assert.equal((await hint(page).textContent()).trim(), process.platform === "darwin" ? "Cmd K" : "Ctrl K", "it shows the keys that open the finder");
  await page.keyboard.press("ControlOrMeta+K");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  assert.ok(await finderOpen(page), "Ctrl K opens the finder");
  await page.keyboard.press("ControlOrMeta+K");
  assert.equal(await page.locator(".palette").count(), 1, "one finder, not a second one");
  await closeFinder(page);
  assert.deepEqual(errors, []);
});

test("the key hint is the owner's own binding, and says nothing when there is none", async (t) => {
  const { app, page } = await openApp(t);
  saveComfort(app.store, "local", "keys", { palette: "Ctrl+Shift+F" });
  // The window reads the owner's keys when it opens (shell/keys.js loadKeys).
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const mac = process.platform === "darwin";
  await page.waitForFunction((shown) => document.querySelector("#side .sq9 kbd")?.textContent === shown, mac ? "Cmd Shift F" : "Ctrl Shift F");
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  await closeFinder(page);

  saveComfort(app.store, "local", "keys", { palette: "" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector("#side .sq9 kbd"));
  assert.equal(await page.locator("#side-q").getAttribute("aria-keyshortcuts"), null, "no keys are promised that do nothing");
  // With keys the box says them to a screen reader too (as the old top-bar box did).
  saveComfort(app.store, "local", "keys", { palette: "Ctrl+Shift+F" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#side .sq9 kbd").waitFor();
  assert.equal(await page.locator("#side-q").getAttribute("aria-keyshortcuts"), mac ? "Meta+Shift+F" : "Control+Shift+F", "a screen reader hears the same keys");
});

// Redesign: replaced by the new window (no top-bar search box to fold; prototype.html's Search box is in the sidebar).
test.skip("the box folds by the top bar's own width, even in a window too wide to fold it", async (t) => {
  const { page } = await openApp(t, 960);
  const widths = await page.evaluate(() => ({
    window: innerWidth,
    bar: document.querySelector("header").clientWidth,
  }));
  assert.ok(widths.window > 760 && widths.bar < 720, `a window wide but a top bar narrow: ${JSON.stringify(widths)}`);
  assert.equal(await page.locator("#head-search span").isVisible(), false, "the word folds by the top bar's width");
  assert.equal(Math.round((await page.locator("#head-search").boundingBox()).width), 34);
});

// Redesign: replaced by the new window (no top-bar search box to fold; prototype.html's Search box is in the sidebar).
test.skip("where the window is narrow the box folds to an icon that can still be named and used", async (t) => {
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

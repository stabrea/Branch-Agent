/**
 * The Library's tabs (Memory, Documents, Made for you) ride along at the top of the page as it scrolls.
 * They must sit below the window's header at every width, never on top of it, and nothing that scrolls
 * under them may show through: at 1440×1000 and 390×844 the old tabs were transparent, and on a phone
 * they stuck 12 pixels up into the header, so card text and tab names were drawn over each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

/** Where the header ends, where the tabs are, where the first words of the page under them start. */
const geometry = (page) => page.evaluate(() => {
  const tabs = document.querySelector("#library > .lx-tabs");
  const head = document.querySelector("main > header").getBoundingClientRect();
  const panel = [...document.querySelectorAll('#library .lx-panel[data-place="library"]')].find((node) => node.offsetParent);
  const words = [...panel.querySelectorAll("h2, h3, p, label")].find((node) => node.offsetParent && node.textContent.trim());
  const rgba = getComputedStyle(tabs).backgroundColor.match(/[\d.]+/g).map(Number);
  return {
    head: head.bottom, tabs: tabs.getBoundingClientRect(), words: words.getBoundingClientRect().top,
    workspace: document.getElementById("workspace").getBoundingClientRect().top,
    solid: (rgba[3] ?? 1) === 1,
  };
});

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`at ${width}×${height} the Library's tabs stay under the header and nothing shows through them`, async (t) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const root = await mkdtemp(join(tmpdir(), "branch-library-tabs-"));
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
    await openPlace(page, "library:memory");
    await page.locator("#library > .lx-tabs").waitFor({ state: "visible" });

    const rest = await geometry(page);
    assert.ok(rest.tabs.top >= rest.head - 0.5, `the tabs start below the header (${rest.tabs.top} < ${rest.head})`);
    assert.ok(rest.words >= rest.tabs.bottom - 0.5, `the page's first words start below the tabs (${rest.words} < ${rest.tabs.bottom})`);

    await page.evaluate(() => { document.getElementById("workspace").scrollTop = 500; });
    await page.waitForTimeout(200);
    const scrolled = await geometry(page);
    assert.ok(Math.abs(scrolled.tabs.top - scrolled.workspace) <= 1, `scrolled, the tabs sit at the top of the page (${scrolled.tabs.top}, page at ${scrolled.workspace})`);
    assert.ok(scrolled.tabs.top >= scrolled.head - 0.5, `and never up in the header (${scrolled.tabs.top} < ${scrolled.head})`);
    assert.equal(scrolled.solid, true, "and they are painted solid, so the words scrolling under them do not show through");
    assert.deepEqual(errors, []);
  });
}

/* DG-076: the Settings nav's group headings ("Models and voice", "Safety", "Care", …) are the approved sample's
   (design/Branch-Grown-Up.html, `.set-pages .chip`): 11.5px at weight 560 in the quiet text colour, no letter
   spacing, their text 26.5px below the page link above and 17.3px above the one below, and in line with the
   links' icons. On a phone the sample folds them away with the rest of the nav, and so does the app. Headless. */
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

async function settings(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-nav-groups-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "general");
  return { page, errors };
}

/** Each shown group heading: its type, its colour against the theme's quiet text, and where its words sit. */
const headings = (page) => page.evaluate(() => {
  const probe = document.createElement("i");
  probe.style.color = "var(--text-3)";
  document.body.append(probe);
  const quiet = getComputedStyle(probe).color;
  probe.remove();
  return [...document.querySelectorAll(".sg-nav-group")].filter((el) => el.getClientRects().length).map((el) => {
    const style = getComputedStyle(el), words = document.createRange();
    words.selectNodeContents(el);
    const text = words.getBoundingClientRect(), above = el.previousElementSibling.getBoundingClientRect();
    const below = el.nextElementSibling, icon = below.querySelector("svg").getBoundingClientRect();
    return { name: el.textContent.trim(), size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, tracking: style.letterSpacing,
      quiet: style.color === quiet, above: text.top - above.bottom, below: below.getBoundingClientRect().top - text.bottom, indent: text.left - icon.left };
  });
});

for (const width of [1440, 1024]) {
  test(`DG-076 at ${width} px the nav's group headings are the sample's, in size, colour and spacing`, async (t) => {
    const { page, errors } = await settings(t, width);
    for (const look of ["forest", "daylight"]) {
      await page.evaluate(async (appearance) => {
        const { applyAppearance, currentAppearance } = await import("/appearance.js");
        applyAppearance({ ...currentAppearance(), appearance });
      }, look);
      const seen = await headings(page);
      assert.ok(seen.length >= 3, `${look}: the group headings show (${seen.map((h) => h.name).join(", ")})`);
      for (const heading of seen) {
        const where = `${look}, ${heading.name}`;
        assert.equal(heading.size, "11.5px", `${where}: 11.5px`);
        assert.equal(heading.weight, "560", `${where}: weight 560`);
        assert.equal(heading.line, "17.825px", `${where}: the sample's line`);
        assert.equal(heading.tracking, "normal", `${where}: no letter spacing`);
        assert.equal(heading.quiet, true, `${where}: in the theme's quiet text colour`);
        assert.ok(Math.abs(heading.above - 26.5) <= 0.5, `${where}: 26.5px below the link above (${heading.above})`);
        assert.ok(Math.abs(heading.below - 17.3) <= 0.5, `${where}: 17.3px above the link below (${heading.below})`);
        assert.ok(Math.abs(heading.indent) <= 0.5, `${where}: in line with the links' icons (${heading.indent})`);
      }
    }
    assert.deepEqual(errors, []);
  });
}

test("DG-076 on a phone the group headings fold away with the nav, as the sample's do", async (t) => {
  const { page, errors } = await settings(t, 390);
  assert.deepEqual(await headings(page), [], "no group heading shows at 390 px");
  assert.deepEqual(errors, []);
});

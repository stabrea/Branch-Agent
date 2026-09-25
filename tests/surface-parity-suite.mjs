import nodeTest from "node:test";
/* This file is split into parts so the build machines can run its minutes side by side: each
   tests/surface-parity-N.test.mjs runs every 3th test declared here, starting from its own. Nothing is
   skipped: the parts together declare every test, in the same order, with the same body. */
const part = globalThis.branchTestPart ?? { index: 0, of: 1 };
let declared = 0;
const test = (...args) => (declared++ % part.of === part.index ? nodeTest(...args) : undefined);
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor } from "./places.mjs";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-surface-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#appearance");
  return { page, errors };
}

// Grown-Up fullTokens' opaque surface: 4.5% toward text at night, 62% toward white by day.
// Compute the approved oracle independently, rather than calling the product's solid() helper.
function expectedSurface(ground, text, mode) {
  const amount = mode === "dark" ? 0.045 : 0.62;
  const toward = mode === "dark" ? text : "#ffffff";
  const channels = [1, 3, 5].map((offset) => {
    const from = Number.parseInt(ground.slice(offset, offset + 2), 16);
    return Math.round(from * (1 - amount) + Number.parseInt(toward.slice(offset, offset + 2), 16) * amount);
  });
  return `rgb(${channels.join(", ")})`;
}

for (const width of [1440, 860, 400]) {
  test(`DG-168 all themes share the approved opaque surface at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    const ids = await page.evaluate(async () => (await import("/theme-catalogue.js")).THEMES.map(([id]) => id));
    assert.ok(ids.length >= 44, "the real theme catalogue loaded");
    for (const mode of ["dark", "light"]) {
      await page.locator(`#lx-mode [data-t="look.${mode === "dark" ? "moonlight" : "daylight"}"]`).click(); // DG-160's words
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value,
        mode === "dark" ? "forest" : "daylight");
      for (const contrast of [false, true]) {
        /* Contrast is the sample's two choices now (DG-166), not a tick box. */
        const choice = `#lx-contrast .segmented-option[data-value="${contrast ? "more" : "standard"}"]`;
        await page.locator(choice).click();
        await page.waitForFunction((one) => document.querySelector(one)?.getAttribute("aria-pressed") === "true", choice);
        for (const id of ids) {
          const seen = await page.evaluate((family) => {
            // Dispatch through the existing gallery control; do not write the surface or invoke applyLook.
            document.querySelector(`#lx-theme-gallery .lx-tile[data-family="${family}"]`).click();
            const style = getComputedStyle(document.documentElement);
            return {
              selected: document.documentElement.dataset.palette,
              ground: style.getPropertyValue("--ground").trim(), text: style.getPropertyValue("--text").trim(),
              surface: style.getPropertyValue("--surface").trim(),
              settings: getComputedStyle(document.querySelector(".lx-settings-win")).backgroundColor,
            };
          }, id);
          assert.equal(seen.selected, id);
          const expected = expectedSurface(seen.ground, seen.text, mode);
          assert.equal(seen.surface, expected, `${id}/${mode}/${contrast}: shared token`);
          assert.equal(seen.settings, expected, `${id}/${mode}/${contrast}: real Settings surface`);
        }
      }
    }
    assert.deepEqual(errors, []);
  });
}

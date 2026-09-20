import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * Batch 1 reported 268 native dropdowns PER Settings page and 1,880 in total. The register counted
 * 294 across thirteen pages, and the whole repo has only 50 `createElement("select")` sites. Those
 * cannot all be true. This counts three ways: everything in the document, everything that is really
 * on screen, and everything inside the open Settings panel.
 */
test("how many controls are there really", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "probe-controls-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.waitForTimeout(2500);

  const count = async (label) => {
    const out = await page.evaluate(() => {
      const shown = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
      const all = (sel) => [...document.querySelectorAll(sel)];
      const panel = document.querySelector("#settings, .settings, [class*='settings']");
      const inPanel = (sel) => (panel ? [...panel.querySelectorAll(sel)] : []);
      return {
        selectsInDocument: all("select").length,
        selectsOnScreen: all("select").filter(shown).length,
        selectsInSettingsPanel: inPanel("select").length,
        ticksInDocument: all("input[type=checkbox]").length,
        ticksOnScreen: all("input[type=checkbox]").filter(shown).length,
        switchesOnScreen: all("input.sw,[role=switch]").filter(shown).length,
      };
    });
    console.log(label, JSON.stringify(out));
    return out;
  };

  await count("front door           ");
  // Open Settings the way the window does, then walk a few pages.
  await page.evaluate(() => { document.querySelector("#gearbtn,[data-act='gear']")?.click(); });
  await page.waitForTimeout(1200);
  await count("settings open        ");
  for (const name of ["general", "appearance", "permissions", "advanced"]) {
    await page.evaluate((p) => { if (typeof window.openSettings === "function") window.openSettings(p); }, name);
    await page.waitForTimeout(700);
    await count(`settings › ${name.padEnd(12)}`);
  }
});

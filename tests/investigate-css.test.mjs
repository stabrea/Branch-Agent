import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-css-investigate-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });
  return { page };
}

test("investigate CSS rules affecting .composer", async (t) => {
  const { page } = await fixture(t);

  const cssInfo = await page.evaluate(() => {
    const composer = document.querySelector(".composer");

    // Find all CSS rules that match .composer
    const rules = [];
    [...document.styleSheets].forEach((sheet, sheetIndex) => {
      try {
        [...sheet.cssRules].forEach((rule, ruleIndex) => {
          if (rule.selectorText && rule.style) {
            try {
              if (composer.matches(rule.selectorText)) {
                rules.push({
                  selectorText: rule.selectorText,
                  display: rule.style.display || "(not set)",
                  flexWrap: rule.style.flexWrap || "(not set)",
                  sheet: sheet.href || "inline",
                  index: ruleIndex
                });
              }
            } catch (e) {
              // matches() might fail for some selectors
            }
          }
        });
      } catch (e) {
        // CORS or other access issue
      }
    });

    // Get computed style
    const cs = getComputedStyle(composer);

    return {
      computedDisplay: cs.display,
      computedFlexWrap: cs.flexWrap,
      inlineStyle: composer.getAttribute('style'),
      matchingRules: rules,
      classList: composer.className,
      tagName: composer.tagName
    };
  });

  console.log("\n=== CSS Investigation ===\n");
  console.log("Computed style:");
  console.log(`  display: ${cssInfo.computedDisplay}`);
  console.log(`  flex-wrap: ${cssInfo.computedFlexWrap}`);
  console.log(`\nInline style: ${cssInfo.inlineStyle || "none"}`);
  console.log(`\nElement: <${cssInfo.tagName} class="${cssInfo.className}">\n`);
  console.log("Matching CSS rules (in order of specificity):\n");
  for (const rule of cssInfo.matchingRules) {
    console.log(`  ${rule.selectorText}`);
    console.log(`    display: ${rule.display}, flex-wrap: ${rule.flexWrap}`);
    console.log(`    from: ${rule.sheet} (rule index ${rule.index})\n`);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function measureComposerDimensions(page, label) {
  const dims = await page.evaluate(() => {
    const composer = document.querySelector(".composer");
    if (!composer) return null;

    const cs = (el) => getComputedStyle(el);
    const composerRect = composer.getBoundingClientRect();
    const composerStyle = cs(composer);

    // Get visible children
    const visibleChildren = Array.from(composer.children).filter(el => {
      const s = cs(el);
      return el.offsetParent !== null && !el.hidden && s.display !== "none";
    });

    // Get their measurements
    const children = visibleChildren.map(el => {
      const rect = el.getBoundingClientRect();
      const style = cs(el);
      return {
        id: el.id,
        tag: el.tagName,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        fontSize: style.fontSize
      };
    });

    return {
      composerHeight: Math.round(composerRect.height),
      composerPadding: `${composerStyle.paddingTop} ${composerStyle.paddingRight} ${composerStyle.paddingBottom} ${composerStyle.paddingLeft}`,
      composerGap: composerStyle.gap,
      composerBorder: composerStyle.borderTop,
      childCount: visibleChildren.length,
      children
    };
  });

  if (!dims) {
    console.log(`${label}: Could not find composer`);
    return null;
  }

  console.log(`\n${label}:`);
  console.log(`  Composer height: ${dims.composerHeight}px`);
  console.log(`  Padding: ${dims.composerPadding}`);
  console.log(`  Gap: ${dims.composerGap}`);
  console.log(`  Border: ${dims.composerBorder}`);
  console.log(`  Visible children: ${dims.childCount}`);
  console.log(`\n  Children dimensions:`);
  for (const child of dims.children) {
    if (child.width > 0 && child.height > 0) {
      console.log(`    ${child.id || child.tag}: ${child.width}×${child.height}px, fontSize=${child.fontSize}, padding=${child.padding}`);
    }
  }

  return dims;
}

test("measure composer height: sample vs app", async (t) => {
  // Setup app
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-height-measure-"));
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

  // Measure app at 1440×950
  const appPage = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await appPage.goto(server.url);
  await appPage.getByLabel("Session token", { exact: true }).fill(server.token);
  await appPage.getByRole("button", { name: "Connect", exact: true }).click();
  await appPage.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });
  await appPage.waitForTimeout(300);

  const appDims = await measureComposerDimensions(appPage, "APP at 1440×950");

  // Try to measure sample
  let sampleDims = null;
  try {
    const samplePage = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    await samplePage.goto("http://127.0.0.1:8777/index.html", { timeout: 5000 }).catch(() => null);

    // Check if we can access it
    const title = await samplePage.title().catch(() => null);
    if (title) {
      await samplePage.waitForTimeout(500);
      sampleDims = await measureComposerDimensions(samplePage, "SAMPLE at 1440×950");
    }
    await samplePage.close();
  } catch (e) {
    console.log(`\nNote: Sample server not running on http://127.0.0.1:8777/ - skipping sample measurement`);
  }

  // Summary comparison
  if (appDims) {
    console.log(`\n=== SUMMARY ===`);
    console.log(`App composer height: ${appDims.composerHeight}px (target ~48px, diff: +${appDims.composerHeight - 48}px)`);
    if (sampleDims) {
      console.log(`Sample composer height: ${sampleDims.composerHeight}px`);
      console.log(`Difference: ${Math.abs(appDims.composerHeight - sampleDims.composerHeight)}px`);
    }
  }

  await appPage.close();
});

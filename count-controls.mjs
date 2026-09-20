import { chromium } from "playwright";
import { createBranch, startServer } from "./scripts/startup.mjs";
import { join } from "path";

const root = process.cwd();

async function countControls() {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.click('button:has-text("Sign in")');
    await page.waitForLoadState("networkidle");

    // Count controls
    const nativeSelects = await page.locator("select").count();
    const checkboxes = await page.locator("input[type='checkbox']").count();
    const switches = await page.locator("input[role='switch']").count();
    const segmentedGroups = await page.locator("[role='group'].segmented-control").count();
    const dropdownGroups = await page.locator("[role='group'].choice-row").count();

    console.log("\n=== Control counts (live page) ===");
    console.log(`Native <select> elements: ${nativeSelects}`);
    console.log(`Checkboxes: ${checkboxes}`);
    console.log(`Switches (role=switch): ${switches}`);
    console.log(`Segmented control groups: ${segmentedGroups}`);
    console.log(`Dropdown groups (button groups): ${dropdownGroups}`);

    console.log(`\nTotal controls: ${nativeSelects + checkboxes + switches + segmentedGroups + dropdownGroups}`);
    console.log(`Target native selects: 0`);
    console.log(`Status: ${nativeSelects === 0 ? "✓ PASS" : "✗ FAIL"}`);

  } finally {
    await browser.close();
    await server.close();
  }
}

await countControls();

import { createBranch } from "./dist/index.js";
import { startServer } from "./dist/server.js";
import { chromium } from "playwright";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

async function main() {
  const scratch = join(tmpdir(), "Codex-session-files");
  const testDir = await mkdtemp(join(scratch, "test-batch34-dg032-"));

  console.log("Test: DG-032 and related Settings gaps");
  console.log("====================================\n");

  // Start app on port 0
  const app = await createBranch({
    workspace: join(testDir, "workspace"),
    dataDir: join(testDir, "data"),
  });
  const server = await startServer(app, {
    dataDir: join(testDir, "data"),
    port: 0,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    // Sign in
    console.log("Signing in...");
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });

    // Navigate to Settings
    console.log("Navigating to Settings...");
    await page.click("#lx-settings-row");
    await page.waitForSelector(".lx-settings-body", { timeout: 10000 });

    // Click on Assistant page
    console.log("Navigating to Assistant page...");
    const assistantLink = page.locator('button[data-page="assistant"]');
    const linkExists = await assistantLink.count();
    if (linkExists === 0) {
      console.log("  ERROR: No Assistant link found in settings nav");
      process.exit(1);
    }
    await assistantLink.click();
    await page.waitForTimeout(200);

    // Verify DG-032: Check for duplicate headings
    console.log("\n1. DG-032 - Checking for duplicate headings on Assistant page");
    const assistantPage = page.locator("#lx-page-assistant");
    const pageVisible = await assistantPage.count();
    if (pageVisible === 0) {
      console.log("  ERROR: Assistant page (#lx-page-assistant) not found");
      process.exit(1);
    }

    const h2Elements = await assistantPage.locator("h2").all();
    const h3Elements = await assistantPage.locator("h3").all();

    console.log(`  Found ${h2Elements.length} h2 elements`);
    console.log(`  Found ${h3Elements.length} h3 elements`);

    for (let i = 0; i < h2Elements.length; i++) {
      const text = await h2Elements[i].textContent();
      console.log(`    h2[${i}]: "${text?.trim()}"`);
    }

    for (let i = 0; i < h3Elements.length; i++) {
      const text = await h3Elements[i].textContent();
      console.log(`    h3[${i}]: "${text?.trim()}"`);
    }

    // Check if identity-form has its own heading
    console.log("\n2. Checking for heading inside identity-form...");
    const identityForm = page.locator("#identity-form");
    const identityExists = await identityForm.count();
    if (identityExists > 0) {
      const identityHeadings = await identityForm.locator("h1, h2, h3, h4").all();
      console.log(`  Found ${identityHeadings.length} headings inside identity-form`);
      for (let i = 0; i < identityHeadings.length; i++) {
        const text = await identityHeadings[i].textContent();
        const tag = await identityHeadings[i].evaluate((el) => el.tagName);
        console.log(`    ${tag}[${i}]: "${text?.trim()}"`);
      }
    } else {
      console.log("  identity-form not found");
    }

    // Check DG-006: "On this page" navigation
    console.log("\n3. DG-006 - Checking for 'On this page' navigation...");
    const onThisPage = await assistantPage.locator(".lx-on-this-page").count();
    console.log(`  '.lx-on-this-page' elements found: ${onThisPage}`);

    if (onThisPage > 0) {
      const nav = page.locator("#lx-page-assistant .lx-on-this-page");
      const links = await nav.locator(".lx-on-this-page-link").count();
      console.log(`  Links in navigation: ${links}`);
      const linkTexts = await nav.locator(".lx-on-this-page-link").allTextContents();
      for (const text of linkTexts) {
        console.log(`    - ${text}`);
      }
    } else {
      console.log("  WARNING: DG-006 'On this page' navigation not found!");
    }

    // Check data-bucket attribute vs data-sg-bucket
    console.log("\n4. Checking bucket header attributes...");
    const buckets = await assistantPage.locator(".sg-head").all();
    console.log(`  Found ${buckets.length} bucket headers`);
    for (let i = 0; i < buckets.length; i++) {
      const dataBucket = await buckets[i].getAttribute("data-bucket");
      const dataSgBucket = await buckets[i].getAttribute("data-sg-bucket");
      const text = await buckets[i].locator("h3").first().textContent();
      console.log(`    bucket[${i}]: data-bucket="${dataBucket}" data-sg-bucket="${dataSgBucket}" h3="${text?.trim()}"`);
    }

    // Sample check
    console.log("\n5. Checking sample at http://127.0.0.1:8777...");
    const sampleBrowser = await chromium.launch({ headless: true });
    const samplePage = await sampleBrowser.newPage({ viewport: { width: 1440, height: 950 } });
    await samplePage.goto("http://127.0.0.1:8777/index.html");
    
    // Check if sample has Assistant page and its structure
    const sampleAssistant = samplePage.locator('button[data-page="assistant"]');
    const sampleExists = await sampleAssistant.count();
    console.log(`  Sample has Assistant page link: ${sampleExists > 0}`);

    if (sampleExists > 0) {
      await sampleAssistant.click();
      await samplePage.waitForTimeout(100);
      
      const sampleH2 = await samplePage.locator("#lx-page-assistant h2").all();
      const sampleH3 = await samplePage.locator("#lx-page-assistant h3").all();
      console.log(`  Sample Assistant page: ${sampleH2.length} h2, ${sampleH3.length} h3`);
      
      for (let i = 0; i < sampleH2.length; i++) {
        const text = await sampleH2[i].textContent();
        console.log(`    h2[${i}]: "${text?.trim()}"`);
      }
      for (let i = 0; i < sampleH3.length; i++) {
        const text = await sampleH3[i].textContent();
        console.log(`    h3[${i}]: "${text?.trim()}"`);
      }
    }

    await sampleBrowser.close();

    console.log("\nTest complete!");
  } finally {
    await browser.close();
    await server.close();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(console.error);

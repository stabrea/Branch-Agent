import { createBranch } from "./dist/index.js";
import { startServer } from "./dist/server.js";
import { chromium } from "playwright";
import { join } from "path";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";

async function main() {
  const scratch = join(tmpdir(), "Codex-session-files");
  const testDir = await mkdtemp(join(scratch, "test-dom-structure-"));

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
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 30000 });

    await page.click("#lx-settings-row");
    await page.waitForSelector(".lx-settings-body", { timeout: 10000 });

    await page.locator('button[data-page="assistant"]').click();
    await page.waitForTimeout(200);

    // Get the full HTML structure of the assistant page
    const html = await page.locator("#lx-page-assistant").innerHTML();
    console.log("ASSISTANT PAGE STRUCTURE:");
    console.log("========================\n");
    
    // Pretty print the HTML
    console.log(html.substring(0, 3000));
    
  } finally {
    await browser.close();
    await server.close();
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(console.error);

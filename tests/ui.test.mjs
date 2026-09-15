import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("browser UI connects, runs demo, saves memory, and fits mobile viewport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
  });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#demo-notice").innerText(),
    /deterministic fixture/,
  );
  await page.getByRole("button", { name: "Try the file workflow" }).click();
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".message.assistant").waitFor();
  assert.match(
    await page.locator(".message.assistant").innerText(),
    /wrote, read, and verified/,
  );
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByLabel("Remember something").fill("Browser-created memory");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await page
    .locator("#memory-list h3")
    .filter({ hasText: "Browser-created memory" })
    .waitFor();
  if (process.env.BRANCH_SCREENSHOT_DIR) {
    await mkdir(process.env.BRANCH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-desktop.png"),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  if (process.env.BRANCH_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.BRANCH_SCREENSHOT_DIR, "branch-mobile.png"),
      fullPage: true,
    });
  assert.deepEqual(errors, []);
});

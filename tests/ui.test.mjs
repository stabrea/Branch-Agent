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
  await verifyArtwork(page);
  assert.match(
    await page.locator("#demo-notice").innerText(),
    /offline demonstration/,
  );
  await page.getByRole("button", { name: "Try the file workflow" }).click();
  await page.getByRole("button", { name: "Send" }).click();
  await page.locator(".message.assistant").waitFor();
  assert.match(
    await page.locator(".message.assistant").innerText(),
    /wrote, read, and verified/,
  );
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await page.getByLabel("Search past conversations", { exact: true }).fill("verified");
  await page.getByRole("button", { name: "Search conversations", exact: true }).click();
  await page.locator("#history-results").getByRole("button", { name: "Read message", exact: true }).first().click();
  await page.locator("#history-message").waitFor({ state: "visible" });
  assert.match(await page.locator("#history-message pre").innerText(), /wrote, read, and verified/);
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

async function verifyArtwork(page) {
  await page.waitForFunction(() => [...document.querySelectorAll(".brand-icon img")]
    .every((image) => image.complete && image.naturalWidth === 1024));
  await page.waitForFunction(() => {
    const canvas = document.getElementById("keepoak-acorn");
    return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height)
      .data.some((value, index) => index % 4 === 3 && value > 0);
  });
  const pixels = () => page.locator("#keepoak-acorn").evaluate((canvas) => canvas.toDataURL());
  const first = await pixels();
  await page.waitForFunction((value) => document.getElementById("keepoak-acorn").toDataURL() !== value, first);
  await page.getByRole("button", { name: "Pause rotation", exact: true }).click();
  const frozen = await pixels();
  await page.waitForTimeout(160);
  assert.equal((await pixels()) === frozen, true, "paused acorn must stay still");
  await page.locator("#keepoak-acorn").press("ArrowRight");
  assert.equal((await pixels()) === frozen, false, "arrow key turns the acorn");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Resume rotation", exact: true }).waitFor();
  const reduced = await pixels();
  await page.waitForTimeout(160);
  assert.equal((await pixels()) === reduced, true, "reduced motion disables automatic spin");
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

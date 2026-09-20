import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "composer-input-state-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120_000 });
  return page;
}

test("a half-typed sentence, caret, selection, and focus survive two redraws", async (t) => {
  const page = await fixture(t);
  const box = page.locator(".composer textarea, form.composer textarea").locator("visible=true").first();
  await box.waitFor({ state: "visible", timeout: 120_000 });
  await box.click();
  await page.keyboard.type("Compare the three supplier quotes and flag delivery", { delay: 8 });
  const before = await page.evaluate(() => {
    const input = [...document.querySelectorAll("textarea")].find((element) => element.offsetParent !== null);
    input.setSelectionRange(8, 16);
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
  });

  await page.waitForTimeout(7_000);

  const after = await page.evaluate(() => {
    const input = [...document.querySelectorAll("textarea")].find((element) => element.offsetParent !== null);
    return {
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      focused: document.activeElement === input,
    };
  });
  assert.deepEqual(after, { ...before, focused: true });
});

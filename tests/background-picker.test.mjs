import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor } from "./places.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-background-picker-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ done: true }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#delight-bg-file");
  return { page, errors };
}

test("background picker matches the sample's small themed button at desktop, tablet and phone widths", async (t) => {
  const { page, errors } = await fixture(t);
  const choose = page.getByRole("button", { name: "Choose a file…", exact: true });
  assert.equal(await choose.count(), 1, "a named button replaces the browser's grey file control");
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const appearance of ["forest", "daylight"]) {
      await page.evaluate(async (appearance) => {
        const { applyAppearance, currentAppearance } = await import("/appearance.js");
        applyAppearance({ ...currentAppearance(), appearance });
      }, appearance);
      assert.equal(await page.locator("html").getAttribute("data-palette"), "slate");
      await choose.scrollIntoViewIfNeeded();
      await choose.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      const style = await choose.evaluate((button) => {
        const css = getComputedStyle(button), box = button.getBoundingClientRect();
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--surface)";
        button.append(probe);
        const surface = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { height: box.height, radius: css.borderRadius, fontSize: css.fontSize,
          background: css.backgroundColor, surface, shadow: css.boxShadow,
          focused: document.activeElement === button, outline: css.outlineStyle,
          inside: box.left >= 0 && box.right <= innerWidth,
          icon: button.querySelector('svg[aria-hidden="true"]')?.getBoundingClientRect().width };
      });
      assert.equal(style.height, 30);
      assert.equal(style.radius, "9px");
      assert.equal(style.fontSize, "12.5px");
      assert.equal(style.background, style.surface);
      assert.equal(style.shadow, "none");
      assert.ok(style.focused && style.outline !== "none", "keyboard focus is visible");
      assert.equal(style.icon, 15, "the sample uses its small image icon");
      assert.ok(style.inside, "the complete button fits the viewport");
      assert.equal(await page.locator('#delight-bg-file').isVisible(), false);
    }
  }
  assert.deepEqual(errors, [], "startup and settings must stay error-free");
});

test("background picker opens by mouse, Enter and Space; keeps filenames, errors and repeat selection functional", async (t) => {
  const { page, errors } = await fixture(t);
  const choose = page.getByRole("button", { name: "Choose a file…", exact: true });
  assert.equal(await choose.count(), 1);
  const png = { name: "a-long-real-background-name.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMAAAAwGAQFm2g5eAAAAAElFTkSuQmCC", "base64") };
  for (const activation of ["click", "Enter", "Space"]) {
    const opened = page.waitForEvent("filechooser");
    if (activation === "click") await choose.click();
    else { await choose.focus(); await choose.press(activation); }
    await (await opened).setFiles(png);
    await page.waitForFunction((name) => document.querySelector("#delight-bg-name").textContent === name &&
      document.querySelector("#delight-bg-file").value === "", png.name);
    await page.locator("#delight-wall img").waitFor({ state: "attached" });
    await page.locator("#delight-bg-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") });
    await page.getByRole("status").filter({ hasText: /can't go behind the glass/ }).waitFor();
    assert.equal(await page.locator("#delight-bg-name").textContent(), png.name, "rejection retains the saved picture");
  }
  await page.locator("#delight-bg-file").setInputFiles([]);
  assert.equal(await page.locator("#delight-bg-name").textContent(), png.name, "cancelling does not forget the saved file");
  await page.reload();
  await openSettingFor(page, "#delight-bg-file");
  await page.waitForFunction((name) => document.querySelector("#delight-bg-name").textContent === name, png.name);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove picture", exact: true }).click();
  await page.getByText("No file chosen yet.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test("background picker keeps its accessible name when the language changes", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  const choose = page.getByRole("button", { name: "Choisir un fichier…", exact: true });
  assert.equal(await choose.count(), 1);
  const opened = page.waitForEvent("filechooser");
  await choose.press("Enter");
  assert.equal((await opened).isMultiple(), false);
  assert.deepEqual(errors, []);
});

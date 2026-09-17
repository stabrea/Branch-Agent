/**
 * Wave mac5: the one-click block inside Settings → Models → On this computer, opened the way a
 * person opens it. It ships off, its switch saves as it moves, it fits 400 px, and every word has a
 * key and real French. A headless browser only; the graphics card and free memory are stand-ins,
 * and nothing is set up, so nothing is started or downloaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readGraphicsCard, useGraphicsReader } from "../dist/local-hardware.js";
import { useMemoryReaders } from "../dist/local-fit.js";
import { localModelsMode } from "../dist/local-jobs.js";
import { localKitFor } from "../dist/local-kit.js";
import { openPlace, openSettingFor } from "./places.mjs";

async function fixture(t, width = 1440) {
  useGraphicsReader(async () => ({ name: "Stand-in", memoryBytes: null, sharedMemory: true }));
  useMemoryReaders({ platform: "win32", free: () => 12 * 1024 ** 3, run: async () => { throw new Error("no programs in tests"); } });
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-local-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  // The sizes are only listed once a program that runs models is found. Say Ollama is there, so the
  // block looks the same on a clean build machine as on a computer that has one (nothing is started).
  localKitFor(app.store).launcher.installed = async () => ({ ollama: "/stand-in/ollama", "lm-studio": null, "llama-cpp": null, mlx: null });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
    useGraphicsReader(() => readGraphicsCard()); useMemoryReaders(null);
  });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors, app };
}

test("U1 the block is in Settings → Models → On this computer, starts off, and the switch saves", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openSettingFor(page, "#local-oneclick");
  await page.locator("#local-models-mode").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator("#local-models-mode").inputValue(), "off");
  assert.equal(await page.locator("#local-oneclick button").count(), 0, "while off there is nothing to press");
  await page.locator("#local-models-mode").selectOption("when-needed");
  await page.locator("#local-models-runtime").waitFor();
  assert.equal(localModelsMode(app.store, app.runtime.owner), "when-needed");
  assert.ok(await page.locator("#local-oneclick .local-fit").count() > 0, "each size says whether it fits");
  await openPlace(page, "chat");
  assert.equal(await page.locator("#local-oneclick").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("U2 at 400 px nothing scrolls sideways, and every word has a key and French", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openSettingFor(page, "#local-oneclick");
  await page.locator("#local-models-mode").waitFor({ state: "visible", timeout: 15000 });
  await page.locator("#local-models-mode").selectOption("when-needed");
  await page.locator("#local-models-runtime").waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  const box = await page.locator("#local-models-runtime").boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 400);
  const raw = await page.evaluate(() => document.querySelector("#local-oneclick").innerText.match(/\{[a-z]+\}/g));
  assert.equal(raw, null, "no {placeholder} is ever shown");
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#local-oneclick p, #local-oneclick label, #local-oneclick option, #local-oneclick button, #local-oneclick a, #local-oneclick span")]
    .filter((node) => node.textContent.trim() && !node.dataset.t && !node.dataset.tKey && !node.closest(".item > p:nth-of-type(1)")).map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed.filter((text) => !/^[A-Z0-9_]+$/.test(text)), [], "only model summaries (in both languages) and size names are data");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#local-oneclick");
  await page.waitForFunction(() => document.querySelector("label[for=local-models-mode]")?.textContent === "Modèles sur cet ordinateur");
  assert.deepEqual(errors, []);
});

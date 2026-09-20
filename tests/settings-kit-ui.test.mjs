import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings, showEverything } from "./places.mjs";
import { loopGuardMode } from "../dist/loop-guard.js";
import { recordingSettings } from "../dist/run-recording.js";

/* R17-S02, S03, S05, S06, S07 in the window, at phone width: presets and putting settings back with
   the change list, one settings file, which file does what, and what first run offers next. */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-kit-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  return { app, page, errors, root };
}
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("R17-S03 and S02: a preset and putting things back both show every change, and loosening needs its own yes", async (t) => {
  const { app, page, errors } = await fixture(t);
  const owner = app.runtime.owner;
  await openSettings(page, "general");
  const presets = page.locator("#settings-kit-presets");
  await presets.scrollIntoViewIfNeeded();
  assert.ok(await noSidewaysScroll(page), "the page scrolls sideways at 400 px");
  await presets.getByLabel("Preset").selectOption("careful");
  await presets.getByRole("button", { name: "Show what would change" }).click();
  const rows = presets.locator(".kit-change input");
  await rows.first().waitFor();
  assert.ok(await rows.count() >= 5);
  assert.equal(await presets.locator(".kit-loose").count(), 0, "nothing here loosens a fresh install");
  assert.equal(await presets.locator(".kit-change", { hasText: "Stopping repeated steps" }).count(), 1, "each line names the setting in plain words");
  await presets.getByRole("button", { name: "Make the ticked changes" }).click();
  await presets.locator("[role=status]", { hasText: "changed" }).waitFor();
  assert.equal(loopGuardMode(app.store, owner), "on");

  const reset = page.locator("#settings-kit-reset");
  await reset.getByRole("button", { name: "Show what would change" }).click();
  await reset.locator(".kit-change").first().waitFor();
  const loose = reset.locator(".kit-change", { hasText: "Stopping repeated steps" });
  assert.equal(await loose.locator(".kit-loose").count(), 1, "turning a guard off is marked");
  assert.equal(await loose.locator("input").isChecked(), false, "a loosening line starts unticked");
  await loose.locator("input").check();
  await reset.getByRole("button", { name: "Make the ticked changes" }).click();
  await reset.locator("[role=status]", { hasText: "less careful" }).waitFor();
  assert.equal(loopGuardMode(app.store, owner), "on", "nothing was written without the separate yes");
  await reset.getByLabel("Yes, make it less careful").check();
  await reset.getByRole("button", { name: "Make the ticked changes" }).click();
  await reset.locator("[role=status]", { hasText: "changed" }).waitFor();
  assert.equal(loopGuardMode(app.store, owner), "off");
  assert.ok(await noSidewaysScroll(page), "the change list scrolls sideways at 400 px");
  assert.deepEqual(errors, []);
});

test("R17-S07: settings go out as one file and come back through the same change list", async (t) => {
  const { app, page } = await fixture(t);
  await openSettings(page, "data");
  const card = page.locator("#settings-kit-file");
  await card.scrollIntoViewIfNeeded();
  const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Save a copy" }).click()]);
  const saved = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(saved.format, "branch-settings");
  assert.equal(download.suggestedFilename(), "branch-settings.json");
  saved.settings.loop_guard.mode = "when-needed";
  saved.settings.lockdown = { on: false };
  await card.getByLabel("Bring in a settings file").setInputFiles({ name: "mine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(saved)) });
  await card.locator(".kit-change", { hasText: "Stopping repeated steps" }).waitFor();
  assert.equal(await card.locator(".kit-change").count(), 1, "only the one real difference is offered");
  assert.match(await card.textContent(), /lockdown\.on: not a setting that can be changed from here/);
  await card.getByRole("button", { name: "Make the ticked changes" }).click();
  await card.locator("[role=status]", { hasText: "changed" }).waitFor();
  assert.equal(loopGuardMode(app.store, app.runtime.owner), "when-needed");
});

test("R17-S05: which file does what, and changing one without leaving the window", async (t) => {
  const { app, page } = await fixture(t);
  await openSettings(page, "instructions");
  const card = page.locator("#agent-files");
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.locator(".agent-file").count(), 8);
  const soul = card.locator(".agent-file", { hasText: "SOUL.md" });
  assert.match(await soul.textContent(), /Its character/);
  assert.match(await soul.textContent(), /Not written yet/);
  await soul.getByRole("button", { name: "Change SOUL.md here" }).click();
  await card.getByLabel("What the file says").fill("Speak plainly and briefly.");
  await card.getByRole("button", { name: "Save this file" }).click();
  await card.locator("[role=status]", { hasText: "Saved" }).waitFor();
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "Speak plainly and briefly.\n");
  await card.getByRole("button", { name: "Back to all files" }).click();
  await card.locator(".agent-file", { hasText: "SOUL.md" }).locator("text=Not read: switched off").waitFor();
  assert.ok(await noSidewaysScroll(page));
});

test("R17-S06: after first run, an offer to say hello, watch once, or start from a suggested automation", async (t) => {
  const { app, page } = await fixture(t);
  /* The calm window (0.18.1) leaves this card out; it belongs to the full window. */
  await showEverything(page);
  await page.evaluate(() => { localStorage.removeItem("branch-first-run-next"); document.getElementById("first-run").hidden = true; globalThis.branchFirstRunDone(); });
  const card = page.locator("#first-run-next");
  await card.getByRole("heading", { name: "You're ready" }).waitFor();
  await card.getByRole("button", { name: "Watch me once" }).click();
  await card.locator("[role=status]", { hasText: "Recording is on" }).waitFor();
  assert.equal(recordingSettings(app.store, app.runtime.owner).mode, "when-needed");
  await card.getByRole("button", { name: /Every weekday at 8/ }).click();
  assert.match(await page.locator("#prompt").inputValue(), /Every weekday at 8/);
  await card.getByRole("button", { name: "Not now" }).click();
  assert.equal(await card.count(), 0);
  await page.evaluate(() => globalThis.branchFirstRunDone());
  assert.equal(await page.locator("#first-run-next").count(), 0, "it is offered once");
  assert.ok(await noSidewaysScroll(page));
});

test("every word the new cards show is on file in English", async (t) => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const { page } = await fixture(t);
  await page.evaluate(() => { globalThis.branchFirstRunDone(); });
  const keys = await page.evaluate(() => [...document.querySelectorAll(
    "#settings-kit-presets [data-t], #settings-kit-reset [data-t], #settings-kit-file [data-t], #agent-files [data-t], #first-run-next [data-t], .kit-describe[data-t], .kit-scope[data-t]",
  )].map((node) => node.dataset.t));
  assert.ok(keys.length > 20);
  assert.deepEqual([...new Set(keys.filter((key) => !(key in en)))], []);
});

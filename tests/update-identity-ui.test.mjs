/**
 * Q55 in the window: Settings > Updates & about names the installed build (its version and the
 * commit it was built from, or "not recorded"), shows the offered release's own notes, and after a
 * failed update says plainly what was kept. The updater is a stand-in: nothing is checked or installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor } from "./places.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const offered = { available: true, latestVersion: "9.9.9", currentVersion: "0.19.3", channel: "stable", notes: "Faster start.\nFixed the Files view." };

async function openApp(t, status) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-update-identity-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((first) => {
    globalThis.__status = first;
    window.branchDesktop = {
      updateStatus: async () => globalThis.__status,
      checkForUpdates: async () => globalThis.__status,
      installUpdate: async () => {
        globalThis.__status = { ...globalThis.__status, phase: "error", message: "The download stopped.", outcome: { kept: globalThis.__status.installed.version } };
        throw new Error("The download stopped.");
      },
      modelSettings: async () => ({}), openExternal: async () => true,
    };
  }, status);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openSettingFor(page, "#updates-card");
  await page.locator("#updates-card").waitFor({ state: "visible" });
  return { page, errors };
}
const text = (page, id) => page.locator(id).evaluate((node) => node.textContent);

test("the installed build shows its version and commit, and the offered release its own notes", async (t) => {
  const { page, errors } = await openApp(t, { phase: "available", message: "Version 9.9.9 is ready to install.", progress: null,
    installed: { version: "0.19.3", commit: COMMIT }, outcome: null, release: offered });
  await page.waitForFunction(() => document.querySelector("#updates-build-version")?.textContent === "0.19.3");
  assert.equal(await text(page, "#updates-build-commit"), COMMIT.slice(0, 12));
  assert.equal(await page.locator("#updates-build-commit").getAttribute("title"), COMMIT);
  assert.equal(await page.locator("#updates-notes").isVisible(), true);
  assert.equal(await text(page, "#updates-notes-title"), "What's new in 9.9.9");
  assert.equal(await text(page, "#updates-notes-text"), offered.notes);
  assert.equal(await page.locator("#updates-outcome").isVisible(), false, "nothing failed, so nothing is said about it");
  // The channel control is untouched: three choices, Stable picked.
  assert.deepEqual(await page.locator('#updates-channel input[name="release-channel"]').evaluateAll((all) => all.map((one) => one.value)), ["stable", "beta", "dev"]);
  assert.equal(await page.locator('#updates-channel input[value="stable"]').isChecked(), true);
  assert.deepEqual(errors, []);
});

test("a build without a recorded commit says so, and a release with no notes says that too", async (t) => {
  const { page, errors } = await openApp(t, { phase: "available", message: "A newer Dev build can be built.", progress: null,
    installed: { version: "0.19.3", commit: null }, outcome: null, release: { ...offered, channel: "dev", notes: "" } });
  await page.waitForFunction(() => document.querySelector("#updates-build-commit")?.textContent === "not recorded");
  assert.equal(await text(page, "#updates-notes-text"), "No notes were published for this version.");
  assert.deepEqual(errors, []);
});

test("nothing offered hides the notes", async (t) => {
  const { page } = await openApp(t, { phase: "current", message: "You have the newest version (0.19.3).", progress: null,
    installed: { version: "0.19.3", commit: COMMIT }, outcome: null, release: { ...offered, available: false, latestVersion: "0.19.3" } });
  await page.waitForFunction(() => document.querySelector("#updates-build-version")?.textContent === "0.19.3");
  assert.equal(await page.locator("#updates-notes").isVisible(), false);
});

test("a failed update says what was kept, in English and in French", async (t) => {
  const { page, errors } = await openApp(t, { phase: "available", message: "Version 9.9.9 is ready to install.", progress: null,
    installed: { version: "0.19.3", commit: COMMIT }, outcome: null, release: offered });
  await page.locator("#updates-install").click();
  await page.waitForFunction(() => !document.querySelector("#updates-outcome")?.hidden);
  assert.equal(await text(page, "#updates-status"), "The download stopped.");
  assert.equal(await text(page, "#updates-outcome"), "Nothing was changed: Branch Agent 0.19.3 is still installed, and your work is as it was.");

  // The language changes after the card was drawn, so the filled-in sentences must be redrawn, not left as templates.
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:about");
  await page.waitForFunction(() => document.querySelector("#updates-outcome")?.textContent.startsWith("Rien n’a changé"));
  assert.equal(await text(page, "#updates-outcome"), "Rien n’a changé : Branch Agent 0.19.3 est toujours installé, et votre travail est resté tel quel.");
  assert.equal(await text(page, "#updates-notes-title"), "Nouveautés de la version 9.9.9");
  assert.equal(await page.locator("#updates-build dt").first().textContent(), "Version installée");
  assert.equal(await text(page, "#updates-build-commit"), COMMIT.slice(0, 12));
  assert.deepEqual(errors, []);
});

test("in French, a missing commit reads as not recorded", async (t) => {
  const { page } = await openApp(t, { phase: "idle", message: "", progress: null, installed: { version: "0.19.3", commit: null }, outcome: null, release: null });
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:about");
  await page.waitForFunction(() => document.querySelector("#updates-build-commit")?.textContent === "non enregistré");
});

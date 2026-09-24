/**
 * Q73: The build provenance sentence must be visible persistently in the update card,
 * even after the phase moves on to "unpacking" and beyond.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { openSettingFor, closeSettings } from "./places.mjs";

const PROVENANCE_CHECKED = "A build provenance record was found for this download. It names this exact file and Branch's release workflow run for a version tag, and its signature matches the certificate that came with it. That certificate's chain back to Sigstore was not verified.";
const PROVENANCE_NOTCHECKED = "The build provenance record for this download was not checked: GitHub could not be reached, did not answer in time, or sent a record that could not be read. The update relies on the published checksum alone, which it passed.";
const PROVENANCE_NONE = "No build provenance record is published for this download. The update relies on the published checksum alone, which it passed.";

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-update-status-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Stub window.branchDesktop before app.js loads, like Electron preload does.
  await page.addInitScript(() => {
    globalThis.window.branchDesktop = {
      updateStatus: async () => {
        const phase = globalThis.__updatePhase || "idle";
        const isInstalling = ["downloading", "verifying", "unpacking", "ready", "applying"].includes(phase);
        const message = phase === "verifying" ? "Making sure the download is exactly what was published" : phase === "unpacking" ? "Unpacking…" : "";
        return {
          phase,
          message,
          progress: null,
          release: { latestVersion: "0.19.4" },
          ...(isInstalling && globalThis.__provenanceStatus ? { provenance: globalThis.__provenanceStatus } : {}),
        };
      },
      checkForUpdates: async () => ({ phase: "checking", message: "", progress: null, release: null }),
      modelSettings: async () => ({}),
    };
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("Q73: the provenance sentence persists in the update card while unpacking", async (t) => {
  const { page, errors } = await openApp(t);

  // Set up provenance status and navigate to updates card.
  await page.evaluate(({ PROVENANCE_CHECKED }) => {
    globalThis.__provenanceStatus = { outcome: "checked", message: PROVENANCE_CHECKED };
    globalThis.__updatePhase = "verifying";
  }, { PROVENANCE_CHECKED });

  await openSettingFor(page, "#updates-card");

  // Wait for status text to show and provenance to be visible.
  await page.waitForFunction(() =>
    document.getElementById("updates-status")?.textContent.includes("Make") ||
    document.getElementById("updates-status")?.textContent.includes("Unpacking")
  );

  // Check that provenance is visible during verifying phase.
  await page.waitForFunction(() =>
    document.getElementById("updates-provenance") &&
    !document.getElementById("updates-provenance").hidden &&
    document.getElementById("updates-provenance").textContent.includes("build provenance")
  );

  const provenanceText = await page.locator("#updates-provenance").textContent();
  assert.ok(provenanceText.includes("build provenance"), "provenance message is visible during verifying");

  // Now move to unpacking phase - the provenance should still be visible (polling updates it).
  await page.evaluate(() => { globalThis.__updatePhase = "unpacking"; });

  // Wait for status text to change to "Unpacking…"
  await page.waitForFunction(() =>
    document.getElementById("updates-status")?.textContent.includes("Unpacking")
  );

  const provenanceAfterUnpack = await page.locator("#updates-provenance").textContent();
  assert.equal(provenanceAfterUnpack, provenanceText, "provenance persists after unpacking phase");
  assert.ok(!await page.locator("#updates-provenance").isHidden(), "provenance is still visible after unpacking");

  await closeSettings(page);
  assert.deepEqual(errors, []);
});

test("Q73: the provenance sentence is hidden when checking starts a new update check", async (t) => {
  const { page, errors } = await openApp(t);

  // Set up provenance status and navigate to updates card.
  await page.evaluate(({ PROVENANCE_NOTCHECKED }) => {
    globalThis.__provenanceStatus = { outcome: "not-checked", message: PROVENANCE_NOTCHECKED };
    globalThis.__updatePhase = "verifying";
  }, { PROVENANCE_NOTCHECKED });

  await openSettingFor(page, "#updates-card");

  // Show the provenance during verifying.
  await page.waitForFunction(() =>
    document.getElementById("updates-provenance") &&
    !document.getElementById("updates-provenance").hidden
  );

  // Move back to checking phase - provenance should hide.
  await page.evaluate(() => { globalThis.__updatePhase = "checking"; globalThis.__provenanceStatus = null; });

  // Wait for the provenance to be hidden.
  await page.waitForFunction(() => document.getElementById("updates-provenance")?.hidden);

  assert.ok(await page.locator("#updates-provenance").isHidden(), "provenance is hidden during checking");
  await closeSettings(page);
  assert.deepEqual(errors, []);
});

test("Q73: provenance displays correctly in French", async (t) => {
  const { page, errors } = await openApp(t);

  // Read the French locales to verify translation is used.
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const expectedFrenchNone = french["updates.provenance.none"];

  // Set up provenance status for "none" outcome and navigate to updates card.
  await page.evaluate(({ message }) => {
    globalThis.__provenanceStatus = { outcome: "none", message };
    globalThis.__updatePhase = "verifying";
  }, { message: PROVENANCE_NONE });

  // Switch language to French through the appearance API (how the app actually does it).
  await page.evaluate(async () => {
    const response = await fetch("/api/preferences", {
      method: "POST",
      headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
      body: JSON.stringify({ language: "fr" }),
    });
    if (!response.ok) throw new Error("language preference was refused");
  });

  // Navigate to updates card in the new language.
  await openSettingFor(page, "#updates-card");

  // Wait for provenance to be visible.
  await page.waitForFunction(() =>
    document.getElementById("updates-provenance") &&
    !document.getElementById("updates-provenance").hidden
  );

  const provenanceText = await page.locator("#updates-provenance").textContent();
  assert.equal(provenanceText, expectedFrenchNone, "provenance message is displayed in French");
  await closeSettings(page);
  assert.deepEqual(errors, []);
});

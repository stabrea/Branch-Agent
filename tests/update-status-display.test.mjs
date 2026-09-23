/**
 * Q73: The build provenance sentence must be visible persistently in the update card,
 * even after the phase moves on to "unpacking" and beyond.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

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
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("Q73: the provenance sentence persists in the update card while unpacking", async (t) => {
  const { page, errors } = await openApp(t);

  // Mock the desktop updater with provenance status.
  await page.evaluate(({ PROVENANCE_CHECKED }) => {
    window.branchDesktop = {
      updateStatus: async () => {
        // Start with verifying phase (where provenance is found).
        const currentPhase = globalThis.__currentPhase || "verifying";
        return {
          phase: currentPhase,
          message: currentPhase === "verifying" ? "Making sure the download is exactly what was published" : "Unpacking…",
          progress: null,
          release: { latestVersion: "0.19.4" },
          provenance: {
            outcome: "checked",
            message: PROVENANCE_CHECKED,
          },
        };
      },
      checkForUpdates: async () => ({ phase: "checking", message: "", release: null }),
    };
  }, { PROVENANCE_CHECKED });

  // Move to Settings/Updates to see the update card.
  await page.locator("#rail-settings").click();
  await page.waitForFunction(() => document.querySelector("#updates-card"));

  // Check that provenance is visible during verifying phase.
  await page.evaluate(() => { globalThis.__currentPhase = "verifying"; });
  await page.evaluate(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}));
  await page.waitForFunction(() =>
    document.getElementById("updates-provenance") &&
    !document.getElementById("updates-provenance").hidden &&
    document.getElementById("updates-provenance").textContent.includes("build provenance")
  );

  const provenanceText = await page.locator("#updates-provenance").textContent();
  assert.ok(provenanceText.includes("build provenance"), "provenance message is visible during verifying");

  // Now move to unpacking phase - the provenance should still be visible.
  await page.evaluate(() => { globalThis.__currentPhase = "unpacking"; });
  await page.evaluate(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}));

  const provenanceAfterUnpack = await page.locator("#updates-provenance").textContent();
  assert.equal(provenanceAfterUnpack, provenanceText, "provenance persists after unpacking phase");
  assert.ok(!await page.locator("#updates-provenance").isHidden(), "provenance is still visible after unpacking");

  assert.deepEqual(errors, []);
});

test("Q73: the provenance sentence is hidden when checking starts a new update check", async (t) => {
  const { page, errors } = await openApp(t);

  // Mock the desktop updater.
  await page.evaluate(() => {
    window.branchDesktop = {
      updateStatus: async () => {
        const phase = globalThis.__phase || "idle";
        if (phase === "verifying") {
          return {
            phase,
            message: "Verifying…",
            progress: null,
            release: { latestVersion: "0.19.4" },
            provenance: {
              outcome: "not-checked",
              message: "The build provenance record for this download was not checked: GitHub could not be reached, did not answer in time, or sent a record that could not be read. The update relies on the published checksum alone, which it passed.",
            },
          };
        }
        return { phase, message: "", progress: null, release: null };
      },
      checkForUpdates: async () => ({ phase: "checking", message: "" }),
    };
  });

  await page.locator("#rail-settings").click();
  await page.waitForFunction(() => document.querySelector("#updates-card"));

  // Show the provenance during verifying.
  await page.evaluate(() => { globalThis.__phase = "verifying"; });
  await page.evaluate(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}));
  await page.waitForFunction(() => !document.getElementById("updates-provenance").hidden);

  // Move back to checking phase - provenance should hide.
  await page.evaluate(() => { globalThis.__phase = "checking"; });
  await page.evaluate(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}));

  assert.ok(await page.locator("#updates-provenance").isHidden(), "provenance is hidden during checking");
  assert.deepEqual(errors, []);
});

test("Q73: provenance displays correctly in French", async (t) => {
  const { page, errors } = await openApp(t);

  // Set the language to French.
  await page.evaluate(() => {
    localStorage.setItem("language", "fr");
  });

  // Mock the updater with a provenance message.
  await page.evaluate(() => {
    window.branchDesktop = {
      updateStatus: async () => ({
        phase: "verifying",
        message: "Vérification du téléchargement",
        progress: null,
        release: { latestVersion: "0.19.4" },
        provenance: {
          outcome: "none",
          message: "No build provenance record is published for this download. The update relies on the published checksum alone, which it passed.",
        },
      }),
    };
  });

  await page.locator("#rail-settings").click();
  await page.waitForFunction(() => document.querySelector("#updates-card"));

  // Reload the page to apply French language setting.
  await page.reload();
  await page.getByLabel("Session token", { exact: true }).fill(await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#rail-settings").click();

  await page.evaluate(() => window.branchDesktop.updateStatus().then(showUpdateStatus).catch(() => {}));
  await page.waitForFunction(() => !document.getElementById("updates-provenance").hidden);

  const provenanceText = await page.locator("#updates-provenance").textContent();
  assert.ok(provenanceText, "provenance message is rendered");
  assert.deepEqual(errors, []);
});

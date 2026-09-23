/**
 * FQ-operations.sandbox-lifecycle (owner-facing screen): the Settings > Computer card that lets the
 * owner create, snapshot, stop and restore a configured agent sandbox through the window, not only
 * through the HTTP door (tests/agent-sandbox-lifecycle.test.mjs covers that door directly). Follows
 * public/os-sandbox.js's pattern: every control has its own sentence (R17-S01/S04), the card carries
 * no heading-shaped description (DG-024), and it works in French too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor, closeSettings } from "./places.mjs";

async function openApp(t, viewport = { width: 1280, height: 900 }) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-agent-sandbox-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-sandbox-card").waitFor({ state: "attached", timeout: 60000 });
  return { app, page, errors };
}

const describedWords = (page, id) => page.evaluate((controlId) => {
  const control = document.getElementById(controlId);
  const ids = (control?.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  return ids.map((noteId) => document.getElementById(noteId)?.textContent.trim() ?? "").join(" ").trim();
}, id);

test("the Agent sandboxes card creates, snapshots, stops and restores a sandbox from the window", async (t) => {
  const { page, errors } = await openApp(t);
  await openSettingFor(page, "#agent-sandbox-card");
  await page.locator("#agent-sandbox-card").waitFor({ state: "visible" });

  // R17-S01: card structure — h2 immediately followed by its purpose sentence, no heading-as-description.
  assert.equal(await page.locator("#agent-sandbox-card > h2").count(), 1);
  assert.equal(await page.locator("#agent-sandbox-card > h2 + p.subtle").count(), 1, "the card says what it is for in one sentence, not a heading");
  assert.match(await page.locator("#agent-sandbox-card > h2").textContent(), /Agent sandboxes/);

  // R17-S04: every visible control has its own sentence, from public/settings-descriptions.js.
  for (const id of ["agent-sandbox-name", "agent-sandbox-network", "agent-sandbox-providers"])
    assert.ok((await describedWords(page, id)).length > 0, `#${id} has no description`);

  assert.match(await page.locator("#agent-sandbox-list").textContent(), /No agent sandboxes yet/);

  await page.locator("#agent-sandbox-name").fill("Research box");
  await page.locator("#agent-sandbox-network").selectOption("per-site");
  await page.locator("#agent-sandbox-providers").fill("anthropic, openai");
  await page.getByRole("button", { name: "Create sandbox" }).click();

  const row = page.locator("#agent-sandbox-list .card-row").first();
  await row.locator("h4", { hasText: "Research box" }).waitFor({ state: "visible" });
  assert.match(await row.textContent(), /Running/);
  assert.match(await row.textContent(), /Sites you allow/);
  assert.match(await row.textContent(), /anthropic, openai/);
  assert.match(await row.textContent(), /No snapshots yet/);

  // Snapshot, then stop: the row keeps its declared network and providers throughout.
  await row.getByRole("button", { name: "Snapshot now" }).click();
  await row.locator(".agent-sandbox-snapshots .card-row").first().waitFor({ state: "visible" });
  assert.doesNotMatch(await row.textContent(), /No snapshots yet/);

  await row.getByRole("button", { name: "Stop", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#agent-sandbox-list .card-row")?.textContent.includes("Stopped"));
  assert.doesNotMatch(await row.textContent(), /Running/);
  assert.equal(await row.getByRole("button", { name: "Stop", exact: true }).isVisible(), false, "a stopped sandbox has no Stop button to click again");

  // Restoring from the one snapshot brings the files back but leaves a stopped sandbox stopped,
  // network and providers unchanged.
  await row.getByRole("button", { name: "Restore" }).click();
  await page.waitForFunction(() => document.querySelector("#agent-sandbox-card [role=status]")?.textContent === "Restored.");
  assert.match(await row.textContent(), /Stopped/);
  assert.doesNotMatch(await row.textContent(), /Running/);
  assert.match(await row.textContent(), /Sites you allow/);
  assert.match(await row.textContent(), /anthropic, openai/);

  await closeSettings(page);
  assert.deepEqual(errors, []);
});

test("the Agent sandboxes card speaks French", async (t) => {
  const { page } = await openApp(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await openSettingFor(page, "#agent-sandbox-card");
  await page.locator("#agent-sandbox-card").waitFor({ state: "visible" });
  const heading = await page.locator("#agent-sandbox-card > h2").textContent();
  assert.equal(heading, "Bacs à sable d'agent");
  assert.notEqual(heading, "Agent sandboxes");
  await page.locator("#agent-sandbox-name").fill("Boîte");
  await page.locator("#agent-sandbox-providers").fill("anthropic");
  await page.getByRole("button", { name: "Créer le bac à sable" }).click();
  await page.locator("#agent-sandbox-list .card-row h4", { hasText: "Boîte" }).waitFor({ state: "visible" });
  assert.match(await page.locator("#agent-sandbox-list .card-row").first().textContent(), /En cours/);
});

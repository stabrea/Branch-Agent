/**
 * mac3/security-check: the card on Settings → Permissions, opened the way a person opens it.
 * A headless browser only; the check runs against a Branch in a temporary folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";

async function fixture(t, viewport = { width: 1440, height: 1000 }) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-security-ui-"));
  const dataDir = join(root, "data");
  const provider = { name: "security-ui-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider, home: root });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors, app, dataDir };
}

test("the card lives on Settings → Permissions and nowhere else", async (t) => {
  const { page, errors } = await fixture(t);
  const card = page.locator("#security-check");
  await card.waitFor({ state: "attached", timeout: 15000 });
  await openSettings(page, "permissions");
  await card.waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await card.locator("h2").innerText()).trim(), "Security check");
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, "one filled button");
  await openPlace(page, "chat");
  assert.equal(await card.isVisible(), false);
  assert.deepEqual(errors, []);
});

test("both switches start off, a change is saved, and the check reports what it found", async (t) => {
  const { page, errors, app, dataDir } = await fixture(t);
  await openSettings(page, "permissions");
  const card = page.locator("#security-check");
  await card.waitFor();
  assert.equal(await card.locator("#security-audit-mode").inputValue(), "off");
  assert.equal(await card.locator("#security-malware-mode").inputValue(), "off");
  assert.match(await card.locator("#security-summary").innerText(), /Not checked yet/);

  await card.locator("#security-malware-mode").selectOption("when-needed");
  await card.getByText("Saved.").waitFor();
  assert.deepEqual(app.security.settings(), { audit: "off", malware: "when-needed" });

  if (process.platform !== "win32") await chmod(join(dataDir, "branch.sqlite"), 0o644).then(() => chmod(dataDir, 0o755));
  await card.getByRole("button", { name: "Run the check", exact: true }).click();
  await card.locator("#security-summary").filter({ hasText: /checks/ }).waitFor();
  if (process.platform !== "win32") {
    await card.locator('[data-check="files.database-readable"]').waitFor();
    await card.getByRole("button", { name: "Fix what Branch can", exact: true }).click();
    await card.getByText(/Now only you can reach it/).first().waitFor();
    assert.equal(await card.locator('[data-check="files.database-readable"]').count(), 0, "the repaired finding is gone");
  }
  assert.deepEqual(errors, []);
});

test("the card holds its shape at 400 px and speaks French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openSettings(page, "permissions");
  const card = page.locator("#security-check");
  await card.waitFor();
  await card.getByRole("button", { name: "Run the check", exact: true }).click();
  await card.locator("#security-summary").filter({ hasText: /checks/ }).waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow} px`);
  const box = await card.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 400, "the card fits the window");
  for (const control of ["#security-audit-mode", "#security-malware-mode"])
    assert.ok((await card.locator(`label[for="${control.slice(1)}"]`).innerText()).trim().length > 0, `${control} has a name`);

  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.locator("#security-check h2").filter({ hasText: "Contrôle de sécurité" }).waitFor();
  assert.ok(await page.locator("#security-check").getByRole("button", { name: "Lancer le contrôle" }).isVisible());
  assert.deepEqual(errors, []);
});

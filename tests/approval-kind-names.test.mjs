import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

/*
 * Settings › Permissions, "a kind of thing at a time" (public/misc.js): one dropdown per kind of tool.
 * They had no name, so a screen reader announced the same "combo box, Leave as it is" six times
 * with nothing to tell them apart. Each is now named by its kind, and still says what the choice does.
 */
test("every kind-of-tool dropdown is named by its kind, and still says what the choice does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-kinds-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openSettings(page, "permissions");
  const selects = page.locator("#approval-categories select");
  await selects.first().waitFor({ state: "visible", timeout: 30000 });

  const kinds = await page.locator("#approval-categories .card-list-item > strong").allTextContents();
  assert.ok(kinds.length >= 3, `only ${kinds.length} kinds were drawn; the list moved or did not load`);
  assert.equal(await selects.count(), kinds.length, "one dropdown per kind");
  assert.equal(new Set(kinds).size, kinds.length, "the kinds have different names");
  for (const kind of kinds) {
    const choice = page.getByRole("combobox", { name: kind, exact: true });
    assert.equal(await choice.count(), 1, `no dropdown is named "${kind}"`);
    const described = await choice.evaluate((select) => (select.getAttribute("aria-describedby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(" "));
    assert.match(described, /One choice for every tool of this kind/, `"${kind}" lost its description`);
  }

  /* In French the kinds, and so the dropdowns' names, are French, without reopening the page. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.getByRole("combobox", { name: "Consulter des informations", exact: true }).waitFor({ state: "attached", timeout: 10000 });
  const french = await page.locator("#approval-categories .card-list-item > strong").allTextContents();
  assert.equal(french.length, kinds.length);
  assert.deepEqual(french.filter((name) => kinds.includes(name)), [], "every kind is in French after the switch");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
});

test("every kind of tool has its name and sentence in English as the server says them, and in real French", async () => {
  const { categoryLabels } = await import("../dist/tool-categories.js");
  const locales = join(import.meta.dirname, "..", "public", "locales");
  const en = JSON.parse(await readFile(join(locales, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(locales, "fr.json"), "utf8"));
  for (const [kind, words] of Object.entries(categoryLabels)) {
    for (const part of ["label", "description"]) {
      const key = `toolKinds.kind.${kind}.${part}`;
      assert.equal(en[key], words[part], `${key}: en.json should say what src/tool-categories.ts says`);
      assert.ok(fr[key] && fr[key] !== words[part], `${key} needs real French`);
    }
  }
});

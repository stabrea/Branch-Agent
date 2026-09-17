/**
 * mac6/accounts: the Accounts card in Settings › Models › Connection and the account chip in the
 * title bar, opened the way a person opens them. A headless browser; the connection is a stand-in
 * and the extra key is never used, so nothing reaches a provider.
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
import { openPlace, openSettingFor } from "./places.mjs";

const POOL = "openai-ui";
const KEY = "sk-ui-test-key-000000000";

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-accounts-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, errors, app, owner };
}

async function openCard(page) {
  await page.locator("#accounts-card").waitFor({ state: "attached", timeout: 30000 });
  await openSettingFor(page, "#accounts-card");
  await page.locator("#accounts-mode").waitFor({ state: "visible", timeout: 15000 });
}

test("U1 the card lives in Settings › Models, starts off, and adding a key keeps the key off the page", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openCard(page);
  assert.equal(await page.locator("#accounts-card").getAttribute("data-home"), "settings:models:connection");
  assert.equal(await page.locator("#accounts-mode").inputValue(), "off");
  assert.equal(await page.locator("#accounts-card .accounts-pool").count(), 0, "while off there is no list");
  await page.locator("#accounts-mode").selectOption("on");
  const pool = page.locator(`.accounts-pool[data-pool="${POOL}"]`);
  await pool.waitFor();
  assert.match(await pool.locator(".terms-line").innerText(), /entitled to use/);
  await pool.getByLabel("Name for a new account").fill("Personal");
  await pool.getByLabel("Its API key").fill(KEY);
  await pool.getByRole("button", { name: "Add this account" }).click();
  await pool.locator(".accounts-row", { hasText: "Personal" }).waitFor();
  assert.ok(!(await page.content()).includes(KEY), "the key is not on the page after it was added");
  const row = pool.locator(".accounts-row", { hasText: "Personal" });
  await row.getByRole("button", { name: "Use for new work" }).click();
  await pool.locator(".accounts-row", { hasText: "Personal" }).getByText("(new work uses this one)").waitFor();
  const chip = page.locator("#accounts-chip-select");
  await openPlace(page, "chat");
  await chip.waitFor({ state: "attached" });
  assert.equal(await chip.locator("option:checked").innerText(), "Personal", "the chip names the account in use");
  assert.equal(app.runtime.models.presets.get(POOL).provider.name, "openai-chat");
  assert.deepEqual(errors, []);
});

test("U2 at 400 px nothing scrolls sideways, every word has a key, and French is real French", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openCard(page);
  await page.locator("#accounts-mode").selectOption("on");
  await page.locator(`.accounts-pool[data-pool="${POOL}"]`).waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  const box = await page.locator("#accounts-card").boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 400);
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#accounts-card :is(p, label, option, button, a, span, strong, h2, h3)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t && !node.dataset.tKey && !node.classList.contains("accounts-data") && node.getAttribute("role") !== "status" && !/^[\s·]*$/.test(node.textContent))
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "only account names and the last message (server words) are data");
  const raw = await page.evaluate(() => document.querySelector("#accounts-card").innerText.match(/\{[a-z]+\}/g));
  assert.equal(raw, null, "no {placeholder} is ever shown");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#accounts-card");
  await page.waitForFunction(() => document.querySelector("label[for=accounts-mode]")?.textContent === "Plusieurs comptes par connexion");
  assert.match(await page.locator("#accounts-card .terms-line").first().innerText(), /Conditions/);
  assert.deepEqual(errors, []);
});

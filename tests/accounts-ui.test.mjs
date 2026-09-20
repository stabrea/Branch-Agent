/**
 * mac6/accounts: the Accounts card (Settings › Accounts since redesign phase 2) and the account chip in the
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
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";

const POOL = "openai-ui";
const KEY = "sk-ui-test-key-000000000"; // not-a-real-secret

async function fixture(t, width = 1440, before = () => undefined) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-accounts-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  before(app, owner);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app, owner };
}

async function openCard(page) {
  await page.locator("#accounts-card").waitFor({ state: "attached", timeout: 30000 });
  await openSettingFor(page, "#accounts-card");
  await page.locator("#accounts-mode").waitFor({ state: "visible", timeout: 15000 });
}

test("U1 the card lives in Settings › Accounts, starts off, and adding a key keeps the key off the page", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openCard(page);
  assert.equal(await page.locator("#accounts-card").getAttribute("data-home"), "settings:accounts");
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
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#accounts-card")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the accounts card fits inside 400 px");
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

/* mac7/account-pooling: a list that shared work between the owner's own plans, from before the rule. */
function oldSharedList(app, owner) {
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  const at = "2026-09-19T10:00:00.000Z";
  app.store.save("settings", owner, "accounts", { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli", autoSwitch: true,
    accounts: [{ id: "primary", label: "Mine", createdAt: at }, { id: "abcd1234", label: "Partner plan", createdAt: at }] }] });
  accountsServiceFor(app.runtime.models).applyPoolingRule();
}

test("U3 a sign-in list says once why sharing stopped, and an account can be marked kept separate", async (t) => {
  const { page, errors, app } = await fixture(t, 1440, oldSharedList);
  await openCard(page);
  const pool = page.locator('.accounts-pool[data-pool="cli-claude-code"]');
  await pool.waitFor();
  const notice = pool.locator(".accounts-notice");
  assert.match(await notice.innerText(), /no longer switches between your own .+ plans.*mark it kept separate/s);
  await notice.getByRole("button", { name: "Got it" }).click();
  await notice.waitFor({ state: "detached" });
  const row = pool.locator(".accounts-row", { hasText: "Partner plan" });
  await row.getByLabel(/Kept separate/).check();
  await pool.locator(".accounts-row", { hasText: "Partner plan" }).getByText("(kept separate)").waitFor();
  const saved = accountsServiceFor(app.runtime.models).settings();
  assert.equal(saved.pools[0].accounts.find((account) => account.id === "abcd1234").keptSeparate, true);
  assert.deepEqual(saved.poolingNotices, [], "the notice is read once");
  assert.match(await pool.innerText(), /It never moves between your own plans/, "the words beside the tick box say the rule");
  assert.equal(await pool.getByLabel(/Kept separate/).count(), 2, "every sign-in has the box");
  assert.deepEqual(errors, []);
});

test("U4 the notice and the Kept separate box fit at 400 px, carry keys, and read in French", async (t) => {
  const { page, errors } = await fixture(t, 400, oldSharedList);
  await openCard(page);
  const pool = page.locator('.accounts-pool[data-pool="cli-claude-code"]');
  await pool.locator(".accounts-notice").waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false, "nothing scrolls sideways");
  const keyed = await page.evaluate(() => [...document.querySelectorAll('.accounts-pool[data-pool="cli-claude-code"] :is(.accounts-notice p, .accounts-notice button, label span)')]
    .every((node) => node.dataset.t || node.dataset.tKey));
  assert.ok(keyed, "the notice, its button and the box's words come from keys");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#accounts-card");
  await page.waitForFunction(() => /Tenu à part/.test(document.querySelector('.accounts-pool[data-pool="cli-claude-code"]')?.innerText ?? ""));
  const text = await pool.innerText();
  assert.match(text, /Branch ne passe plus d'un de vos abonnements .+ à un autre/);
  assert.match(text, /Compris/);
  assert.match(text, /Tenu à part : ce compte appartient/);
  assert.equal(text.match(/\{[a-z]+\}/g), null, "no {placeholder} is ever shown");
  assert.equal(await pool.getByLabel(/Tenu à part/).count(), 2, "the box survives the language change");
  const stillNarrow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(stillNarrow, false, "the longer French words still fit");
  assert.deepEqual(errors, []);
});

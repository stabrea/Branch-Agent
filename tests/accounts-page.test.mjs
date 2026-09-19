/**
 * Redesign phase 2 (accounts, critiques #21, #60, #61): Settings › Accounts, the marks on Secrets and
 * on the chat apps. Opened the way a person opens them, headless; the connections are stand-ins and
 * no key is ever used, so nothing reaches a provider.
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
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { openPlace, openSettings } from "./places.mjs";

const answer = async () => ({ content: "ok", toolCalls: [] });

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "accounts-page-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [
    { id: "openai-work", name: "OpenAI", catalogId: "openai", model: "gpt-5.5", extras: {} },
    { id: "anthropic-home", name: "Anthropic", catalogId: "anthropic", model: "claude-sonnet-4-5", extras: {} },
  ] });
  app.runtime.models.register({ id: "openai-work", name: "OpenAI", model: "gpt-5.5", catalogId: "openai", provider: { name: "openai-compatible", complete: answer } });
  app.runtime.models.register({ id: "anthropic-home", name: "Anthropic", model: "claude-sonnet-4-5", catalogId: "anthropic", provider: { name: "anthropic", complete: answer } });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  app.runtime.models.configure(owner, { activePreset: "openai-work", fallbackOrder: ["anthropic-home"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
  };
  return { app, call, page, errors, open };
}
async function withAccounts(call) {
  await call("/api/accounts/settings", { mode: "on" });
  for (let i = 1; i <= 6; i++) await call("/api/accounts/add", { pool: "openai-work", label: `Key ${i}`, key: `sk-sample-00000000000${i}` });
  const added = (await call("/api/accounts/add", { pool: "cli-claude-code", label: "Work plan" })).body;
  return added.accounts.find((account) => account.label === "Work plan");
}

test("A1 Accounts is its own page after Models, with each service's mark and a search for long lists", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await page.locator("#accounts-card .accounts-pool").first().waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  const links = await page.locator(".lx-settings-link").evaluateAll((nodes) => nodes.map((node) => node.dataset.page));
  assert.equal(links[links.indexOf("models") + 1], "accounts");
  assert.equal(await page.locator('.accounts-pool[data-pool="openai-work"] .accounts-pool-head .brand-mark').getAttribute("data-mark"), "openai");
  assert.equal(await page.locator('.accounts-pool[data-pool="cli-claude-code"] .accounts-pool-head .brand-mark').getAttribute("data-mark"), "claude");
  assert.match(await page.locator(".accounts-honest").innerText(), /never spreads one person's use/);
  const search = page.getByLabel("Search accounts");
  await search.fill("work plan");
  assert.equal(await page.locator('.accounts-pool[data-pool="openai-work"]').isHidden(), true, "a list with no match folds away");
  assert.equal(await page.locator(".accounts-row", { hasText: "Work plan" }).isVisible(), true);
  await search.fill("");
  assert.equal(await page.locator(".accounts-row").count() >= 8, true);
  // Integration review: a terms line with several links names each one, never "Read the terms" twice.
  const termLinks = await page.locator('.accounts-pool[data-pool="openai-work"] .terms-line a').allInnerTexts();
  assert.deepEqual(termLinks, ["OpenAI terms ↗", "Google API terms ↗", "Anthropic terms ↗"]);
  assert.deepEqual(errors, []);
});

test("A2 a Trunk's key is picked from API keys only, saved on the Trunk, and put back to the default", async (t) => {
  const { app, call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await call("/api/trunks", { name: "Scout" })).body.trunk;
  await open();
  await page.locator("#accounts-trunks-card .accounts-trunk").waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  const row = page.locator(`#accounts-trunks-card .accounts-trunk[data-trunk="${trunk.id}"]`);
  assert.deepEqual(await row.locator("label").allInnerTexts(), ["Key for OpenAI", "Key for Anthropic"], "API key connections only; a sign-in never is");
  const pick = row.getByLabel("Key for OpenAI");
  const key3 = (await call("/api/accounts")).body.pools.find((pool) => pool.pool === "openai-work").accounts.find((account) => account.label === "Key 3");
  await pick.selectOption(key3.id);
  await page.waitForFunction(() => /Saved\. The Trunk uses it/.test(document.querySelector("#accounts-card [role=status]")?.textContent ?? ""));
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["openai-work"], key3.id);
  await page.locator(`#accounts-trunks-card .accounts-trunk[data-trunk="${trunk.id}"]`).getByLabel("Key for OpenAI").selectOption("");
  await page.waitForFunction((id) => document.querySelector(`.accounts-trunk[data-trunk="${id}"] select`)?.value === "", trunk.id);
  await page.waitForTimeout(300);
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["openai-work"], undefined, "the default key again");
  assert.deepEqual(errors, []);
});

test("A3 when one runs low: the fallback order with marks, and the way to change it", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await page.locator("#accounts-low-card .accounts-fallback li").first().waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  const item = page.locator("#accounts-low-card .accounts-fallback li").first();
  assert.match(await item.innerText(), /Anthropic · claude-sonnet-4-5/);
  assert.equal(await item.locator(".brand-mark").getAttribute("data-mark"), "anthropic");
  await page.locator("#accounts-low-card").getByRole("button", { name: "Change the fallback order" }).click();
  await page.locator("#lx-page-models").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("A4 at 390 px the page fits, and a sign-in's kept-separate box stays in sight", async (t) => {
  const { call, page, errors, open } = await fixture(t, 390);
  await withAccounts(call);
  await open();
  await page.locator("#accounts-card .accounts-pool").first().waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  await page.locator('.accounts-pool[data-pool="cli-claude-code"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('.accounts-pool[data-pool="cli-claude-code"]').getByLabel(/Kept separate/).first().isVisible(), true);
  const wide = await page.evaluate(() => [document.documentElement, document.querySelector("#lx-settings-body")].some((node) => node && node.scrollWidth > node.clientWidth + 1));
  assert.equal(wide, false, "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

test("A5 Secrets and chat apps show marks and plain names, and a service that asks first gets a neutral tile", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  for (const name of ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SUPPLIER_API_KEY"]) await call("/api/secrets", { project: "default", name, value: "sample-value-123" });
  await open();
  await openSettings(page, "secrets");
  const openai = page.locator("#secrets-list .secret-row", { hasText: "OPENAI_API_KEY" });
  await openai.waitFor({ timeout: 20000 });
  assert.equal(await openai.locator("strong").innerText(), "OpenAI key");
  assert.match(await openai.innerText(), /Commands use it as OPENAI_API_KEY/);
  assert.equal(await openai.locator(".brand-mark").getAttribute("data-mark"), "openai");
  const slack = page.locator("#secrets-list .secret-row", { hasText: "SLACK_BOT_TOKEN" });
  assert.equal(await slack.locator(".brand-mark").getAttribute("data-mark"), null, "Slack asks for permission first");
  assert.equal(await slack.locator(".brand-mark").getAttribute("data-neutral"), "chat");
  assert.equal(await page.locator("#secrets-list .secret-row", { hasText: "SUPPLIER_API_KEY" }).locator("strong").innerText(), "Supplier API key");
  await openPlace(page, "customize:channels");
  await page.locator("#chat-services-list summary .brand-mark").first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#chat-services-list summary", { hasText: "Mattermost" }).locator(".brand-mark").getAttribute("data-mark"), "mattermost");
  assert.equal(await page.locator("#chat-services-list summary", { hasText: "Microsoft Teams" }).locator(".brand-mark").getAttribute("data-neutral"), "chat");
  assert.deepEqual(errors, []);
});

// Integration review: someone on a household profile with nothing shared is shown none of the owner's
// cards (the fallback order, the Trunks' keys) and no switch they cannot change, and nothing asks for them.
test("A6 a household person with nothing shared sees no owner cards and no switch they cannot change", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await call("/api/accounts/settings", { mode: "on" }); // no list saved, so nothing can be shared with Sam
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await call("/api/trunks", { name: "Scout" });
  const sam = (await call("/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  await open();
  await page.locator("#accounts-card .accounts-honest").waitFor({ state: "attached", timeout: 30000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#accounts-card .accounts-pool").count(), 0, "nothing is shared with Sam");
  assert.equal(await page.locator("#accounts-mode").count(), 0, "the switch is the owner's");
  // drawTrunks makes its card whatever the answer, so no card means the page never asked for the Trunks.
  assert.equal(await page.locator("#accounts-low-card, #accounts-trunks-card").count(), 0);
  assert.deepEqual(errors, []);
});

/**
 * Dogfood B25 (Legion 2f2da94): the model chip showed the model's id ("gpt-6-sol"). It shows the catalogue's own name
 * ("GPT-6 Sol") where Branch has one, before and during a conversation, and the id for a model it has no name for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { modelDisplayName } from "../dist/models.js";

test("the catalogue names a ChatGPT model and nothing else", () => {
  assert.equal(modelDisplayName("chatgpt", "gpt-6-sol"), "GPT-6 Sol");
  assert.equal(modelDisplayName("chatgpt", "gpt-9-unknown"), null, "a model the list does not have keeps its id");
  assert.equal(modelDisplayName("openai-compatible", "gpt-6-sol"), null, "another route's model is not guessed at");
});

test("dogfood B25: the chip names GPT-6 Sol by its name, before and during a conversation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chip-name-"));
  const answer = async () => ({ content: "ok", toolCalls: [] });
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    presets: [{ id: "main", name: "ChatGPT · GPT-6 Sol", provider: { name: "chatgpt", complete: answer }, model: "gpt-6-sol", reasoning: "medium" }] });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const chip = () => page.locator("#lx-model-chip").innerText().then((text) => text.trim());
  await page.waitForFunction(() => /^GPT-6 Sol/.test(document.getElementById("lx-model-chip")?.innerText.trim() ?? ""));
  assert.equal(await chip(), "GPT-6 Sol · Balanced", "before a first message");
  await page.locator("#prompt").fill("hello");
  await page.locator("#prompt").press("Enter");
  await page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.getElementById("model-controls")?.hidden === false);
  assert.equal(await chip(), "GPT-6 Sol · Balanced", "and in the conversation");
  assert.deepEqual(errors, []);
});

// Dogfood B26 (Legion 2f2da94): before a first message the menu's Thinking applies to the conversation that message
// starts, held in the page and sent with it; it is not the workspace's default.
test("dogfood B26: Thinking picked before the first message is the new conversation's own level", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chip-think-"));
  const answer = async () => ({ content: "ok", toolCalls: [] });
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    presets: [{ id: "main", name: "ChatGPT · GPT-6 Sol", provider: { name: "chatgpt", complete: answer }, model: "gpt-6-sol", reasoning: "medium" }] });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const chip = () => page.locator("#lx-model-chip").innerText().then((text) => text.trim());
  await page.waitForFunction(() => /^GPT-6 Sol · Balanced$/.test(document.getElementById("lx-model-chip")?.innerText.trim() ?? ""));
  await page.locator("#lx-model-chip").click();
  const menu = page.locator("#lx-model-menu");
  await menu.waitFor({ state: "visible" });
  assert.ok(await menu.getByText("Thinking", { exact: true }).isVisible(), "the menu has a Thinking part before a first message");
  const rows = await menu.locator('[role="menuitemradio"]').allInnerTexts();
  for (const words of ["The usual (Balanced)", "Quick", "Balanced", "Thorough"]) assert.ok(rows.map((one) => one.trim()).includes(words), `${words} is offered`);
  await menu.getByRole("menuitemradio", { name: "Thorough", exact: true }).click();
  assert.equal(await chip(), "GPT-6 Sol · Thorough", "the chip names the level picked");
  assert.equal(app.runtime.models.settings(app.runtime.owner).reasoning ?? null, null, "the workspace's own default is untouched");
  await page.locator("#prompt").fill("hello");
  await page.locator("#prompt").press("Enter");
  await page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  const sessionId = await page.locator("#conversation").getAttribute("data-session-id");
  assert.equal(app.runtime.models.session(app.runtime.owner, sessionId).reasoning, "high", "the conversation keeps Thorough as its own");
  await page.waitForFunction(() => /· Thorough$/.test(document.getElementById("lx-model-chip")?.innerText.trim() ?? ""));
  // New conversation, once this one has settled (the button does nothing while a reply is still being finished).
  await page.waitForFunction(() => document.getElementById("new-session")?.disabled === false);
  await page.evaluate(() => document.getElementById("new-session").click());
  await page.waitForFunction(() => /· Balanced$/.test(document.getElementById("lx-model-chip")?.innerText.trim() ?? ""), undefined, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

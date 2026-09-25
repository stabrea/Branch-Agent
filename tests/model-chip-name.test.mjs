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

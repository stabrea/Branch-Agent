/**
 * DG-025: Settings › Models saves each choice as it is made, as the approved sample does, and has no Save button:
 * the default model, the default thinking, the models tried next and the rest time each save on change, once.
 * A refused save is said, and the saved value stays what it was. The model connection card, a genuine form of
 * several fields, keeps its own Save.
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

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-save-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const answer = async () => ({ content: "ok", toolCalls: [] });
  for (const [id, name, provider, model] of [["save-gpt", "OpenAI", "openai-compatible", "gpt-5.5"],
    ["save-claude", "Anthropic", "anthropic", "claude-sonnet-4-5"], ["save-local", "Ollama", "ollama", "llama3.1:8b"]])
    app.runtime.models.register({ id, name, model, provider: { name: provider, complete: answer } });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "save-local" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const saves = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/models") saves.push(request.postDataJSON()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="models"]').click();
  await page.locator("#lx-models-connection").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await page.locator('#models-active option[value="save-gpt"]').waitFor({ state: "attached", timeout: 30000 });
  const saved = () => app.runtime.models.settings(app.runtime.owner);
  const until = async (check, what) => {
    for (let i = 0; i < 100 && !check(saved()); i++) await page.waitForTimeout(100);
    assert.ok(check(saved()), `${what}: ${JSON.stringify(saved())}`);
  };
  return { page, errors, saves, saved, until };
}

test("DG-025: Models has no Save button, and each choice is saved as it is made, once", async (t) => {
  const { page, errors, saves, until } = await fixture(t);
  const buttons = await page.locator("#models-form button").allInnerTexts();
  assert.ok(!buttons.some((words) => /save/i.test(words)), `no Save button: ${buttons.join(" · ")}`);
  assert.equal(await page.locator("#model-settings-form button", { hasText: "Save model connection" }).count(), 1, "the connection form keeps its Save");

  await page.locator("#models-active").selectOption("save-gpt");
  await until((now) => now.activePreset === "save-gpt", "the default model is saved on change");
  await page.waitForTimeout(400);
  assert.equal(saves.length, 1, "one change is one save");

  await page.locator("#models-reasoning").selectOption("medium");
  await until((now) => now.reasoning === "medium", "the default thinking is saved on change");

  await page.locator('#models-fallback input[value="save-claude"]').check();
  await until((now) => now.fallbackOrder.join() === "save-claude", "a model to try next is saved when ticked");

  await page.locator("#models-cooldown").fill("45");
  await page.locator("#models-cooldown").press("Tab");
  await until((now) => now.cooldownMs === 45000, "the rest time is saved when it is left");
  assert.equal(await page.locator("#models-active").inputValue(), "save-gpt", "the page still shows the saved default");
  assert.deepEqual(errors, []);
});

test("DG-025: a refused save is said, and the saved default stays", async (t) => {
  const { page, errors, saved } = await fixture(t);
  await page.route("**/api/models", (route) => (route.request().method() === "POST"
    ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Models could not be saved (test)." }) })
    : route.continue()));
  await page.locator("#models-active").selectOption("save-claude");
  await page.locator("#toast", { hasText: "Models could not be saved (test)." }).waitFor({ state: "visible" });
  assert.equal(saved().activePreset, "save-local", "nothing was saved");
  assert.deepEqual(errors, []);
});

test("DG-025: a change made while the page is still redrawing after the last save is the one saved", async (t) => {
  const { page, errors, until } = await fixture(t);
  /* The redraw after a save reads the state; hold that back so the next change lands while it is on its way. */
  await page.route("**/api/state", async (route) => { await new Promise((done) => setTimeout(done, 1500)); await route.continue(); });
  await page.locator("#models-active").selectOption("save-gpt");
  await page.locator("#models-cooldown").fill("45");
  await page.locator("#models-cooldown").press("Tab");
  await until((now) => now.activePreset === "save-gpt" && now.cooldownMs === 45000, "both changes are kept");
  await page.waitForTimeout(4000);
  await until((now) => now.activePreset === "save-gpt" && now.cooldownMs === 45000, "and stay kept once the redraws are done");
  assert.deepEqual(errors, []);
});

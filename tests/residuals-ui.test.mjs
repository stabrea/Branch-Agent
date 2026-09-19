/**
 * mac7/residuals: the window's side of the leftovers (docs/agents/STATUS-residuals.md), headless
 * against the local server. Each test fails with its fix taken out.
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
import { openSettings } from "./places.mjs";

async function fixture(t, { viewport = { width: 1440, height: 1000 }, before } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page, app);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  return { app, server, page, errors, browser };
}

test("5. the fallback list warns when a Codex program is in it next to a ChatGPT sign-in", async (t) => {
  const presets = [
    { id: "chatgpt-main", name: "ChatGPT", provider: "chatgpt", model: "gpt-5", reasoning: null, thinking: [], local: false, coolingDownUntil: null },
    { id: "cli-codex", name: "Codex (installed on this computer)", provider: "cli-agent:codex", model: "codex", reasoning: null, thinking: [], local: false, coolingDownUntil: null },
  ];
  // The window reads the models from /api/state; two stand-in connections are added to what it says.
  const { page } = await fixture(t, { before: (page) => page.route(/\/api\/state$/, async (route) => {
    const response = await route.fetch();
    const real = await response.json().catch(() => null);
    if (!real?.models) return route.fulfill({ response });
    const models = { ...real.models, presets: [...real.models.presets, ...presets], fallbackOrder: ["cli-codex"] };
    await route.fulfill({ json: { ...real, models } });
  }) });
  await openSettings(page, "models");
  await page.locator("#lx-page-models .lx-subtab[data-sub=\"connection\"]").click();
  const note = page.locator("#models-fallback-codex");
  await page.locator("#models-fallback input[value=\"cli-codex\"]").waitFor({ state: "attached", timeout: 30000 });
  await note.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await note.innerText(), /different ChatGPT plan of yours/);
  await page.locator("#models-fallback input[value=\"cli-codex\"]").uncheck();
  await note.waitFor({ state: "hidden", timeout: 10000 });
  await page.locator("#models-fallback input[value=\"cli-codex\"]").check();
  await note.waitFor({ state: "visible", timeout: 10000 });
});

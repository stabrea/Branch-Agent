import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* mac4/bucket-20: the two cards, opened the way a person opens them, at 400 px wide. */
test("the switches live in Customize → Connections, modes in Specialists, and both fit 400 px", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-interop-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
  });
  const sessionId = app.store.createSession(app.runtime.owner);
  app.store.message(sessionId, { role: "user", content: "action.save" });
  app.interop.setMode("handoff", { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });

  await openPlace(page, "customize:connections");
  const card = page.locator("#lx-slot-customize-connections #interop-card");
  await card.waitFor();
  assert.equal(await card.locator("h2").innerText(), "Working with other agents and tools");
  assert.equal(await page.locator(`#interop-handoff-session option[value="${sessionId}"]`).innerText(), "action.save",
    "a conversation opening is literal owner text, not a locale key");
  assert.equal(await page.locator("#interop-switch-modes").inputValue(), "off");
  await page.getByLabel("Ways of working (modes)").selectOption("when-needed");
  await page.locator("#lx-slot-customize-connections #interop-card").getByText("Saved.").waitFor().catch(() => undefined);
  for (let i = 0; i < 50 && app.interop.modesOf().modes !== "when-needed"; i++) await page.waitForTimeout(50);
  assert.equal(app.interop.modesOf().modes, "when-needed");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(wide, false, "no sideways scrolling at 400 px");

  await openPlace(page, "settings:skills");
  const modes = page.locator("#lx-page-skills #interop-modes-card");
  await modes.waitFor();
  await modes.getByText("Architect (architect)", { exact: false }).waitFor();
  await page.locator("#interop-mode-slug").fill("reviewer");
  await page.locator("#interop-mode-name").fill("Reviewer");
  await page.locator("#interop-mode-role").fill("You review and change nothing.");
  await page.locator("#lx-page-skills #interop-modes-card").getByRole("button", { name: "Add this mode" }).click();
  await page.locator("#lx-page-skills #interop-modes-card").getByText("Reviewer (reviewer)", { exact: false }).waitFor();
  assert.equal(app.interop.modes.find("reviewer").origin, "yours");
  const wideToo = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(wideToo, false);
});

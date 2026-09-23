import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { loopGuardMode } from "../dist/loop-guard.js";
import { openPlace, openSettingFor, openSettings } from "./places.mjs";

/* Q48/Q49 in the window, at phone width: the recent changes card lists a preset's change, refuses an
   undo that loosens without its own yes, undoes it with that yes, and says why a setting is set. */

test("Q48/Q49 recent changes: undo needs the separate yes to loosen, and why names the preset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-history-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  const deps = { store: app.store, owner, workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (path, body) => settingsKitApi(deps, "POST", path, async () => body);
  const plan = { source: "preset", preset: "careful" };
  const { changes } = await ask("/api/settings-kit/preview", plan);
  await ask("/api/settings-kit/apply", { plan, accept: changes.map((change) => change.id), confirmLoosening: false });
  const guardBefore = changes.find((change) => change.id === "loop_guard.mode")?.from;
  assert.ok(guardBefore !== undefined, "the careful preset no longer changes loop_guard.mode");
  assert.equal(loopGuardMode(app.store, owner), "on");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#settings-kit-history").waitFor({ state: "attached", timeout: 60000 });
  await openSettings(page, "general");

  const card = page.locator("#settings-kit-history");
  await card.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "the page scrolls sideways at 400 px");
  const record = card.locator(".kit-record").first();
  await record.waitFor();
  assert.match(await record.innerText(), /a preset/);

  await card.getByLabel("Setting", { exact: true }).selectOption("loop_guard.mode");
  await card.getByRole("button", { name: "Why is it set like this?" }).click();
  await card.locator("p[role=status]", { hasText: "set by a preset" }).first().waitFor();

  await record.getByRole("button", { name: "Undo this change" }).click();
  await card.locator("[role=status]", { hasText: "less careful" }).waitFor();
  assert.equal(loopGuardMode(app.store, owner), "on", "a refused undo changed something");

  await card.getByLabel("Yes, make it less careful").check();
  await record.getByRole("button", { name: "Undo this change" }).click();
  await card.locator(".kit-record", { hasText: "Undone." }).waitFor();
  assert.equal(loopGuardMode(app.store, owner), guardBefore);
  assert.deepEqual(errors, []);
});

test("Q48/Q49 in French: the why answer names the preset in French, not by its English name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-history-fr-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const deps = { store: app.store, owner: app.runtime.owner, workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (path, body) => settingsKitApi(deps, "POST", path, async () => body);
  const plan = { source: "preset", preset: "careful" };
  const { changes } = await ask("/api/settings-kit/preview", plan);
  await ask("/api/settings-kit/apply", { plan, accept: changes.map((change) => change.id), confirmLoosening: false });

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#settings-kit-history").waitFor({ state: "attached", timeout: 60000 });
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#settings-kit-history");

  const card = page.locator("#settings-kit-history");
  await card.locator("#kit-why").selectOption("loop_guard.mode");
  await card.getByRole("button", { name: "Pourquoi est-il réglé ainsi ?" }).click();
  const answer = card.locator("p[role=status]", { hasText: "un préréglage" }).first();
  await answer.waitFor();
  const words = await answer.innerText();
  assert.match(words, /un préréglage \(Prudent\)/);
  assert.doesNotMatch(words, /Careful/);
  assert.deepEqual(errors, []);
});

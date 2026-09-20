/**
 * The shared commands in the app window and on the dashboard, used the way a person uses them:
 * typing "/" in the message box, the card in Settings › General, and the dashboard's command line.
 * Headless browser only; no window opens.
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
import { saveCommandSettings, commandSettings } from "../dist/commands/settings.js";
import { saveDashboardSettings } from "../dist/dashboard-api.js";
import { lockdownState } from "../dist/lockdown.js";
import { openPlace } from "./places.mjs";

async function fixture(t, viewport = { width: 1280, height: 900 }, mode = "on") {
  const root = await mkdtemp(join(tmpdir(), "branch-commands-ui-"));
  const provider = { name: "commands-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  if (mode) saveCommandSettings(app.store, app.runtime.owner, { mode });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { app, server, page, errors };
}
const submit = (page) => page.locator("#chat-form").evaluate((form) => form.requestSubmit());

test("typing / lists the window's commands, and Tab fills one in", async (t) => {
  const { page, errors } = await fixture(t);
  await openPlace(page, "chat");
  await page.locator("#prompt").fill("/to");
  const menu = page.locator("#slash-menu");
  await menu.waitFor({ state: "visible" });
  assert.match(await menu.textContent(), /\/tokens/);
  assert.doesNotMatch(await menu.textContent(), /\/switch|\/exit/, "terminal-only commands are not offered here");
  await page.locator("#prompt").press("Tab");
  assert.equal(await page.locator("#prompt").inputValue(), "/tokens ");
  assert.equal(await menu.count(), 0);
  assert.deepEqual(errors, []);
});

test("a command runs without reaching the model, and a place command opens the place", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "chat");
  await page.locator("#prompt").fill("/status");
  await submit(page);
  await page.locator("#toast").filter({ hasText: "When to check with you" }).waitFor();
  assert.equal(await page.locator("#conversation .message").count(), 0, "nothing was sent to the model");
  await page.locator("#prompt").fill("/go library memory");
  await submit(page);
  await page.locator("#library").waitFor({ state: "visible" });
  await openPlace(page, "chat");
  await page.locator("#prompt").fill("/lockdown on");
  await submit(page);
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("Lockdown is on"));
  assert.equal(lockdownState(app.store, app.runtime.owner).on, true);
  assert.deepEqual(errors, []);
});

test("with the switch off there is no menu, and /help lists the two commands the window always had", async (t) => {
  const { page, errors } = await fixture(t, undefined, null);
  await openPlace(page, "chat");
  await page.locator("#prompt").fill("/");
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#slash-menu").count(), 0);
  await page.locator("#prompt").fill("/help");
  await submit(page);
  await page.waitForFunction(() => document.getElementById("toast").textContent.includes("Commands you can type here"));
  const lines = (await page.locator("#toast").textContent()).split("\n").slice(1).map((line) => line.split(" ")[0]);
  assert.deepEqual(lines, ["/help", "/model", "/goal"], "goal mode (public/goal.js) brought /goal to the window before this table");
  assert.deepEqual(errors, []);
});

test("the commands card is in Settings › General, saves the switch, and fits 400 pixels", async (t) => {
  const { app, page, errors } = await fixture(t, { width: 400, height: 900 }, null);
  await openPlace(page, "settings:general");
  const card = page.locator("#commands-card");
  await card.waitFor({ state: "visible" });
  assert.equal(await page.locator("#commands-mode").inputValue(), "off");
  await page.locator("#commands-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await card.getByText("Saved.", { exact: true }).waitFor();
  assert.equal(commandSettings(app.store, app.runtime.owner).mode, "when-needed");
  await card.locator("summary").click();
  // Waited for, not read once: the summary click redraws the card, so the line can still be the old one.
  const where = await card.locator(".commands-where").filter({ hasText: /\/tokens window, phone, terminal, chat apps/ })
    .waitFor({ timeout: 5000 }).then(() => true, () => false);
  assert.ok(where, "the card says where typed commands work");
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#commands-card")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the commands card fits inside 400 px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
});

test("the commands card is written in French when French is chosen", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await openPlace(page, "settings:general");
  await page.locator("#commands-card h2").filter({ hasText: "Commandes tapées" }).waitFor();
  assert.deepEqual(errors, []);
});

test("the dashboard's command line answers, and a key that may only look can still ask", async (t) => {
  const { app, server, page, errors } = await fixture(t);
  saveDashboardSettings(app.store, app.runtime.owner, { mode: "when-needed" });
  await page.goto(server.url + "/dashboard");
  const input = page.locator("#db-command");
  await input.waitFor({ state: "visible" });
  await input.fill("/status");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("#db-command-answer").filter({ hasText: "Nothing is working right now" }).waitFor();
  const read = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read" }).token;
  await page.evaluate((key) => sessionStorage.setItem("branch-token", key), read);
  await page.reload();
  await input.waitFor({ state: "visible" });
  await input.fill("/whoami");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator("#db-command-answer").filter({ hasText: "may only look" }).waitFor();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(sideways, false);
  assert.deepEqual(errors, []);
});

test("the phone app's window asks for the phone's list", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => sessionStorage.setItem("branch-phone", JSON.stringify({ at: Date.now() })));
  const asked = page.waitForRequest((request) => request.url().includes("/api/commands?surface=phone"));
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 }).catch(() => undefined);
  await asked;
  assert.equal(await page.evaluate(() => globalThis.branchSlashCommands.surface()), "phone");
  assert.deepEqual(errors, []);
});

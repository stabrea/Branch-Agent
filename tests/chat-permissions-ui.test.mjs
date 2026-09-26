/**
 * mac7/chat-allowlist: the card for what a chat may do beyond talking, reached the way a person
 * reaches it — Customize, then Chat apps. It starts off, saves a line, fits a 400-pixel window and
 * reads in French. Headless browser only; no window opens.
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
import { openPlace } from "./places.mjs";

async function fixture(t, viewport) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-permissions-ui-"));
  const provider = { name: "chat-permissions-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("the card is under Customize, Chat apps, starts off, and saves one line", async (t) => {
  const { app, page, errors } = await fixture(t, { width: 1280, height: 900 });
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  const card = page.locator("#chat-permissions-form");
  await card.waitFor({ state: "visible" });
  assert.deepEqual(app.channels.permissionSettings(), { extras: false, rules: [] }, "a fresh install allows nothing more");
  await page.getByText("No lines yet: every chat may only read and answer.").waitFor();
  await page.getByLabel("Use my list of what chats may also do", { exact: true }).check();
  await page.getByLabel("Which chat app", { exact: true }).fill("telegram");
  await page.getByLabel("Which person", { exact: true }).fill("4242");
  await page.getByLabel("What they may also do", { exact: true }).fill("files.write, shell.execute");
  await page.getByLabel("Who this is", { exact: true }).fill("my own phone");
  await card.getByRole("button", { name: "Save what chats may do", exact: true }).click();
  await page.locator("#chat-permissions-state", { hasText: "Saved." }).waitFor();
  const saved = app.channels.permissionSettings();
  assert.equal(saved.extras, true);
  // mac7/chat-approvals: the box for saying yes from the chat was not ticked, so the line is saved
  // with it off — which is what a line written without a thought for it has to mean.
  assert.deepEqual(saved.rules, [{ channel: "telegram", sender: "4242", allow: ["files.write", "shell.execute"],
    note: "my own phone", approvals: false }]);
  assert.deepEqual(errors, []);
});

test("mac7/chat-approvals: the box for saying yes from the chat starts clear, says what it costs, and saves", async (t) => {
  const { app, page, errors } = await fixture(t, { width: 1280, height: 900 });
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  const card = page.locator("#chat-permissions-form");
  await card.waitFor({ state: "visible" });
  const box = page.getByLabel("They may also say yes in the chat to what this line allows", { exact: true });
  assert.equal(await box.isChecked(), false, "the box starts ticked");

  /* The card says in its own words what turning it on gives away, without being asked to. */
  const warning = await page.locator("#chat-permissions-approvals-note").innerText();
  assert.match(warning, /cannot prove who is typing/i, "the card does not say a chat cannot prove who is typing");
  assert.match(warning, /gets into that chat account/i, "the card does not say who else could then approve");
  assert.match(warning, /pass themselves off/i, "the card does not say the account can be spoofed");

  await page.getByLabel("Use my list of what chats may also do", { exact: true }).check();
  await page.getByLabel("Which chat app", { exact: true }).fill("telegram");
  await page.getByLabel("Which person", { exact: true }).fill("4242");
  await page.getByLabel("What they may also do", { exact: true }).fill("files.write");
  await box.check();
  await page.getByLabel("Who this is", { exact: true }).fill("my own phone");
  await card.getByRole("button", { name: "Save what chats may do", exact: true }).click();
  await page.locator("#chat-permissions-state", { hasText: "Saved." }).waitFor();
  assert.deepEqual(app.channels.permissionSettings().rules,
    [{ channel: "telegram", sender: "4242", allow: ["files.write"], note: "my own phone", approvals: true }]);

  /* The saved line says so where the owner reads the list, and the box clears for the next line. */
  await page.locator("#chat-permissions-list", { hasText: "may say yes in the chat" }).waitFor();
  assert.equal(await box.isChecked(), false, "the box stayed ticked for whatever line is written next");
  assert.deepEqual(errors, []);
});

test("the card fits a 400-pixel window and reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  const card = page.locator("#chat-permissions-form");
  await card.waitFor({ state: "visible" });
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#chat-permissions-form")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the chat-permissions card fits inside 400 px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#chat-permissions-form :is(p, label, button, span, h2)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t && node.id !== "chat-permissions-state")
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "every word on the card has a key");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  await page.waitForFunction(() =>
    document.querySelector("label[for=chat-permissions-channel]")?.textContent === "Quelle application");
  assert.match(await card.locator("h2").innerText(), /au-delà de parler/);
  assert.deepEqual(errors, []);
});

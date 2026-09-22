/**
 * OWNER-LIST 7, part two: after the first choice, "Two more things, if you like" — email and calendar
 * with the owner's own sign-in, or a backup brought back — both optional and shown in the calm window.
 * First run's own trouble line offers, in order, try again and another way, with the
 * raw words behind Details; the ChatGPT code shows one character to a box and copies in one press.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { finishFirstRun } from "./places.mjs";

const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t, { width = 400 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-first-run-steps-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, root };
}
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("after the first choice, two optional steps show in the calm window and are offered once", async (t) => {
  const { page, errors } = await fixture(t);
  await finishFirstRun(page);
  const card = page.locator("#first-run-steps");
  await card.getByRole("heading", { name: "Two more things, if you like" }).waitFor();
  assert.equal(await page.locator("#first-run-next").isVisible(), false, "the calm window keeps the fuller card out of sight");
  assert.ok(await card.isVisible(), "but these two steps are shown");
  await card.getByRole("heading", { name: "Your email and calendar" }).waitFor();
  await card.getByRole("button", { name: "Set it up" }).waitFor();
  await card.getByRole("heading", { name: "Bring back your Branch" }).waitFor();
  assert.ok(await noSidewaysScroll(page), "nothing scrolls sideways at 400 px");
  await card.getByRole("button", { name: "Done" }).click();
  assert.equal(await card.count(), 0);
  await page.evaluate(() => globalThis.branchFirstRunDone());
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#first-run-steps").count(), 0, "it is offered once");
  assert.deepEqual(errors, []);
});

test("Set it up opens the owner's own accounts, where email and calendar are signed in", async (t) => {
  const { page } = await fixture(t, { width: 1280 });
  await finishFirstRun(page);
  const before = await page.locator("#personal-accounts-card").isVisible().catch(() => false);
  assert.equal(before, false, "the accounts card is not already on screen");
  await page.locator("#first-run-steps").getByRole("button", { name: "Set it up" }).click();
  await page.locator("#personal-accounts-card").waitFor({ state: "visible", timeout: 30000 });
});

test("a backup comes back into a Branch with no conversations, and is refused plainly where there are some", async (t) => {
  const source = await fixture(t);
  const session = source.app.store.createSession(source.app.runtime.owner);
  const file = join(source.root, "branch-backup.json");
  await writeFile(file, JSON.stringify(source.app.store.backup("test")));
  const junk = join(source.root, "not-a-backup.json");
  await writeFile(junk, "{ nope");

  const { app, page, errors } = await fixture(t);
  await finishFirstRun(page);
  const card = page.locator("#first-run-steps");
  await card.getByRole("heading", { name: "Bring back your Branch" }).waitFor();
  const sent = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/restore")) sent.push(request.url()); });
  await page.setInputFiles("#first-run-restore-file", file);
  await card.getByText("Bring back branch-backup.json? This replaces the settings and data already in this Branch with the ones in the file.").waitFor();
  await card.getByRole("button", { name: "Cancel" }).click();
  await card.locator("[role=status]", { hasText: "Nothing was changed." }).waitFor();
  assert.equal(sent.length, 0, "nothing is sent before the yes");
  assert.equal(app.store.ownsSession(app.runtime.owner, session), false);
  await page.setInputFiles("#first-run-restore-file", junk);
  await card.getByRole("button", { name: "Yes, replace it" }).click();
  await card.locator("[role=status]", { hasText: "That file is not a Branch backup. Nothing was changed." }).waitFor();
  await page.setInputFiles("#first-run-restore-file", file);
  await card.getByRole("button", { name: "Yes, replace it" }).click();
  await card.locator("[role=status]", { hasText: /Brought back \d+ items/ }).waitFor();
  assert.equal(sent.length, 1, "one restore, sent after the yes");
  assert.equal(app.store.ownsSession(app.runtime.owner, session), true, "the conversation from the backup is here");
  await page.waitForLoadState("load");
  assert.deepEqual(errors, []);

  const full = await fixture(t);
  full.app.store.createSession(full.app.runtime.owner);
  await finishFirstRun(full.page);
  await full.page.setInputFiles("#first-run-restore-file", file);
  await full.page.locator("#first-run-steps").getByRole("button", { name: "Yes, replace it" }).click();
  await full.page.locator("#first-run-steps [role=status]", { hasText: "already has conversations, so nothing was changed" }).waitFor();
});

test("a failed try offers again, then another way, with the raw words behind Details", async (t) => {
  const { page, errors } = await fixture(t);
  await page.route("**/api/models/test", (route) => route.fulfill({ status: 502, contentType: "application/json",
    body: JSON.stringify({ error: "upstream said 418 teapot" }) }));
  await page.evaluate(() => { document.getElementById("first-run").hidden = false; document.getElementById("first-run-test").hidden = false; });
  await page.locator("#first-run-test").click();
  const status = page.locator("#first-run-status");
  await status.getByText("It did not answer. You can:").waitFor();
  const names = await status.getByRole("button").allTextContents();
  assert.deepEqual(names, ["Try again", "Choose another way"], "in the order a stuck person needs them");
  assert.equal(await status.locator("details pre").isVisible(), false, "the raw words wait behind Details");
  await status.getByText("Details").click();
  assert.match(await status.locator("details pre").textContent(), /418 teapot/);
  await status.getByRole("button", { name: "Choose another way" }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "door-chatgpt", "back at the first door");
  assert.equal(await status.getByRole("button", { name: "Try again" }).count(), 0, "the trouble line is gone once a way is chosen");
  assert.deepEqual(errors, []);
});

test("the sign-in code shows one character to a box and copies whole", async (t) => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    document.getElementById("first-run").hidden = false;
    const status = document.getElementById("first-run-status");
    status.textContent = "Enter the code on the sign-in page.";
    globalThis.branchDeviceCode(status, "WXYZ-1234");
  });
  const status = page.locator("#first-run-status");
  assert.equal(await status.locator(".first-run-code-cell").count(), 9);
  assert.equal(await status.locator(".first-run-code").getAttribute("aria-label"), "WXYZ-1234");
  await status.getByRole("button", { name: "Copy the code" }).click();
  await status.getByRole("button", { name: "Copied" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "WXYZ-1234");
});

test("every word the new steps show is on file in English and French", async (t) => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  const source = await readFile(join(import.meta.dirname, "..", "public", "first-run-next.js"), "utf8");
  const keys = [...source.matchAll(/"(first-run-(?:steps|trouble|code)\.[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 20, `found ${keys.length} keys`);
  for (const key of keys) {
    assert.ok(en[key], `${key} is in en.json`);
    assert.ok(fr[key], `${key} is in fr.json`);
  }
});

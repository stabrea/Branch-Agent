/**
 * Bucket 12 in the app window, used the way a person uses it: the saved-prompts card in
 * Automations › Procedures, and a saved command typed in the message box. Headless browser only; no window opens.
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

async function fixture(t, viewport = { width: 1280, height: 900 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-prompts-ui-"));
  const seen = [];
  const provider = { name: "prompts-ui", complete: async (request) => {
    seen.push(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    return { content: "Done", toolCalls: [] };
  } };
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
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { app, page, errors, seen };
}
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("saved prompts: switched on in Procedures, written, saved, then typed as a command in the message box", async (t) => {
  const { page, errors, seen } = await fixture(t);
  await openPlace(page, "automations:procedures");
  const card = page.locator("#prompts-card");
  await card.waitFor({ state: "visible" });
  assert.equal(await card.locator("#prompts-editor").count(), 0, "off: only the switch");
  await page.getByLabel("Saved prompts", { exact: true }).selectOption("on");
  await card.locator("#prompts-editor").waitFor({ state: "visible" });
  await card.getByLabel("Name of the prompt", { exact: true }).fill("Weekly review");
  await card.getByLabel("Group", { exact: true }).fill("Routines");
  await card.getByLabel("Command (without the /)").fill("weekly");
  await card.getByLabel("The prompt", { exact: true }).fill("Review the week since {{day}}.");
  await card.locator("#prompts-blank-day").waitFor({ state: "visible" });
  await card.getByRole("button", { name: "Save the prompt" }).click();
  await card.locator("#prompts-list").getByText("Weekly review").waitFor();
  assert.match(await card.locator("#prompts-list").textContent(), /Routines/);

  await openPlace(page, "chat");
  await page.locator("#prompt").fill("/wee");
  await page.locator("#slash-menu").getByText("/weekly").waitFor();
  await page.locator("#prompt").fill("/weekly day=monday");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelectorAll("#conversation .message").length >= 1);
  for (let i = 0; i < 200 && !seen.length; i++) await page.waitForTimeout(25);
  assert.deepEqual(seen, ["Review the week since monday."]);
  assert.deepEqual(errors, []);
});

test("saved prompts fit a 400 px window", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 860 });
  await openPlace(page, "automations:procedures");
  await page.getByLabel("Saved prompts", { exact: true }).selectOption("on");
  await page.locator("#prompts-editor").waitFor({ state: "visible" });
  assert.ok(await sideways(page) <= 0, "no sideways scrolling in Procedures");
  assert.deepEqual(errors, []);
});

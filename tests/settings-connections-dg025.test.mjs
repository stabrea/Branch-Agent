/**
 * DG-025 on Settings › Connections: each app step's "Saved secret with its key" is one field, and the approved
 * sample saves a single field as it changes. So the step shows the name it uses, saves it when the field changes,
 * forgets it when the field is emptied, says why when the name is refused, and has no Save button of its own.
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

async function connections(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-connections-dg025-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(`/api/${path}`, server.url), {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(response.ok, `${path} answered ${response.status}`);
    return response.json();
  };
  await call("onboarding", { done: true });
  await call("asks/switch", { part: "app-blocks", mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="connections"]').click();
  await page.locator("#lx-page-connections").waitFor({ state: "visible" });
  /* The steps' keys are Technical rows in the sample. */
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "technical");
  await page.locator("#asks-block-slack-post").waitFor({ state: "visible" });
  return { page, call, errors };
}

const keysNow = async (call) => (await call("asks/blocks/keys")).keys;
async function until(check, what) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((done) => setTimeout(done, 50)); }
  assert.fail(what);
}

test("DG-025: a step's key saves as it changes, shows its name, is forgotten when emptied, and has no Save", async (t) => {
  const { page, call, errors } = await connections(t);
  const card = page.locator("#asks-connections-card");
  const field = page.locator("#asks-block-slack-post");
  const status = card.locator(":scope > p[role=status]");

  assert.equal(await card.getByRole("button", { name: "Save", exact: true }).count(), 0, "no Save under a field that saves as it changes");
  assert.equal(await field.inputValue(), "");
  assert.equal(await field.getAttribute("placeholder"), "no key yet");

  await field.fill("SLACK_WEBHOOK");
  await field.press("Tab");
  await until(async () => (await keysNow(call))["slack.post"] === "SLACK_WEBHOOK", "the name was not saved on change");
  await until(async () => (await status.textContent()) === "Saved.", "the card did not say it saved");

  /* Drawn again (here by moving the step's switch), the new card's field shows the name it uses. The old card is
     marked so its typed words are never mistaken for the fresh card's. */
  await card.evaluate((node) => { node.dataset.drawnBefore = ""; });
  await page.locator("#asks-switch-app-blocks").selectOption("when-needed");
  await page.locator("#asks-connections-card:not([data-drawn-before]) #asks-block-slack-post").waitFor({ state: "visible" });
  assert.equal(await page.locator("#asks-block-slack-post").inputValue(), "SLACK_WEBHOOK", "the saved name is not shown");

  await page.locator("#asks-block-slack-post").fill("");
  /* Its answer is in before the next field is tried, so the card's one status line is not overwritten late. */
  const forgotten = page.waitForResponse((response) => response.url().endsWith("/api/asks/blocks/key"));
  await page.locator("#asks-block-slack-post").press("Tab");
  await forgotten;
  await until(async () => (await status.textContent()) === "Saved.", "the card did not say it forgot the name");
  await until(async () => !("slack.post" in (await keysNow(call))), "emptying the field did not forget the name");

  const long = "K".repeat(81);
  await page.locator("#asks-block-discord-post").fill(long);
  await page.locator("#asks-block-discord-post").press("Tab");
  await until(async () => {
    const words = (await status.textContent()) ?? "";
    return words !== "" && words !== "Saved.";
  }, "a refused name did not say why");
  assert.deepEqual(await keysNow(call), {}, "a refused name saves nothing");
  assert.equal(await page.locator("#asks-block-discord-post").inputValue(), long, "the person's words stay to be put right");
  assert.deepEqual(errors, []);
});

/**
 * mac7/r17-d: the coding polish card, the task's checklist in the side pane, and the @ picker,
 * opened the way a person opens them, at 400 px wide, in a headless browser against a scratch
 * workspace. Every word is behind a key with real French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the coding polish screens has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("coding.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(coding\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 30);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.ok(en["commands.init"] && fr["commands.init"] && en["commands.init"] !== fr["commands.init"]);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/coding.js" type="module"><\/script>/);
});

test("the card sits in Settings › Advanced, its switches work, and the checklist and @ picker appear once on", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await mkdir(join(app.runtime.workspace, "src"), { recursive: true });
  await writeFile(join(app.runtime.workspace, "src", "falcon.ts"), "export {};\n");
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  await openPlace(page, "settings:advanced");
  const card = page.locator("#coding-card");
  await card.waitFor();
  assert.equal(await card.locator("h3.settings-card-title").innerText(), "Coding polish");
  assert.equal(await page.evaluate(() => document.getElementById("coding-card")?.parentElement?.id ?? null), "lx-page-advanced");
  assert.equal(await page.locator("#coding-switch-review-checks").inputValue(), "off");
  await page.locator("#coding-switch-format-on-edit").selectOption("when-needed");
  for (let i = 0; i < 100 && app.coding.modes()["format-on-edit"] !== "when-needed"; i++) await page.waitForTimeout(50);
  assert.equal(app.coding.modes()["format-on-edit"], "when-needed");
  await page.locator("#coding-formatters").waitFor();
  await page.locator("#coding-switch-ci").selectOption("on");
  await page.locator("#coding-ci-model").waitFor();
  await page.locator("#coding-ci-model").fill("claude-sonnet-4-5");
  await page.locator("#coding-ci-endpoint").fill("https://api.anthropic.com/v1");
  await card.getByRole("button", { name: "Write the lines to paste" }).click();
  await card.getByText(".github/workflows/branch.yml", { exact: false }).waitFor();
  assert.equal(await wide(), false, "no sideways scrolling in Settings");

  app.coding.setMode("mentions", "on");
  app.coding.setMode("checklist", "on");
  await page.reload();
  await page.getByLabel("Session token", { exact: true }).fill(server.token).catch(() => undefined);
  await page.getByRole("button", { name: "Connect", exact: true }).click().catch(() => undefined);
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "chat");
  await page.locator("#prompt").fill("Look at @falc");
  await page.locator("#prompt").dispatchEvent("input");
  const choice = page.locator(".slash-choice", { hasText: "src/falcon.ts" });
  await choice.waitFor();
  await choice.click();
  assert.equal(await page.locator("#prompt").inputValue(), "Look at @src/falcon.ts ");
  assert.equal(await wide(), false, "no sideways scrolling with the picker open");
  const run = await app.runtime.run({ prompt: "hello" });
  app.coding.checklists.saveByOwner({ sessionId: run.sessionId, steps: [{ text: "Write the plan" }] });
  await page.evaluate((id) => { document.getElementById("conversation").dataset.sessionId = id; }, run.sessionId);
  const block = page.locator("#coding-checklist-block");
  await block.getByText("Write the plan").waitFor({ state: "attached" });
  assert.equal(await block.getAttribute("data-pane"), "plan");
});

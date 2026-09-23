/**
 * mac6/bucket-23: the cards for the smaller asks, opened the way a person opens them, at 400 px wide,
 * in a headless browser against a scratch workspace. Every word on them is behind a key with French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the smaller asks' cards has English and real French", async () => {
  const source = await readFile(new URL("asks.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(asks\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 60);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/asks.js" type="module"><\/script>/);
});

test("the cards sit in their homes, the switches work from the window, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-asks-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });

  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await openPlace(page, "customize:skills");
  const intents = page.locator("#asks-intents-card");
  await intents.waitFor();
  assert.equal(await intents.locator("h2").innerText(), "Sending requests where they belong");
  assert.equal(await page.locator("#asks-switch-intent-pipeline").inputValue(), "off");
  await page.locator("#asks-switch-intent-pipeline").selectOption("when-needed");
  for (let i = 0; i < 100 && app.asks.modes()["intent-pipeline"] !== "when-needed"; i++) await page.waitForTimeout(50);
  assert.equal(app.asks.modes()["intent-pipeline"], "when-needed");
  await page.locator("#asks-intents-list").waitFor();
  await page.locator("#asks-intents-list").fill("invoice | invoice due amount | skill:bookkeeping");
  await intents.getByRole("button", { name: "Save" }).click();
  for (let i = 0; i < 100 && !app.asks.intents.settings().intents.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(app.asks.intents.settings().intents[0].goesTo, { kind: "skill", target: "bookkeeping" });
  await page.locator("#asks-intents-try").fill("the invoice amount is due");
  await intents.getByRole("button", { name: "Where would it go?" }).click();
  await intents.getByText("invoice → skill: bookkeeping", { exact: false }).waitFor();
  assert.equal(await wide(), false, "no sideways scrolling in Customize");

  await openPlace(page, "library:made");
  await page.locator("#asks-made-card").waitFor();
  assert.equal(await page.locator("#asks-switch-answer-pages").inputValue(), "off");
  await openPlace(page, "customize:connections");
  const connections = page.locator("#asks-connections-card");
  await connections.waitFor();
  await connections.getByText("Notion (Notion's own MCP server)", { exact: false }).waitFor();
  assert.equal(await wide(), false, "no sideways scrolling in Connections");
  for (const [card, home] of [["asks-board-card", "lx-page-general"], ["asks-analytics-card", "lx-page-data"], ["asks-nodes-card", "lx-page-computer"],
    ["asks-runtimes-card", "lx-models-connection"], ["asks-sources-card", "documents"], ["asks-hindsight-card", "memory"],
    ["asks-forecasts-card", "lx-page-data"]])
    assert.equal(await page.evaluate(([id]) => document.getElementById(id)?.parentElement?.id ?? null, [card]), home, `${card} is not in its home`);
});

/**
 * r17-b: the cards for suggestions, standing orders, loops, procedures, what waits, "from now on" and
 * readiness, opened the way a person opens them, at 400 px wide, in a headless browser against a
 * scratch workspace. Every word on them is behind a key with real French.
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

test("every word on the automation cards has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("autonomy.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(autonomy\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 60);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false);
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/autonomy.js" type="module"><\/script>/);
});

test("the cards sit in their homes, a blueprint is made from the window, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-autonomy-ui-"));
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

  await openPlace(page, "automations:scheduled");
  const suggestions = page.locator("#autonomy-suggestions-card");
  await suggestions.waitFor();
  assert.equal(await suggestions.locator("h2").innerText(), "Suggested automations");
  assert.equal(await page.locator("#autonomy-switch-suggestions").inputValue(), "off");
  await page.locator("#autonomy-switch-suggestions").selectOption("on");
  await page.locator("#autonomy-blueprint").waitFor();
  await page.locator("#autonomy-blueprint").selectOption("custom-reminder");
  await page.locator("#autonomy-blank-note").fill("water the oak");
  await suggestions.getByRole("button", { name: "Make this automation" }).click();
  for (let i = 0; i < 100 && !app.store.list("schedules", app.runtime.owner).length; i++) await page.waitForTimeout(50);
  assert.match(app.store.list("schedules", app.runtime.owner)[0].data.prompt, /water the oak/);
  await page.locator("#autonomy-orders-card").waitFor();
  await page.locator("#autonomy-limits-card").waitFor();
  assert.equal(await wide(), false, "no sideways scrolling in Automations");

  await openPlace(page, "automations:procedures");
  await page.locator("#autonomy-procedures-card").waitFor();
  assert.equal(await page.locator("#autonomy-switch-procedures").inputValue(), "off");

  app.autonomy.setMode("instructions", { mode: "on" });
  app.autonomy.instructions.propose({ text: "Answer in French." }, "assistant");
  // The cards are drawn when the window opens, so the question asked meanwhile shows after a reload.
  await page.reload();
  const token = page.getByLabel("Session token", { exact: true });
  if (await token.isVisible().catch(() => false)) {
    await token.fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "inbox:needs");
  await page.locator("#autonomy-needs-card").getByText("Answer in French.", { exact: false }).waitFor();
  await page.locator("#autonomy-needs-card").getByRole("button", { name: "Yes" }).click();
  for (let i = 0; i < 100 && !app.autonomy.instructions.list().length; i++) await page.waitForTimeout(50);
  assert.equal(app.autonomy.instructions.list()[0].text, "Answer in French.");
  assert.equal(await wide(), false, "no sideways scrolling in Inbox");

  const placed = await page.evaluate(() => Object.fromEntries(["autonomy-instructions-card", "autonomy-readiness-card"]
    .map((id) => [id, document.getElementById(id)?.closest("[id^='lx-page-'], [id^='lx-slot-'], #skills")?.id ?? null])));
  assert.equal(placed["autonomy-instructions-card"], "lx-page-assistant");
  assert.ok(placed["autonomy-readiness-card"], "the readiness card has a home in Customize");
});

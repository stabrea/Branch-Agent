/**
 * Every state refresh asks the sharing page to render again. It used to rebuild every tool row (a couple of hundred
 * nodes) each time, so the page never went quiet, and tests/language-idempotent.test.mjs, which compares a
 * language choice with standing still, failed on slow machines. Unchanged rows are now left alone.
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

async function openApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-quiet-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => document.getElementById("mcp-tools")?.childElementCount > 0, undefined, { timeout: 60000 });
  return page;
}

/** How many changes one more render makes inside the tool list. */
const renderCost = (page) => page.evaluate(async () => {
  const box = document.getElementById("mcp-tools");
  let writes = 0;
  const watch = new MutationObserver((records) => { writes += records.length; });
  watch.observe(box, { subtree: true, childList: true, characterData: true, attributes: true });
  await window.branchMcp.render();
  await new Promise((resolve) => setTimeout(resolve, 50));
  watch.disconnect();
  return { writes, rows: box.childElementCount };
});

test("rendering the sharing page again with nothing changed leaves its tool rows alone", async (t) => {
  const page = await openApp(t);
  const again = await renderCost(page);
  assert.ok(again.rows > 0, "there are tool rows to keep");
  assert.equal(again.writes, 0, `an unchanged render rewrote the tool list ${again.writes} times`);
});

test("a row the owner ticks is drawn again, so the list still follows what is shared", async (t) => {
  const page = await openApp(t);
  const first = page.locator("#mcp-tools input[type=checkbox]").first();
  const before = await first.isChecked();
  await page.evaluate(async (tick) => {
    const box = document.getElementById("mcp-tools");
    const name = box.querySelector("label span").textContent;
    const token = sessionStorage.getItem("branch-token");
    const current = await (await fetch("/api/mcp/settings", { headers: { authorization: "Bearer " + token } })).json();
    const exposedTools = tick ? [...current.exposedTools, name] : current.exposedTools.filter((tool) => tool !== name);
    await fetch("/api/mcp/settings", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ enabled: current.enabled, exposedTools }) });
  }, !before);
  const changed = await renderCost(page);
  assert.ok(changed.writes > 0, "a changed choice is drawn");
  assert.equal(await page.locator("#mcp-tools input[type=checkbox]").first().isChecked(), !before);
});

// NAS 11bf954: with the rows left alone, a box the owner clicked whose save was refused kept showing that choice, so
// a tool could look shared, or not, when it was the other way. The next refresh puts it back to what is shared.
test("a box whose save was refused shows what is really shared again after the next refresh", async (t) => {
  const page = await openApp(t);
  await page.route("**/api/mcp/settings", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not save" }) }) : route.continue());
  const first = page.locator("#mcp-tools input[type=checkbox]").first();
  const was = await first.evaluate((input) => input.checked);
  await first.evaluate((input) => { input.checked = !input.checked; input.dispatchEvent(new Event("change")); });
  await page.evaluate(() => window.branchMcp.render());
  assert.equal(await first.evaluate((input) => input.checked), was, "the box shows the choice that is in effect");
  assert.equal((await renderCost(page)).writes, 0, "and putting it back wrote nothing to the page");
});

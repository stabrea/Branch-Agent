/* DG-183: Settings › Appearance shows the approved sample's sections, in its order, with its "N more" lines, and
   every card it had still has a place on the page. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const { BUCKETS } = await import("../public/settings-buckets.js");
const CARDS = ["lx-look", "delight-bg-card", "delight-pet-card", "delight-ach-card", "settings-form", "shell-look-card",
  "knobs-show-reasoning-card", "savings-round-chart-card", "comfort-display-card", "flows-focus-card", "panels-onscreen"];

test("every Appearance card keeps a section of its own", () => {
  const placed = BUCKETS.appearance.flatMap((bucket) => bucket[4].map(([ref]) => ref));
  assert.deepEqual([...placed].sort(), [...CARDS].sort());
  assert.deepEqual(BUCKETS.appearance.map((bucket) => bucket[2]), ["Theme", "A pet", "Theme and lettering", "What a conversation shows"]);
});

async function open(t, { width, everything }) {
  const root = await mkdtemp(join(tmpdir(), "branch-appearance-sections-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  if (everything) app.store.save("settings", app.runtime.owner, "preferences", { showEverything: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const page = await browser.newPage({ viewport: { width, height: 950 } });
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
  await page.locator('.lx-settings-link[data-page="appearance"]').click();
  await page.locator("#lx-page-appearance .sg-head").first().waitFor();
  return { page, errors };
}
/** The page's headings and "N more" lines, in order, as a person sees them. */
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-appearance :is(h2, h3, h4, .sg-more-line:not([hidden]) .sg-more)")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));

for (const width of [1440, 400]) {
  test(`at ${width} px the default level shows the sample's sections and counts`, async (t) => {
    const { page, errors } = await open(t, { width, everything: false });
    await page.waitForFunction(() => document.querySelectorAll("#lx-page-appearance .sg-more-line:not([hidden])").length === 2);
    assert.deepEqual((await outline(page)).filter((words) => !/^Showing a model's thinking$|^Round-by-round chart$/.test(words)),
      ["Appearance", "Theme", "A pet", "Theme and lettering", "5 more with Advanced", "What a conversation shows", "5 more with Advanced"]);
    assert.equal(await page.locator("#lx-page-appearance .sg-other").isVisible(), false, "no card is left over under More on this page");
    assert.equal(await page.locator("#settings-form h2").count(), 0, "the lettering card has no second Appearance title");
    assert.deepEqual(errors, []);
  });
  test(`at ${width} px with Show everything on the same sections stand in the same order`, async (t) => {
    const { page, errors } = await open(t, { width, everything: true });
    const sections = await page.evaluate(() => [...document.querySelectorAll("#lx-page-appearance .sg-head-title")].filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
    assert.deepEqual(sections, ["Theme", "A pet", "Theme and lettering", "What a conversation shows"]);
    assert.equal(await page.locator("#panels-onscreen").isVisible(), true, "What's on screen shows at Advanced");
    assert.deepEqual(errors, []);
  });
}

test("DG-025: Appearance saves as you go, with no Save button, and says so when a save fails", async (t) => {
  const { page, errors } = await open(t, { width: 1440, everything: false });
  assert.equal(await page.locator("#settings-form button[data-t='appearance.save']").count(), 0);
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "POST");
  await page.locator("#appearance-acorn").click();
  assert.equal((await saved).postDataJSON().showAcorn, true, "the change is sent the moment it is made");
  await page.evaluate(() => import("/appearance.js").then((look) => look.appearanceSaved()));
  await page.route("**/api/preferences", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The look could not be saved." }) })
    : route.continue());
  await page.locator("#appearance-acorn").click();
  await page.waitForFunction(() => /could not be saved/.test(document.getElementById("toast")?.textContent ?? ""));
  assert.deepEqual(errors, []);
});

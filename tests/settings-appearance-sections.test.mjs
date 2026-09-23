/* DG-183: Settings › Appearance shows the approved sample's sections, in its order, with its "N more" lines, and
   every card it had still has a place on the page. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const { BUCKETS } = await import("../public/settings-buckets.js");
/* The approved sample (design/Branch-Grown-Up.html, blob a6aa8ea4ddc336acf3baeb32decb8363d22677cb) at Regular, read
   from its rendered Settings › Appearance. It is private, so its lists are copied here, never read in CI.
   Theme and lettering shows these rows, in this order (Text size stands under its "More options"): */
const SAMPLE_LETTERING_ROWS = ["Keep things still (no sliding or spinning)", "Show the acorn", "Language", "Text size"];
/* ...and keeps these out of sight until Advanced ("6 more with Advanced"). lx-contrast is its pointer row, "Set in Theme ›". */
const SAMPLE_LETTERING_HIDDEN = ["lx-contrast", "appearance-everything", "appearance-voice", "look-accent", "look-density", "look-font"];
/* What a conversation shows keeps these out of sight ("5 more with Advanced"). */
const SAMPLE_SHOWS_HIDDEN = ["comfort-timestamps", "flows-switch-focus", "flows-focus-now", "comfort-statusLine-mode", "statusline-items"];
/* Branch's row that stands for a sample pointer row. */
const POINTER_FOR = { "appearance-contrast-link": "lx-contrast" };
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
  .filter((node) => node.checkVisibility() && !node.closest(".sr-only")).map((node) => node.textContent.trim()));
/** The words of each row of Theme and lettering a person sees, in order: a field's label, or each switch's words. */
const letteringRows = (page) => page.evaluate(() => [...document.querySelectorAll("#settings-form .appearance-field")].flatMap((field) => {
  const shown = (node) => node.checkVisibility() && !node.closest(".sr-only");
  const switches = [...field.querySelectorAll(":scope > .check-row")].filter(shown);
  if (switches.length) return switches.map((row) => row.textContent.trim());
  const label = field.querySelector(":scope > :is(label, span)");
  return label && shown(label) && shown(field) ? [label.textContent.trim()] : [];
}));
/** The settings of Theme and lettering kept out of sight at this level, by the sample's ids. */
const letteringHidden = (page) => page.evaluate((pointers) => [...new Set([...document.querySelectorAll("#settings-form [data-sg-row]")]
  .filter((node) => !node.checkVisibility()).map((node) => pointers[node.dataset.sgRow] ?? node.dataset.sgRow))], POINTER_FOR);

for (const width of [1440, 860, 400]) {
  test(`at ${width} px the default level shows the sample's sections, rows and counts`, async (t) => {
    const { page, errors } = await open(t, { width, everything: false });
    await page.waitForFunction(() => document.querySelectorAll("#lx-page-appearance .sg-more-line:not([hidden])").length === 2);
    assert.deepEqual((await outline(page)).filter((words) => !/^Showing a model's thinking$|^Round-by-round chart$/.test(words)),
      ["Appearance", "Theme", "A pet", "Theme and lettering", `${SAMPLE_LETTERING_HIDDEN.length} more with Advanced`,
        "What a conversation shows", `${SAMPLE_SHOWS_HIDDEN.length} more with Advanced`]);
    assert.deepEqual(await letteringRows(page), SAMPLE_LETTERING_ROWS, "Theme and lettering shows the sample's rows, in its order");
    assert.deepEqual((await letteringHidden(page)).sort(), [...SAMPLE_LETTERING_HIDDEN].sort(), "and keeps the sample's rows for Advanced");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#settings-form .appearance-field")].filter((field) => field.checkVisibility()
      && ![...field.children].some((node) => node.checkVisibility() && !node.matches(".sr-only"))).length), 0, "no empty cell is left where rows went");
    assert.equal(await page.locator("#lx-page-appearance .sg-other").isVisible(), false, "no card is left over under More on this page");
    /* Q4: the pet card and the lettering card keep a title, for screen readers only: the sample shows its section's heading there. */
    for (const [card, title] of [["delight-pet-card", "A pet"], ["settings-form", "Theme and lettering"]]) {
      assert.equal(await page.locator(`#${card} > h2.sr-only`).textContent(), title, `${card} keeps its title for screen readers`);
      assert.equal(await page.locator(`#${card} > h2:not(.sr-only)`).count(), 0, `${card} shows no second title`);
    }
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

test("DG-183: at Advanced, Theme and lettering points to the contrast switch with the theme, in French too", async (t) => {
  const { page, errors } = await open(t, { width: 1440, everything: false });
  await page.evaluate(() => globalThis.branchSettingsLevel.set("advanced"));
  await page.waitForFunction(() => document.getElementById("appearance-contrast-link").checkVisibility());
  /* Every row shows at Advanced, save the highlight colour: Branch chooses it with the theme (public/layout.js). */
  assert.deepEqual(await letteringHidden(page), ["look-accent"], "every row of Theme and lettering shows at Advanced");
  const link = page.locator("#appearance-contrast-link");
  assert.equal(await link.textContent(), "Set in Theme ›");
  assert.equal(await page.getByRole("button", { name: "More contrast between text and background Set in Theme ›", exact: true }).count(), 1);
  await link.click();
  await page.waitForFunction(() => document.activeElement?.id === "lx-contrast");
  assert.ok(await page.locator("#lx-contrast").isVisible(), "the contrast switch is brought into view");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.getElementById("appearance-contrast-link").textContent === "À régler dans Thème ›");
  assert.equal(await page.locator("#settings-form > h2.sr-only").textContent(), "Thème et écriture");
  await page.waitForFunction((count) => [...document.querySelectorAll("#lx-page-appearance .sg-more-line:not([hidden]) .sg-more")]
    .some((node) => node.textContent === `${count} de plus en Avancé`), SAMPLE_LETTERING_HIDDEN.length);
  assert.deepEqual(errors, []);
});

test("DG-025: the desktop test no longer presses the removed Save appearance button", async () => {
  const desktop = await readFile(new URL("./desktop.test.mjs", import.meta.url), "utf8");
  assert.equal(desktop.includes("Save appearance"), false, "tests/desktop.test.mjs would wait for a button that is gone");
  assert.match(desktop, /appearanceSaved\(\)/, "it waits for the change to be saved instead");
});

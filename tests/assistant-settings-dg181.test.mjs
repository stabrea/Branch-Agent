import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings, showEverything } from "./places.mjs";

/**
 * DG-181: Settings › Assistant is the approved sample's page. At Regular it shows one section, "Who your assistant
 * is", with the name and the working instructions and "4 more with Advanced" (the three files and "from now on",
 * counted as rows); at Advanced the same one section holds all six, with no card titles drawn inside it (DG-008:
 * they are read aloud one level under the section's heading). Nothing on it has a Save button: each field and
 * switch is kept as it changes (DG-025).
 */

async function fixture(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-assistant-dg181-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app };
}

/** Opens the Assistant page as a person does, without the tests' "show every card" peek. */
async function openAssistant(page) {
  await openSettings(page);
  await page.locator('.lx-settings-link[data-page="assistant"]').click();
  await page.locator("#context-assistant").waitFor({ state: "attached", timeout: 15000 });
  await page.locator("#autonomy-instructions-card").waitFor({ state: "attached", timeout: 15000 });
}
const setLevel = (page, level) => page.evaluate(async (to) => {
  globalThis.branchSettingsLevel.set(to);
  for (let i = 0; i < 100 && document.documentElement.dataset.settingsLevel !== to; i++) await new Promise((r) => setTimeout(r, 50));
}, level);

/** The headings, "N more" lines and visible rows (labels) of the page, top to bottom, as a person sees them. */
const seen = (page) => page.evaluate(() => {
  const host = document.getElementById("lx-page-assistant");
  const shows = (node) => node.getClientRects().length > 0 && !node.closest(".sr-only") && getComputedStyle(node).visibility !== "hidden";
  const words = (node) => node.textContent.replace(/\s+/g, " ").trim();
  return {
    headings: [...host.querySelectorAll("h1, h2, h3, h4, h5, h6, .sg-more")].filter(shows).map(words),
    labels: [...host.querySelectorAll("label")].filter(shows).map(words),
    saves: [...host.querySelectorAll("button")].filter(shows).map(words).filter((w) => /^(Save|Enregistrer)/.test(w)),
    levels: [...host.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => `${h.tagName}${h.closest(".sr-only, .sr-only *") || h.classList.contains("sr-only") ? "*" : ""}`),
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
});

for (const width of [1440, 860, 400]) {
  test(`at ${width} px the page shows the sample's one section, at Regular and at Advanced`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await openAssistant(page);
    await setLevel(page, "regular");
    await page.waitForFunction(() => /4 more/.test(document.querySelector("#lx-page-assistant .sg-more")?.textContent ?? ""));
    const regular = await seen(page);
    assert.deepEqual(regular.headings, ["Assistant", "Who your assistant is", "4 more with Advanced"]);
    assert.deepEqual(regular.labels, ["Assistant name", "Working instructions"]);
    assert.deepEqual(regular.saves, []);
    assert.equal(regular.wide, false, "nothing scrolls sideways");

    await setLevel(page, "advanced");
    const advanced = await seen(page);
    assert.deepEqual(advanced.headings, ["Assistant", "Who your assistant is"], "one section, no card titles drawn in it");
    for (const label of ["Assistant name", "Working instructions", "Its character — SOUL.md", "Its name — IDENTITY.md",
      "Who you are — USER.md", "\"From now on\" instructions"]) assert.ok(advanced.labels.includes(label), label);
    assert.deepEqual(advanced.saves, [], "no Save button: everything here is kept as it changes");
    /* The section's heading is an h3 and the cards' own titles sit under it, read aloud only. */
    assert.deepEqual(advanced.levels.filter((l) => l.startsWith("H4")), ["H4*", "H4*", "H4*"]);
    assert.equal(advanced.wide, false);
    assert.deepEqual(errors, []);
  });
}

test("in Daylight with Show everything on, and in French, the page keeps the same shape", async (t) => {
  const { page, errors } = await fixture(t);
  await showEverything(page, { showEverything: true, settingsLevel: "advanced", appearance: "daylight" });
  await openAssistant(page);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.querySelector("#identity-form label")?.textContent === "Nom de l'assistant");
  const french = await seen(page);
  assert.equal(french.headings.length, 2, french.headings.join(" · "));
  assert.equal(french.headings[1], "Qui est votre assistant");
  const untranslated = await page.evaluate(() => [...document.querySelectorAll("#identity-form [data-t]")]
    .filter((node) => node.textContent.trim() && /What your assistant|Standing instructions/.test(node.textContent)).length);
  assert.equal(untranslated, 0, "the row notes are said in French");
  await setLevel(page, "regular");
  await page.waitForFunction(() => /4/.test(document.querySelector("#lx-page-assistant .sg-more")?.textContent ?? ""));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const key of ["settings.note.assistant-name", "settings.note.working-instructions", "settings.placeholder.working-instructions"])
    assert.ok(fr[key], key);
  assert.deepEqual(errors, []);
});

test("the name is kept when you leave the field, and a file switch the moment it moves", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openAssistant(page);
  await setLevel(page, "advanced");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/identity") && r.request().method() === "POST");
  await page.locator("#identity-name").fill("Juniper");
  await page.locator("#identity-name").press("Tab");
  assert.equal((await saved).ok(), true);
  await page.locator("#identity-status").filter({ hasText: "Identity saved." }).waitFor();
  assert.equal(await page.locator("#identity-reload").isVisible(), false, "Reload shows only after a save that failed");

  /* Enter in the name keeps it too, and never sends the window anywhere. */
  const again = page.waitForResponse((r) => r.url().endsWith("/api/identity") && r.request().method() === "POST");
  await page.locator("#identity-name").fill("Juniper Two");
  await page.locator("#identity-name").press("Enter");
  assert.equal((await again).request().postDataJSON().name, "Juniper Two");

  const kept = page.waitForResponse((r) => r.url().endsWith("/api/context-files") && r.request().method() === "POST");
  await page.locator("#context-switch-soul").selectOption("on");
  assert.equal((await kept).ok(), true);
  await page.locator("#context-assistant [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(app.store.get("settings", "local", "context-files")?.data.files.soul, "on");

  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openAssistant(page);
  assert.equal(await page.locator("#identity-name").inputValue(), "Juniper Two");
  assert.deepEqual(errors, []);
});

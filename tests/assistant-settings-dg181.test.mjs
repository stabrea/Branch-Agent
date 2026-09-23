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
 * is" with its line "Its name, its manner, and standing instructions.", the name and the working instructions (each
 * note once) and "4 more with Advanced" (the three files and "from now on", counted as rows); at Advanced the same
 * one section holds all six, with no card titles drawn inside it (DG-008: they are read aloud one level under the
 * section's heading). The three files are lines that send you to Instructions & personality ("Set in … ›"), where
 * their switches are, as in the sample. Nothing has a Save button: each field and switch is kept as it changes
 * (DG-025), a field keeps the cursor while the page is put in order, and a switch whose save fails goes back.
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
    links: [...host.querySelectorAll(".file-link-row")].filter(shows).map((row) => [...row.children].map(words).join(" | ")),
    line: [...host.querySelectorAll(".sg-head-line")].filter(shows).map(words),
    toc: [...host.querySelectorAll(".lx-on-this-page")].filter(shows).length,
    text: host.innerText,
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
    assert.deepEqual(regular.line, ["Its name, its manner, and standing instructions."], "the section's line, as the sample");
    assert.equal(regular.toc, 0, "one section: no \"On this page\", as the sample (four sections or more)");
    for (const note of ["What your assistant calls itself. It applies from the next message.",
      "Standing instructions read before every task, in every project."])
      assert.equal(regular.text.split(note).length - 1, 1, `the note is shown once: ${note}`);
    assert.deepEqual(regular.links, []);
    /* One note under each field, and it is the one the field is described by. */
    assert.deepEqual(await page.evaluate(() => ["identity-name", "identity-instructions"].map((id) => {
      const field = document.getElementById(id), notes = document.querySelectorAll("#identity-form .field-note");
      return [notes.length, document.getElementById(field.getAttribute("aria-describedby"))?.textContent];
    })), [[2, "What your assistant calls itself. It applies from the next message."],
      [2, "Standing instructions read before every task, in every project."]]);
    assert.deepEqual(regular.saves, []);
    assert.equal(regular.wide, false, "nothing scrolls sideways");

    await setLevel(page, "advanced");
    const advanced = await seen(page);
    assert.deepEqual(advanced.headings, ["Assistant", "Who your assistant is"], "one section, no card titles drawn in it");
    for (const label of ["Assistant name", "Working instructions", "\"From now on\" instructions"])
      assert.ok(advanced.labels.includes(label), label);
    /* The sample's rows for the three files: a name and a link, no switch here. */
    assert.deepEqual(advanced.links, ["Its character — SOUL.md", "Its name — IDENTITY.md", "Who you are — USER.md"]
      .map((name) => `${name} | Set in Instructions & personality ›`));
    assert.equal(await page.locator("#lx-page-assistant select[id^=context-switch-], #lx-page-assistant .agent-file-mode").count(), 0, "the switches are on Instructions");
    assert.deepEqual(advanced.saves, [], "no Save button: everything here is kept as it changes");
    /* The cards' own titles are read aloud only: screen-reader-only h2s, as DG-183's (coordinator ruling), so each
       card still carries a title (shell-ui Q4). Nothing on the page is an h4. */
    assert.deepEqual(await page.evaluate(() => ["identity-form", "context-assistant", "autonomy-instructions-card"]
      .map((id) => document.querySelector(`#${id} > h2.sr-only`)?.textContent.trim() ?? null)),
    ["Assistant identity", "Who your assistant is", "\"From now on\" instructions"]);
    assert.deepEqual(advanced.levels.filter((l) => l.startsWith("H4")), []);
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
  assert.deepEqual(french.line, ["Son nom, sa manière d'être et ses consignes permanentes."]);
  for (const note of ["Le nom que se donne votre assistant.", "Des consignes permanentes, lues avant chaque tâche"])
    assert.equal(french.text.split(note).length - 1, 1, `la note ne se montre qu'une fois : ${note}`);
  assert.deepEqual(french.links, ["Son caractère — SOUL.md", "Son nom — IDENTITY.md", "Qui vous êtes — USER.md"]
    .map((name) => `${name} | À régler dans Instructions et personnalité ›`));
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

  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await openAssistant(page);
  assert.equal(await page.locator("#identity-name").inputValue(), "Juniper Two");
  assert.deepEqual(errors, []);
});

/** The one control for a file on Instructions & personality: its row's Off / When needed / On (DG-182). */
const fileSwitch = (page, slot) => page.locator(`#agent-files .agent-file[data-slot="${slot}"] .agent-file-mode`);

test("Instructions has one control for each of the three files, and the Assistant's rows take the keyboard to it", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openSettings(page, "instructions");
  await page.locator("#agent-files .agent-file").first().waitFor();
  /* DG-182's row is the file's switch; DG-181's own card of three selects is not drawn beside it. */
  const controls = await page.evaluate(() => ["soul", "identity", "user"].map((slot) => document.querySelectorAll(
    `#lx-page-instructions #context-switch-${slot}, #lx-page-instructions .agent-file[data-slot="${slot}"] .agent-file-mode`).length));
  assert.deepEqual(controls, [1, 1, 1], "one control each");
  assert.equal(await page.locator("#context-persona").count(), 0);
  await openAssistant(page);
  await setLevel(page, "advanced");
  for (const slot of ["soul", "identity", "user"]) {
    await page.locator(`#context-link-go-${slot}`).click();
    await page.locator("#lx-page-instructions").waitFor({ state: "visible" });
    await page.waitForFunction((one) => document.activeElement?.matches(
      `.agent-file[data-slot="${one}"] .agent-file-mode [aria-pressed="true"]`), slot);
    await page.locator('.lx-settings-link[data-page="assistant"]').click();
    await page.locator("#context-link-soul").waitFor({ state: "visible" });
  }
  /* The switch it lands on is kept the moment it is pressed. */
  await page.locator("#context-link-go-soul").click();
  await fileSwitch(page, "soul").getByRole("button", { name: "On", exact: true }).click();
  await page.locator("#agent-files [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(app.store.get("settings", "local", "context-files")?.data.files.soul, "on");
  assert.deepEqual(errors, []);
});

test("a file switch whose save fails stays on what is saved, and says so", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openSettings(page, "instructions");
  const identity = fileSwitch(page, "identity");
  await identity.waitFor();
  await page.route("**/api/context-files", (route) => (route.request().method() === "POST"
    ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Saving is unavailable."}' })
    : route.continue()));
  await identity.getByRole("button", { name: "On", exact: true }).click();
  const status = page.locator("#agent-files [role=status]");
  await status.filter({ hasText: "not saved" }).waitFor();
  assert.equal(await identity.locator('[aria-pressed="true"]').innerText(), "Off", "the switch shows what is kept");
  assert.match(await status.innerText(), /back where it was\. Saving is unavailable\./);
  assert.equal(app.store.get("settings", "local", "context-files")?.data.files?.identity, undefined);
  await page.unroute("**/api/context-files");
  await identity.getByRole("button", { name: "When needed", exact: true }).click();
  await status.filter({ hasText: "Saved." }).waitFor();
  assert.equal(app.store.get("settings", "local", "context-files")?.data.files.identity, "when-needed");
  assert.deepEqual(errors, []);
});

/* Two frames: the page is put in order on the frame after it changes. */
const frames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test("a field keeps the cursor while its page is put in order again, with \"On this page\" under the intro", async (t) => {
  const { page, errors } = await fixture(t);
  /* General has five sections, so it has "On this page"; drawing it again must move no card. */
  await openSettings(page, "general");
  await frames(page);
  const focused = await page.evaluate(() => {
    const host = document.getElementById("lx-page-general");
    const card = host.querySelector(":scope > .sg-head + *");
    const field = card.querySelector("input:not([type=hidden]), select, textarea, button");
    field.id ||= "dg181-focus-probe";
    field.focus();
    return document.activeElement === field ? field.id : null;
  });
  assert.ok(focused, "a control in the first section takes the cursor");
  await page.evaluate(() => document.querySelector('.lx-settings-link[data-page="general"]').click());
  await frames(page);
  await frames(page);
  const after = await page.evaluate(() => {
    const nav = document.querySelector("#lx-page-general > .lx-on-this-page");
    return { active: document.activeElement?.id, nav: Boolean(nav), underIntro: nav?.previousElementSibling?.matches(".lx-page-intro") };
  });
  assert.deepEqual(after, { active: focused, nav: true, underIntro: true });

  /* On the Assistant page, the working instructions keep the cursor while a save says what it is doing. */
  await openAssistant(page);
  await frames(page);
  await page.locator("#identity-instructions").focus();
  await page.evaluate(() => { document.getElementById("identity-status").textContent = "Saving identity…"; });
  await frames(page);
  await frames(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "identity-instructions");
  assert.deepEqual(errors, []);
});

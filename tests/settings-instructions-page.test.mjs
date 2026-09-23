/**
 * DG-182: Settings › Instructions & personality shows the approved sample's page: its title and one section,
 * "Its files", with no "N more" line, at every width, in both lights, with Show everything on and off, and in
 * French. Each file's row has the sample's words, its first line (or Empty), Off / When needed / On saved as it
 * is pressed, and Edit; where it is kept shows at Technical only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { contextFileSettings } from "../dist/context-files.js";
import { openSettings, showEverything } from "./places.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-instructions-page-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await writeFile(join(app.store.folder, "SOUL.md"), "# Who you are\n\nYou are Branch, a calm and practical assistant.\n");
  return { app, server, browser };
}

async function connect(browser, server, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  return { page, errors };
}

/** Opens the page at its own level: leaving it and coming back drops the "show every card" a test helper adds. */
async function openAtLevel(page) {
  await openSettings(page, "instructions");
  await page.locator('.lx-settings-link[data-page="appearance"]').click();
  await page.locator('.lx-settings-link[data-page="instructions"]').click();
  await page.locator("#agent-files .agent-file").first().waitFor();
}

/** The headings and "N more" lines a person sees on the page, in order. */
const seen = (page) => page.evaluate(() => {
  const host = document.getElementById("lx-page-instructions");
  const shown = (node) => { const box = node.getBoundingClientRect(); return box.width > 1 && box.height > 1 && node.checkVisibility(); };
  return [...host.querySelectorAll("h1, h2, h3, h4, .sg-more-line")].filter(shown).map((node) => node.textContent.trim());
});

test("DG-182: the page is the sample's title and one section, Its files, in every state", async (t) => {
  const { browser, server } = await fixture(t);
  for (const width of [1440, 860, 400]) {
    const { page, errors } = await connect(browser, server, width);
    for (const [everything, theme] of [[false, "forest"], [true, "daylight"], [true, "forest"], [false, "daylight"]]) {
      await showEverything(page, { showEverything: everything, appearance: theme });
      await openAtLevel(page);
      assert.deepEqual(await seen(page), ["Instructions & personality", "Its files"], `${width} px, Show everything ${everything}, ${theme}`);
      assert.equal(await page.locator("#agent-files").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${width} px fits`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("DG-182: each file's row has the sample's words, its first line, Off / When needed / On saved as pressed, and Edit", async (t) => {
  const { app, browser, server } = await fixture(t);
  const { page, errors } = await connect(browser, server, 1440);
  await openAtLevel(page);
  const card = page.locator("#agent-files");
  const soul = card.locator(".agent-file", { hasText: "SOUL.md" });
  assert.equal(await soul.locator(".agent-file-about").innerText(), "Who your assistant is: personality, tone and boundaries.");
  assert.equal(await soul.locator(".agent-file-first").innerText(), "You are Branch, a calm and practical assistant.");
  assert.equal(await card.locator(".agent-file", { hasText: "USER.md" }).locator(".agent-file-first").innerText(), "Empty");
  assert.equal(await soul.locator(".agent-file-where").isVisible(), false, "where it is kept waits for Technical");
  assert.equal(await card.getByRole("button", { name: /^Save/ }).count(), 0, "no Save: the switches save as you go");
  assert.equal(await card.locator(".agent-files-foot").isVisible(), true);
  const group = soul.getByRole("group", { name: "Use SOUL.md" });
  assert.equal(await group.getByRole("button", { name: "Off", exact: true }).getAttribute("aria-pressed"), "true");
  await group.getByRole("button", { name: "When needed", exact: true }).click();
  await card.locator("[role=status]", { hasText: "Saved" }).waitFor();
  assert.equal(contextFileSettings(app.store, app.runtime.owner).files.soul, "when-needed");
  await card.locator(".agent-file", { hasText: "SOUL.md" }).getByRole("button", { name: "When needed", exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
  /* It is the file's one switch: the Assistant page only links here (DG-181). */
  assert.equal(await page.locator("#context-switch-soul").count(), 0);
  await card.locator(".agent-file", { hasText: "SOUL.md" }).getByRole("button", { name: "Edit SOUL.md" }).click();
  await card.getByLabel("What the file says").waitFor();
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await card.getByRole("button", { name: "Back to all files" }).click();
  assert.equal(await card.locator(".agent-file", { hasText: "SOUL.md" }).locator(".agent-file-where").isVisible(), true);
  await page.evaluate(() => globalThis.branchSettingsLevel.set("regular"));
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.locator("#agent-files .agent-files-foot", { hasText: "Chaque fichier" }).waitFor();
  await page.waitForFunction(() => document.querySelector("#lx-page-instructions .lx-page-title")?.textContent !== "Instructions & personality");
  const french = await seen(page);
  assert.equal(french.length, 2, french.join(" · "));
  assert.equal(french[1], "Ses fichiers");
  assert.equal(await card.locator(".agent-file", { hasText: "SOUL.md" }).getByRole("button", { name: "Modifier SOUL.md" }).innerText(), "Modifier");
  assert.equal(await card.locator(".agent-file", { hasText: "USER.md" }).locator(".agent-file-first").innerText(), "Vide");
  assert.deepEqual(errors, []);
});

test("DG-182: the list gives each file's first line to the owner only", async (t) => {
  const { server } = await fixture(t);
  const response = await fetch(server.url + "/api/settings-kit/files", { headers: { authorization: `Bearer ${server.token}` } });
  const { files } = await response.json();
  assert.equal(files.find((entry) => entry.slot === "soul").first, "You are Branch, a calm and practical assistant.");
  assert.equal(files.find((entry) => entry.slot === "user").first, "");
  const stranger = await fetch(server.url + "/api/settings-kit/files", { headers: { authorization: "Bearer wrong" } });
  assert.notEqual(stranger.status, 200);
});

test("DG-182: each file's mode buttons read Off / When needed / On, and on fresh install Off is pressed", async (t) => {
  const { browser, server } = await fixture(t);
  const { page, errors } = await connect(browser, server, 1440);
  await openAtLevel(page);
  const card = page.locator("#agent-files");

  /* For slots soul, identity and user, check the button texts are ["Off", "When needed", "On"]. */
  for (const slot of ["soul", "identity", "user"]) {
    const buttons = await card.locator(`.agent-file[data-slot="${slot}"] .agent-file-mode button`).allInnerTexts();
    assert.deepEqual(buttons, ["Off", "When needed", "On"], `${slot} buttons in English`);
  }

  /* On fresh install Off has aria-pressed="true". */
  for (const slot of ["soul", "identity", "user"]) {
    const offButton = card.locator(`.agent-file[data-slot="${slot}"] .agent-file-mode button`, { hasText: "Off", exact: true });
    assert.equal(await offButton.getAttribute("aria-pressed"), "true", `${slot} Off is pressed on fresh install`);
  }

  /* After switching to French, the buttons show French text. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.locator("#agent-files .agent-files-foot", { hasText: "Chaque fichier" }).waitFor();
  for (const slot of ["soul", "identity", "user"]) {
    const buttons = await card.locator(`.agent-file[data-slot="${slot}"] .agent-file-mode button`).allInnerTexts();
    assert.deepEqual(buttons, ["Désactivé", "Au besoin", "Activé"], `${slot} buttons in French`);
  }

  assert.deepEqual(errors, []);
  await page.close();
});

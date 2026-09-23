/**
 * The assistant's own files in Settings › Instructions & personality, with
 * an editor dialog with a preview, the size limit Branch reads, and a History of earlier saves (DG-182). The owner's alone:
 * a household profile and a short-lived key are refused the text and every change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function served(t) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "assistant-files-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, call, root };
}

test("F1 each save here keeps what the file held before in its History, newest first, and ten at most", async (t) => {
  const { app, call } = await served(t);
  const soul = join(app.store.folder, "SOUL.md");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be brief." })).status, 200);
  assert.equal(await readFile(soul, "utf8"), "Be brief.\n");
  assert.deepEqual((await call("GET", "/api/settings-kit/files/soul")).body.history, [], "a file the save made had nothing before it");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be very brief." })).status, 200);
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be very brief." })).status, 200);
  const opened = (await call("GET", "/api/settings-kit/files/soul")).body;
  assert.deepEqual(opened.history.map((version) => version.text), ["Be brief.\n"], "saving the same words again keeps nothing new");
  assert.ok(!Number.isNaN(Date.parse(opened.history[0].at)));
  assert.equal(opened.where, soul);
  for (let index = 0; index < 12; index += 1) await call("POST", "/api/settings-kit/files", { slot: "soul", text: `Version ${index}.` });
  const history = (await call("GET", "/api/settings-kit/files/soul")).body.history;
  assert.equal(history.length, 10);
  assert.equal(history[0].text, "Version 10.\n", "the newest first");
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "soul" })).status, 404, "History replaced the one undo");
});

test("F2 the size limit holds", async (t) => {
  const { call } = await served(t);
  const long = await call("POST", "/api/settings-kit/files", { slot: "soul", text: "x".repeat(8001) });
  assert.equal(long.status, 400);
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.limit, 8000);
});

test("F3 a household profile and a short-lived key get neither the text, its History nor a draft", async (t) => {
  const { app, call } = await served(t);
  const first = await call("POST", "/api/settings-kit/files", { slot: "memory", text: "The NAS backs up at two." });
  assert.equal(first.status, 200, first.body.error);
  await call("POST", "/api/settings-kit/files", { slot: "memory", text: "The NAS backs up at three." });
  const run = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("GET", "/api/settings-kit/files/memory", undefined, run)).status, 401);
  assert.equal((await call("POST", "/api/settings-kit/files/draft", { slot: "agents" }, run)).status, 401);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const read = await call("GET", "/api/settings-kit/files/memory");
  assert.equal(read.status, 400);
  assert.ok(!JSON.stringify(read.body).includes("NAS"), "not a word of the file or its History reaches a household person");
  assert.equal((await call("POST", "/api/settings-kit/files/draft", { slot: "agents" })).status, 400);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  const owners = await call("GET", "/api/settings-kit/files/memory");
  assert.equal(owners.body.history[0].text, "The NAS backs up at two.\n", "the owner still can");
  const tools = [...app.runtime.registry?.list?.() ?? []].map((tool) => tool.name ?? tool);
  assert.ok(!tools.some((name) => /context\.(write|save|edit)/.test(name)), "no tool writes these files, so no chat app can");
});

test("F3b Write it for me drafts AGENTS.md from this workspace without writing it, and only for AGENTS.md", async (t) => {
  const { app, call } = await served(t);
  await writeFile(join(app.runtime.workspace, "package.json"), JSON.stringify({ name: "shop-notes", scripts: { build: "tsc", test: "node --test" } }));
  const drafted = await call("POST", "/api/settings-kit/files/draft", { slot: "agents" });
  assert.equal(drafted.status, 200, drafted.body.error);
  assert.match(drafted.body.text, /^# shop-notes/);
  assert.match(drafted.body.text, /npm run build/);
  assert.equal(existsSync(join(app.runtime.workspace, "AGENTS.md")), false, "a draft is only handed back");
  assert.equal((await call("POST", "/api/settings-kit/files/draft", { slot: "soul" })).status, 400);
});

test("F4 the editor dialog: a starter, the text beside its preview, History with Put this back, Cancel and Save", async (t) => {
  const { app, server, call } = await served(t);
  await call("POST", "/api/settings-kit/files", { slot: "heartbeat", text: "# Before" });
  await call("POST", "/api/settings-kit/files", { slot: "heartbeat", text: "# Now" });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
    await openSettings(page, "instructions");
    const card = page.locator("#agent-files");
    assert.equal(await page.locator('.lx-settings-link[data-page="instructions"]').getAttribute("aria-current"), "true");
    assert.equal(await card.evaluate((node) => node.closest(".lx-page")?.id), "lx-page-instructions");
    assert.equal(await card.locator(".agent-file").count(), 8);
    await card.getByRole("button", { name: "Edit HEARTBEAT.md" }).click();
    const dialog = page.getByRole("dialog", { name: /^HEARTBEAT\.md — / });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((node) => node.matches(":modal")), true, "a dialog, not an editor in the list");
    assert.equal(await dialog.locator(".agent-file-dialog-about").innerText(), "What it checks on by itself when it wakes on a schedule.");
    const text = dialog.getByLabel("What the file says");
    const current = await readFile(join(app.runtime.workspace, "HEARTBEAT.md"), "utf8");
    assert.equal(await text.inputValue(), current);
    await dialog.getByLabel("Start from a starter").selectOption("usual");
    assert.match(await text.inputValue(), /On each scheduled wake/);
    await dialog.getByLabel("Start from a starter").selectOption("blank");
    assert.equal(await text.inputValue(), "# HEARTBEAT\n\n");
    assert.equal(await dialog.getByRole("button", { name: "Write it for me" }).count(), 0, "drafting is for AGENTS.md");
    await text.fill("# Morning\n\n- Is the backup done?");
    const preview = dialog.locator(".agent-files-preview");
    const heading = preview.locator("h1, h2, h3", { hasText: "Morning" }).first();
    if (width > 760) {
      assert.equal(await heading.isVisible(), true, "the preview sits beside the text");
      assert.equal(await dialog.getByRole("button", { name: "Preview", exact: true }).isVisible(), false, "wide: no tabs");
    }
    else {
      assert.equal(await preview.isVisible(), false, "narrow: one at a time");
      await dialog.getByRole("button", { name: "Preview", exact: true }).click();
      await heading.waitFor();
      await dialog.getByRole("button", { name: "Write", exact: true }).click();
    }
    assert.equal(await dialog.locator("#agent-files-size").isVisible(), false, "no counter until the text is too long");
    await text.fill("x".repeat(8001));
    assert.match(await dialog.locator("#agent-files-size").innerText(), /of 8,000 bytes/);
    assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).isDisabled(), true, "too long cannot be saved");
    await dialog.locator(".agent-file-history summary").click();
    assert.match(await dialog.locator(".agent-file-history summary").innerText(), /^History \(\d+\)$/);
    await dialog.locator(".agent-file-version").last().getByRole("button", { name: /^Put back the version from / }).click();
    assert.equal(await text.inputValue(), "# Before\n");
    await dialog.getByRole("status").filter({ hasText: "Save to keep it" }).waitFor();
    assert.equal(await readFile(join(app.runtime.workspace, "HEARTBEAT.md"), "utf8"), current, "Put this back only fills the editor");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await card.getByRole("button", { name: "Edit HEARTBEAT.md" }).click();
    await dialog.getByLabel("What the file says").fill(`Check the backup at ${width}.`);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await card.locator(".agent-files-status", { hasText: "Saved" }).waitFor();
    assert.equal(await readFile(join(app.runtime.workspace, "HEARTBEAT.md"), "utf8"), `Check the backup at ${width}.\n`);
    assert.equal(await card.locator(".agent-file", { hasText: "HEARTBEAT.md" }).locator(".agent-file-first").innerText(), `Check the backup at ${width}.`, "the list is drawn again");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("F4a Write it for me fills the AGENTS.md editor with the workspace's draft, in French too", async (t) => {
  const { app, server } = await served(t);
  await writeFile(join(app.runtime.workspace, "package.json"), JSON.stringify({ name: "shop-notes", scripts: { test: "node --test" } }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  await openSettings(page, "instructions");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.locator("#agent-files .agent-files-foot", { hasText: "Chaque fichier" }).waitFor();
  await page.locator("#agent-files").getByRole("button", { name: "Modifier AGENTS.md" }).click();
  const dialog = page.getByRole("dialog", { name: /^AGENTS\.md — / });
  await dialog.getByRole("button", { name: "L’écrire pour moi" }).click();
  await dialog.getByRole("status").filter({ hasText: "Relisez-le avant d’enregistrer" }).waitFor();
  assert.match(await dialog.getByRole("textbox").inputValue(), /^# shop-notes/);
  assert.equal(existsSync(join(app.runtime.workspace, "AGENTS.md")), false, "nothing is written until Save");
  assert.equal(await dialog.locator(".agent-file-history summary").innerText(), "Historique (0)");
  assert.equal(await dialog.getByRole("button", { name: "Annuler", exact: true }).isVisible(), true);
  assert.equal(await dialog.getByRole("button", { name: "Enregistrer", exact: true }).isVisible(), true);
  assert.equal(await dialog.getByRole("button", { name: "Fermer" }).isVisible(), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
});

test("F4b switching profiles clears an open owner-only editor before it can be read", async (t) => {
  const { server, call } = await served(t);
  const privateText = "The private backup phrase is owner-only.";
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "memory", text: privateText })).status, 200);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  await openSettings(page, "appearance");
  assert.equal(await page.locator("#lx-page-appearance .lx-page-intro").innerText(),
    "Every KeepOak theme, light or dark, with the oak in any season. Changes show behind this window as you pick.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await page.locator("#lx-page-appearance .lx-page-intro").innerText(),
    "Tous les thèmes KeepOak, clairs ou sombres, avec le chêne à chaque saison. Les changements s’affichent derrière cette fenêtre au fil de vos choix.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await openSettings(page, "instructions");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await page.locator("#lx-page-instructions .lx-page-intro").innerText(),
    "Les fichiers simples que votre assistant lit avant de travailler : qui il est, qui vous êtes, comment vous voulez que le travail soit fait. Ils fonctionnent de la même manière que dans d'autres agents, donc un fichier écrit pour l'un d'eux fonctionne ici.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#agent-files").getByRole("button", { name: "Edit MEMORY.md" }).click();
  assert.equal(await page.getByLabel("What the file says").inputValue(), `${privateText}\n`);

  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  await page.waitForFunction(() => document.documentElement.dataset.household === "on");
  const householdView = await page.evaluate((privateValue) => {
    const instructions = document.querySelector('.lx-settings-link[data-page="instructions"]');
    const instructionsPage = document.getElementById("lx-page-instructions");
    return {
      editorCount: document.querySelectorAll("#agent-files").length,
      privateTextVisible: document.body.innerText.includes(privateValue),
      instructionsHidden: instructions.hidden || getComputedStyle(instructions).display === "none",
      tabShown: document.querySelector('.lx-settings-link[data-page="instructions"]').checkVisibility(),
      pageHidden: instructionsPage.hidden || getComputedStyle(instructionsPage).display === "none",
      generalCurrent: document.querySelector('.lx-settings-link[data-page="general"]').getAttribute("aria-current"),
    };
  }, privateText);
  assert.deepEqual(householdView, {
    editorCount: 0,
    privateTextVisible: false,
    instructionsHidden: true,
    tabShown: false,
    pageHidden: true,
    generalCurrent: "true",
  });

  const guardedRoute = await page.evaluate(() => {
    globalThis.branchLayout.go("settings:instructions");
    return {
      instructionsHidden: document.getElementById("lx-page-instructions").hidden,
      generalCurrent: document.querySelector('.lx-settings-link[data-page="general"]').getAttribute("aria-current"),
    };
  });
  assert.deepEqual(guardedRoute, { instructionsHidden: true, generalCurrent: "true" });

  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  await page.waitForFunction(() => document.documentElement.dataset.household === "off");
  await page.locator("#agent-files").waitFor({ state: "attached" });
  assert.equal(await page.locator('.lx-settings-link[data-page="instructions"]').isVisible(), true);
  assert.equal(await page.locator('.lx-settings-link[data-page="instructions"]').evaluate((node) => node.checkVisibility()), true);
});

// DG-182: History belongs to the file Branch reads today, and the kept texts never reach the diagnostics summary.
test("F5 History is only offered for the file Branch reads today, and the diagnostics summary holds no text", async (t) => {
  const { app, call } = await served(t);
  const { settingsSummary } = await import("../dist/diagnostic-api.js");
  await writeFile(join(app.store.folder, "SOUL.md"), "calm");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be kind." })).status, 200);
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.history[0].text, "calm");
  assert.ok(!JSON.stringify(settingsSummary(app)).includes("calm"), "the text before a save is not in the diagnostics summary");
  // A SOUL.md now in the project is the one Branch reads, so the saved one's History is not this file's.
  await writeFile(join(app.runtime.workspace, "SOUL.md"), "Project soul.\n");
  const moved = (await call("GET", "/api/settings-kit/files/soul")).body;
  assert.equal(moved.where, join(app.runtime.workspace, "SOUL.md"));
  assert.deepEqual(moved.history, []);
});

/**
 * The assistant's own files in Settings › Instructions & personality, with
 * an editor, a preview, the size limit Branch reads, and an undo of the last save. The owner's alone:
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

test("F1 undo puts back the text before the last save, and removes a file the save made", async (t) => {
  const { app, call } = await served(t);
  const soul = join(app.store.folder, "SOUL.md");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be brief." })).status, 200);
  assert.equal(await readFile(soul, "utf8"), "Be brief.\n");
  assert.ok((await call("GET", "/api/settings-kit/files/soul")).body.lastSave, "a save here can be undone");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be very brief." })).status, 200);
  const undone = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(undone.status, 200);
  assert.equal(await readFile(soul, "utf8"), "Be brief.\n", "only the last save is undone");
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.lastSave, null, "one undo, then nothing waits");
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "soul" })).status, 409);
  await call("POST", "/api/settings-kit/files", { slot: "user", text: "Call me Taofik." });
  assert.ok(existsSync(join(app.store.folder, "USER.md")));
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "user" })).status, 200);
  assert.equal(existsSync(join(app.store.folder, "USER.md")), false, "a file the save made is taken away again");
});

test("F2 a change made elsewhere since the save is never overwritten, and the size limit holds", async (t) => {
  const { app, call } = await served(t);
  await call("POST", "/api/settings-kit/files", { slot: "soul", text: "First." });
  await writeFile(join(app.store.folder, "SOUL.md"), "Changed in another editor.\n");
  const refused = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /changed after it was saved here/);
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "Changed in another editor.\n");
  const long = await call("POST", "/api/settings-kit/files", { slot: "soul", text: "x".repeat(8001) });
  assert.equal(long.status, 400);
  assert.equal((await call("GET", "/api/settings-kit/files/soul")).body.limit, 8000);
});

test("F3 a household profile and a short-lived key get neither the text nor the undo", async (t) => {
  const { app, call } = await served(t);
  const first = await call("POST", "/api/settings-kit/files", { slot: "memory", text: "The NAS backs up at two." });
  assert.equal(first.status, 200, first.body.error);
  const run = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("GET", "/api/settings-kit/files/memory", undefined, run)).status, 401);
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "memory" }, run)).status, 401);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const read = await call("GET", "/api/settings-kit/files/memory");
  assert.equal(read.status, 400);
  assert.ok(!JSON.stringify(read.body).includes("NAS"), "not a word of the file reaches a household person");
  assert.equal((await call("POST", "/api/settings-kit/files/undo", { slot: "memory" })).status, 400);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  const owners = await call("POST", "/api/settings-kit/files/undo", { slot: "memory" });
  assert.equal(owners.status, 200, `the owner still can: ${owners.body.error}`);
  const tools = [...app.runtime.registry?.list?.() ?? []].map((tool) => tool.name ?? tool);
  assert.ok(!tools.some((name) => /context\.(write|save|edit)/.test(name)), "no tool writes these files, so no chat app can");
});

test("F4 the card: eight files, an editor with a preview and a counter, Save, and Undo the last save", async (t) => {
  const { app, server } = await served(t);
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
    await card.getByRole("button", { name: "Change HEARTBEAT.md here" }).click();
    const text = card.getByLabel("What the file says");
    await card.getByRole("button", { name: "Start from the usual shape" }).click();
    assert.match(await text.inputValue(), /On each scheduled wake/);
    await text.fill("# Morning\n\n- Is the backup done?");
    assert.match(await card.locator("#agent-files-size").innerText(), /of 8,000 bytes/);
    await card.getByRole("button", { name: "Preview" }).click();
    await card.locator(".agent-files-preview h1, .agent-files-preview h2, .agent-files-preview h3", { hasText: "Morning" }).first().waitFor();
    await card.getByRole("button", { name: "Write" }).click();
    await text.fill("x".repeat(8001));
    assert.equal(await card.getByRole("button", { name: "Save this file" }).isDisabled(), true, "too long cannot be saved");
    await text.fill(`# Morning ${width}`);
    await card.getByRole("button", { name: "Save this file" }).click();
    await card.locator("[role=status]", { hasText: "Saved" }).waitFor();
    assert.equal(await readFile(join(app.runtime.workspace, "HEARTBEAT.md"), "utf8"), `# Morning ${width}\n`);
    await card.getByRole("button", { name: "Undo the last save" }).click();
    await card.locator("[role=status]", { hasText: "undone" }).waitFor();
    assert.equal(existsSync(join(app.runtime.workspace, "HEARTBEAT.md")), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
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
  await openSettings(page, "instructions");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await page.locator("#lx-page-instructions .lx-page-intro").innerText(),
    "Les fichiers simples que Branch lit avant de travailler : qui il est, qui vous êtes et comment vous voulez que le travail soit fait.");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#agent-files").getByRole("button", { name: "Change MEMORY.md here" }).click();
  assert.equal(await page.getByLabel("What the file says").inputValue(), `${privateText}\n`);

  await page.evaluate(() => {
    document.documentElement.dataset.household = "on";
    document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: false } }));
  });
  assert.equal(await page.locator("#agent-files").count(), 0);
  assert.equal((await page.locator("body").innerText()).includes(privateText), false);
  assert.equal(await page.locator('.lx-settings-link[data-page="instructions"]').isHidden(), true);
  assert.equal(await page.locator('#sg-page-pick option[value="instructions"]').evaluate((node) => node.disabled), true);
  assert.equal(await page.locator("#lx-page-instructions").isHidden(), true);
  assert.equal(await page.locator('.lx-settings-link[data-page="general"]').getAttribute("aria-current"), "true");

  await page.evaluate(() => {
    document.documentElement.dataset.household = "off";
    document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: true } }));
  });
  await page.locator("#agent-files").waitFor({ state: "attached" });
  assert.equal(await page.locator('.lx-settings-link[data-page="instructions"]').isVisible(), true);
  assert.equal(await page.locator('#sg-page-pick option[value="instructions"]').evaluate((node) => node.disabled), false);
});

// Integration review: undo re-checks where the file is and whether it may be written, and the saved
// texts never reach the diagnostics summary.
test("F5 undo refuses once the file moved or its folder lost trust, and the diagnostics summary holds no text", async (t) => {
  const { app, call } = await served(t);
  const { settingsSummary } = await import("../dist/diagnostic-api.js");
  const { saveFolderTrustSettings, decideFolder } = await import("../dist/folder-trust.js");
  await writeFile(join(app.store.folder, "SOUL.md"), "calm");
  assert.equal((await call("POST", "/api/settings-kit/files", { slot: "soul", text: "Be kind." })).status, 200);
  assert.ok(!JSON.stringify(settingsSummary(app)).includes("calm"), "the text before a save is not in the diagnostics summary");
  // A SOUL.md now in the project is the one Branch reads, so the saved one is no longer "this file".
  await writeFile(join(app.runtime.workspace, "SOUL.md"), "Project soul.\n");
  const moved = await call("POST", "/api/settings-kit/files/undo", { slot: "soul" });
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, /no longer where it was saved/);
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "Be kind.\n");
  assert.equal(await readFile(join(app.runtime.workspace, "SOUL.md"), "utf8"), "Project soul.\n");
  // A project file saved while the folder was trusted is not put back after the owner distrusts it.
  const saved = await call("POST", "/api/settings-kit/files", { slot: "tools", text: "Use the NAS." });
  assert.equal(saved.status, 200, saved.body.error);
  saveFolderTrustSettings(app.store, app.runtime.owner, { mode: "on" });
  decideFolder(app.store, app.runtime.owner, app.runtime.workspace, { folder: "", decision: "distrust" });
  const distrusted = await call("POST", "/api/settings-kit/files/undo", { slot: "tools" });
  assert.equal(distrusted.status, 409);
  assert.equal(await readFile(join(app.runtime.workspace, "TOOLS.md"), "utf8"), "Use the NAS.\n", "nothing written in a folder that is not trusted");
});

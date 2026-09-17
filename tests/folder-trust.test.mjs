import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  assistantFolderItems, createBranch, folderAllows, decideFolder, discoverFolder, folderContains, folderTrust, folderTrustMode,
  isFolderTrusted, needsAnswer, nothingFound, presetRules, PolicySchema, saveFolderTrustSettings, trustCappedPolicy,
  workspaceFolder,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, files = {}, steps = [{ content: "ok", toolCalls: [] }]) {
  const root = await mkdtemp(join(tmpdir(), "branch-trust-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), text);
  }
  const provider = { name: "scripted", calls: 0, async complete() { return steps[Math.min(provider.calls++, steps.length - 1)]; } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace, provider, owner: app.runtime.owner };
}

test("a folder covers what is inside it, and only Windows ignores letter case", () => {
  assert.equal(folderContains("/w/a", "/w/a", "linux"), true);
  assert.equal(folderContains("/w/a", "/w/a/b/c", "darwin"), true);
  assert.equal(folderContains("/w/a", "/w/ab", "linux"), false, "a sibling whose name starts the same is not inside");
  assert.equal(folderContains("/w/a/b", "/w/a", "linux"), false);
  assert.equal(folderContains("/w/A", "/w/a", "linux"), false);
  assert.equal(folderContains("C:\\Work\\Proj", "c:\\work\\proj\\src", "win32"), true);
  assert.equal(folderContains("C:\\Work\\Proj", "C:\\Work\\Project", "win32"), false);
});

test("the closest decision wins, and a folder nobody decided about is not trusted", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  assert.equal(folderTrust(app.store, owner, workspace), "unknown");
  decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
  decideFolder(app.store, owner, workspace, { folder: "downloads", decision: "distrust" });
  decideFolder(app.store, owner, workspace, { folder: "downloads/mine", decision: "trust" });
  assert.equal(folderTrust(app.store, owner, join(workspace, "src")), "trusted");
  assert.equal(folderTrust(app.store, owner, join(workspace, "downloads", "x")), "untrusted");
  assert.equal(folderTrust(app.store, owner, join(workspace, "downloads", "mine", "y")), "trusted");
  assert.equal(folderTrust(app.store, owner, join(dirname(workspace), "elsewhere")), "unknown");
  // Changing an answer replaces it rather than adding a second one.
  decideFolder(app.store, owner, workspace, { folder: "downloads/", decision: "trust" });
  assert.equal(folderTrust(app.store, owner, join(workspace, "downloads", "x")), "trusted");
  assert.equal(app.store.get("settings", owner, "folder_trust").data.folders.length, 3);
  const written = app.store.audit.list(owner, { action: "policy.changed", limit: 50 });
  assert.ok(written.some((entry) => entry.subject.startsWith("Folder not trusted:")), "each answer is in the record");
});

test("only folders inside the workspace can be decided about", async (t) => {
  const { app, workspace, owner } = await fixture(t);
  for (const folder of ["../other", "a/../../b", "/etc", "C:\\Windows"])
    assert.throws(() => decideFolder(app.store, owner, workspace, { folder, decision: "trust" }), /inside the workspace/, folder);
  assert.throws(() => decideFolder(app.store, owner, workspace, { folder: "", decision: "maybe" }));
  assert.equal(workspaceFolder(workspace, "a\\b"), join(workspace, "a", "b"));
});

test("an untrusted folder always asks before a change, and a rule can only tighten", () => {
  const off = PolicySchema.parse({});
  const capped = trustCappedPolicy(off, "untrusted");
  assert.deepEqual(capped.rules, presetRules("ask-before-changes"), "even with approvals switched off");
  const custom = PolicySchema.parse({ preset: "custom", rules: [
    { tool: "files.write", decision: "allow" }, { tool: "shell.execute", decision: "deny" }, { tool: "web.*", decision: "ask" },
  ] });
  const tightened = trustCappedPolicy(custom, "untrusted");
  assert.deepEqual(tightened.rules.map((rule) => `${rule.tool}:${rule.decision}`), ["shell.execute:deny", "web.*:ask", "*:ask"]);
  assert.equal(trustCappedPolicy(custom, "trusted"), custom);
  assert.equal(trustCappedPolicy(custom, "unknown"), custom, "not deciding changes nothing about approvals");
  assert.equal(trustCappedPolicy(off, "untrusted", "off"), off, "with the switch off nothing is tightened");
  assert.deepEqual(trustCappedPolicy(off, "untrusted", "when-needed").rules, presetRules("ask-before-changes"));
});

test("a task in a folder the owner does not trust waits for a yes before writing", async (t) => {
  const write = { id: "w1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "hi" }) };
  const { app, workspace, owner, provider } = await fixture(t, {}, [{ content: "", toolCalls: [write] }, { content: "done", toolCalls: [] }]);
  decideFolder(app.store, owner, workspace, { folder: "", decision: "distrust" });
  // Switched off (the default), the answer is kept but nothing is held back.
  const before = await app.runtime.run({ prompt: "write" });
  assert.equal(before.status, "completed", before.output);
  await rm(join(workspace, "notes.txt"));
  provider.calls = 0;
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  const paused = await app.runtime.run({ prompt: "write" });
  assert.equal(paused.status, "needs_input", paused.output);
  await assert.rejects(readFile(join(workspace, "notes.txt"), "utf8"));
  decideFolder(app.store, owner, workspace, { folder: "", decision: "trust" });
  provider.calls = 0;
  const done = await app.runtime.run({ prompt: "write" });
  assert.equal(done.status, "completed", done.output);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "hi");
});

test("a task in an undecided folder that holds something writes that down for the owner, once", async (t) => {
  const { app, owner } = await fixture(t, { "AGENTS.md": "a", ".mcp.json": JSON.stringify({ mcpServers: { x: {} } }) });
  const noted = (run) => app.store.events(run.id).filter((event) => event.kind === "folder.trust_needed");
  assert.deepEqual(noted(await app.runtime.run({ prompt: "hi" })), [], "nothing while it is off");
  saveFolderTrustSettings(app.store, owner, { mode: "when-needed" });
  const [event] = noted(await app.runtime.run({ prompt: "hi" }));
  assert.deepEqual(event.data.instructions, ["AGENTS.md"]);
  assert.deepEqual(event.data.aiToolServers, ["x"]);
  assert.deepEqual(noted(await app.runtime.run({ prompt: "hi" })), [], "asked once per launch, not every task");
});

test("what a folder carries is listed without loading any of it", async (t) => {
  const { workspace } = await fixture(t, {
    "AGENTS.md": "a", "src/CLAUDE.md": "b", "node_modules/pkg/AGENTS.md": "skipped", "src/agents.md": "listed whatever the case",
    ".mcp.json": JSON.stringify({ mcpServers: { github: {}, filesystem: {} } }),
    ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [] } }),
    ".gemini/settings.json": "not json",
    ".agents/skills/review/SKILL.md": "x",
    "docs/SOUL.md": "listed, never opened", ".hermes.md": "x", "AGENTS.override.md": "x",
    ".vscode/mcp.json": JSON.stringify({ servers: { local: {} } }),
    ".gemini/extensions/helper/gemini-extension.json": "{}",
  });
  const found = await discoverFolder(workspace);
  assert.deepEqual(found.instructions.sort(), [".hermes.md", "AGENTS.md", "AGENTS.override.md", "docs/SOUL.md", "src/CLAUDE.md", "src/agents.md"]);
  assert.deepEqual(found.aiToolServers, ["github", "filesystem", "local"]);
  assert.deepEqual(found.plugins, [".gemini/extensions/helper"]);
  assert.deepEqual(found.hooks, ["PreToolUse"]);
  assert.deepEqual(found.skills, [".agents/skills/review"]);
  assert.equal(nothingFound(found), false);
  assert.equal(nothingFound(await discoverFolder(join(workspace, "missing"))), true);
});

test("a skills folder that is a link is not looked into", { skip: process.platform === "win32" }, async (t) => {
  const { root, workspace } = await fixture(t);
  await mkdir(join(root, "elsewhere", "planted"), { recursive: true });
  await mkdir(join(workspace, ".claude"), { recursive: true });
  await symlink(join(root, "elsewhere"), join(workspace, ".claude", "skills"));
  assert.deepEqual((await discoverFolder(workspace)).skills, []);
});

test("one list says what counts as something for AI assistants", () => {
  for (const name of ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "GEMINI.md", ".hermes.md", "SOUL.md", "USER.md",
    "IDENTITY.md", "MEMORY.md", "HEARTBEAT.md", "TOOLS.md", "SOP.md"])
    assert.ok(assistantFolderItems.notes.includes(name), name);
  assert.ok(assistantFolderItems.toolServers.some(([file]) => file === ".mcp.json"));
  assert.ok(assistantFolderItems.skills.length && assistantFolderItems.hooks.length && assistantFolderItems.plugins.length);
  assert.throws(() => assistantFolderItems.notes.push("X.md"), "the list cannot be changed by whoever imports it");
});

test("off / on / when needed decide whether a loader may read a folder", async (t) => {
  const { app, workspace, owner } = await fixture(t, { "notes/AGENTS.md": "a", "empty/readme.txt": "b" });
  const notes = join(workspace, "notes"), empty = join(workspace, "empty"), refused = join(workspace, "refused");
  decideFolder(app.store, owner, workspace, { folder: "refused", decision: "distrust" });
  assert.equal(folderTrustMode(app.store, owner), "off", "ships off");
  for (const path of [notes, empty, refused]) assert.equal(await isFolderTrusted(app.store, owner, path), true, `off: ${path}`);
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  assert.deepEqual(await Promise.all([notes, empty, refused].map((path) => isFolderTrusted(app.store, owner, path))), [false, false, false]);
  saveFolderTrustSettings(app.store, owner, { mode: "when-needed" });
  assert.deepEqual(await Promise.all([notes, empty, refused].map((path) => isFolderTrusted(app.store, owner, path))), [false, true, false]);
  decideFolder(app.store, owner, workspace, { folder: "notes", decision: "trust" });
  assert.equal(await isFolderTrusted(app.store, owner, notes), true);
  assert.equal(await app.runtime.guards.isFolderTrusted(notes), true, "the runtime offers the same check");
  // Without looking at the disk: a loader that has found a file gets the strict answer.
  assert.equal(folderAllows(app.store, owner, empty), false);
  assert.equal(folderAllows(app.store, owner, empty, false), true);
  assert.equal(folderAllows(app.store, owner, notes), true);
  assert.equal(folderAllows(app.store, owner, refused, false), false);
  const some = await discoverFolder(join(workspace, "missing"));
  assert.equal(needsAnswer("off", "unknown", some), false);
  assert.equal(needsAnswer("on", "unknown", some), true);
  assert.equal(needsAnswer("when-needed", "unknown", some), false);
  assert.equal(needsAnswer("on", "trusted", some), false);
  assert.throws(() => saveFolderTrustSettings(app.store, owner, { mode: "sometimes" }));
});

test("the trust screen lists each folder, takes an answer, and refuses a short-lived key", async (t) => {
  const { app, root, workspace, owner } = await fixture(t, { "AGENTS.md": "a" });
  app.store.projects.save(owner, { id: "site", name: "Site", folder: "site" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, body, token = server.token) => {
    const response = await fetch(server.url + "/api/folder-trust", { method,
      headers: { authorization: `Bearer ${token}`, host: new URL(server.url).host, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const offView = await call("GET");
  assert.equal(offView.body.mode, "off");
  assert.deepEqual(offView.body.folders.map((folder) => folder.needsAnswer), [false, false], "nobody is asked while it is off");
  assert.equal((await call("POST", { mode: "when-needed" }, (app.sessionTokens.create(owner, { scope: "run", minutes: 5 })).token)).status, 401);
  assert.equal((await call("POST", { mode: "when-needed" })).body.mode, "when-needed");
  const first = await call("GET");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.folders.map((folder) => [folder.folder, folder.trust, folder.needsAnswer]),
    [["", "unknown", true], ["site", "unknown", false]]);
  assert.equal(first.body.folders[0].path, workspace);
  assert.match(first.body.folders[1].label, /"Site" project/);
  assert.deepEqual(first.body.folders.map((folder) => folder.project), [null, "Site"]);

  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 });
  const refused = await call("POST", { folder: "", decision: "trust" }, key.token);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /cannot change which folders are trusted/);
  assert.equal(folderTrust(app.store, owner, workspace), "unknown");

  const answered = await call("POST", { folder: "", decision: "trust" });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body.folders.map((folder) => folder.trust), ["trusted", "trusted"]);
  assert.equal((await call("POST", { folder: "../up", decision: "trust" })).status, 400);
  const script = await fetch(server.url + "/folder-trust.js");
  assert.equal(script.status, 200);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="\/folder-trust\.js" type="module"><\/script>/);
});

/**
 * Opens the screen these cards live on. The one place a test finds its way there, so it can move
 * to tests/places.mjs (openSettingFor) when the redesigned window lands.
 */
async function openSettings(page) {
  const nav = page.locator('.nav[data-view="settings"]').first();
  if (!(await nav.isVisible())) await page.locator("#rail-toggle").click();
  await nav.click();
  await page.evaluate(() => document.body.classList.remove("rail-open"));
}

test("with both switches off (as shipped) both cards are still there to turn them on", async (t) => {
  const { chromium } = await import("playwright");
  const { app, root } = await fixture(t, { "AGENTS.md": "a" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await openSettings(page);
  for (const id of ["folder-trust-card", "loop-guard-card"]) {
    await page.locator(`#${id}`).waitFor({ state: "attached" });
    assert.equal(await page.locator(`#${id}`).getAttribute("data-home"), "settings:permissions");
  }
  assert.equal(await page.locator("#folder-trust-mode").inputValue(), "off");
  assert.equal(await page.locator("#loop-guard-mode").inputValue(), "off");
  assert.equal(await page.locator("#folder-trust-ask").count(), 0, "nobody is asked while it is off");
});

test("the chat screen asks once, the answer sticks, and Settings shows it", async (t) => {
  const { chromium } = await import("playwright");
  const deep = "folderwithaverylongnameandnowheretobreakit".repeat(4); // no spaces or hyphens to wrap at
  const { app, root, workspace: top, owner } = await fixture(t, { [`${deep}/AGENTS.md`]: "a", [`${deep}/.mcp.json`]: JSON.stringify({ mcpServers: { planted: {} } }) });
  app.store.projects.save(owner, { id: "deep", name: "Deep", folder: deep });
  const workspace = join(top, deep);
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  const ask = page.locator("#folder-trust-ask");
  await ask.waitFor({ state: "attached" });
  assert.match(await ask.textContent(), /Do you trust this folder\?[\s\S]*Your workspace holds[\s\S]*AGENTS\.md/);
  const settings = page.locator("#folder-trust-card");
  assert.match(await settings.textContent(), /Trusted folders[\s\S]*Not decided yet[\s\S]*The folder of the “Deep” project[\s\S]*planted/);
  await ask.getByRole("button", { name: "Don't trust it", exact: true }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(folderTrust(app.store, owner, workspace), "untrusted");
  await page.waitForFunction(() => document.getElementById("folder-trust-card")?.textContent.includes("Not trusted"));
  // Every word is behind a key: switching to French redraws the card in French.
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("folder-trust-card")?.textContent.includes("Dossiers de confiance"));
  assert.match(await settings.textContent(), /Votre espace de travail[\s\S]*Pas de confiance[\s\S]*Le dossier du projet « Deep »/);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  // At 400 px nothing on the card, long folder path included, widens the page.
  await page.setViewportSize({ width: 400, height: 800 });
  await openSettings(page);
  await settings.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways");
  // A box can stay inside the window while its words spill out of it, so both are measured.
  const wide = await page.evaluate(() => [...document.querySelectorAll("#folder-trust-card *")]
    .filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1)
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  // Both cards say where they belong, and each has exactly one filled button.
  for (const id of ["folder-trust-card", "loop-guard-card"]) {
    const card = page.locator(`#${id}`);
    assert.equal(await card.getAttribute("data-home"), "settings:permissions");
    assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, id);
  }
  // The loop guard switch is kept by its Save button.
  await page.locator("#loop-guard-mode").selectOption("when-needed");
  await page.locator("#loop-guard-card button", { hasText: "Save this setting" }).click();
  await page.locator("#loop-guard-card [role=status]", { hasText: "Saved." }).waitFor();
  const { loopGuardMode } = await import("../dist/index.js");
  assert.equal(loopGuardMode(app.store, owner), "when-needed");
  assert.deepEqual(errors, []);
});

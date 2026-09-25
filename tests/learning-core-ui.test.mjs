/**
 * The learning core's card (public/learning-core.js), opened the way a person opens it: Library,
 * then Memory. It must be there and only there, save its switch as it moves, say what was learned in
 * plain words, forget only after asking, fit 400 px, and carry real French for every word. Accepting
 * one of its skill ideas opens the skill editor on a draft, and "Look inside" says what it chose.
 * A headless browser only; a scripted provider stands in for every model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
function writeThenRead() {
  const steps = [call("files.write", { path: "note.txt", content: "hi" }), call("files.read", { path: "note.txt" }), { content: "done", toolCalls: [] }];
  let at = 0;
  return { name: "scripted", async complete() { const step = steps[at % steps.length]; at += 1; return step; } };
}

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-learning-core-ui-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: writeThenRead() });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const connect = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator("#learning-core").waitFor({ state: "attached", timeout: 15000 });
  };
  await connect();
  return { page, errors, app, connect };
}

test("L1 the card is in Library → Memory and nowhere else, and it starts off", async (t) => {
  const { page, errors } = await fixture(t);
  const card = page.locator("#learning-core");
  await openPlace(page, "library:memory");
  await card.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await card.locator("h2").innerText(), "What Branch learns from experience");
  assert.equal(await card.locator("#learning-core-mode").inputValue(), "off");
  assert.equal(await card.locator("button").count(), 1, "one button, the one the card is for");
  await openPlace(page, "chat");
  assert.equal(await card.isVisible(), false);
  assert.deepEqual(errors, []);
});

test("L2 the switch saves as it moves, what was learned reads as sentences, and forgetting asks first", async (t) => {
  const { page, errors, app } = await fixture(t);
  await openPlace(page, "library:memory");
  await page.locator("#learning-core-mode").selectOption("on");
  await page.locator("#learning-core [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(app.learningCore.settings(), { mode: "on" });

  for (let at = 0; at < 3; at += 1) await app.runtime.run({ prompt: `save a note about the garden ${at}` });
  await page.evaluate(() => globalThis.branchLearningCoreReady());
  const habit = page.locator("#learning-core-habits li").filter({ hasText: "files.write" });
  await habit.waitFor();
  assert.equal(await habit.innerText(), "Tool: files.write has usually gone well (3 tasks)");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#learning-core-forget").click();
  assert.ok((await app.learningCore.view()).kept.actions > 0, "saying no keeps everything");
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#learning-core-forget").click();
  await page.locator("#learning-core [role=status]").filter({ hasText: "Forgotten" }).waitFor();
  assert.equal((await app.learningCore.view()).kept.actions, 0);
  assert.equal(await page.locator("#learning-core .empty-state").count(), 1, "the empty card says what to do next");
  assert.deepEqual(errors, []);
});

test("L3 at 400 px it keeps its shape and nothing scrolls sideways", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openPlace(page, "library:memory");
  await page.locator("#learning-core").waitFor({ state: "visible" });
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector("#learning-core-mode")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the learning-core switch fits inside 400 px");
  assert.deepEqual(errors, []);
});

test("L4 every word has a key and real French, and the card is drawn again in French", async (t) => {
  const { page, errors } = await fixture(t);
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#learning-core h2, #learning-core p, #learning-core label, #learning-core option, #learning-core button")]
    .filter((node) => node.textContent.trim() && !node.dataset.t && node.getAttribute("role") !== "status").map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, []);
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const ours = Object.keys(english).filter((key) => key.includes("learning-core") || key.startsWith("inspector.learned"));
  assert.ok(ours.length >= 20);
  for (const key of ours) {
    assert.ok(french[key], `${key} has French`);
    if (!/^\{kind\}/.test(english[key])) assert.notEqual(french[key], english[key], `${key} is really translated`);
  }
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.querySelector("#learning-core h2")?.textContent === "Ce que Branch apprend de l'expérience");
  assert.deepEqual(errors, []);
});

test("L5 accepting a skill idea opens the skill editor on a draft, and Look inside says what was chosen first", async (t) => {
  const { page, errors, app } = await fixture(t);
  app.learningCore.configure({ mode: "on" });
  let last;
  for (let at = 0; at < 4; at += 1) last = await app.runtime.run({ prompt: `save a note about the garden ${at}` });
  const idea = page.locator("#memory-proposals .record").filter({ hasText: "could become a skill" });
  await page.reload(); // the conversation's key is kept for the tab, so this reads everything afresh
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openPlace(page, "library:memory");
  await idea.waitFor({ timeout: 15000 });
  await idea.getByRole("button", { name: "Accept", exact: true }).click();
  const editor = page.locator("#skill-document");
  await page.waitForFunction(() => document.querySelector("#skill-document")?.value.includes("files.write"), null, { timeout: 15000 });
  assert.equal(await editor.isVisible(), true, "the skill editor is on screen");
  assert.match(await editor.inputValue(), /^---\nname: [a-z-]+-steps\n/);
  assert.equal(app.store.skills.list("local").length, 0, "nothing was installed");

  await page.evaluate((id) => globalThis.branchInspector.open(id), last.id);
  const line = page.locator("#inspect-panel .inspect-row").filter({ hasText: "Chose these tools first" });
  await line.waitFor({ timeout: 15000 });
  assert.match(await line.innerText(), /files\.(write|read), files\.(write|read)/);
  assert.deepEqual(errors, []);
});

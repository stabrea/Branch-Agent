/**
 * mac3/reflection-skills: the two cards, opened the way a person opens them (tests/places.mjs).
 * "Looking back over conversations" lives in Library → Memory; "Skills your assistant wrote" in
 * Customize → Skills. Both switches start off; each press is followed through to what it changed.
 * The model is a scripted offline fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const skillFile = "---\nname: water-the-plants\ndescription: Use when the owner asks to water the plants.\n---\n# Water the plants\n\n1. Check the soil.\n";
function provider() {
  return { name: "learning-ui-fixture", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    if (/You look back over the latest turns/.test(system)) return { content: '{"remember":[{"text":"Waters the plants on Sundays","why":"said so"}]}', toolCalls: [] };
    if (/worth keeping as a skill/.test(system)) return { content: skillFile, toolCalls: [] };
    return { content: "Done", toolCalls: [] };
  } };
}
async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-learning-ui-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: provider() });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.learningLoop.idle(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  const token = page.getByLabel("Session token", { exact: true });
  await token.waitFor({ state: "visible", timeout: 120000 });
  await token.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app };
}
const homes = [["learning-look-back", "settings:memory"], ["learning-new-skills", "customize:skills"]];

test("each card is on the screen that owns its subject, and both switches start off", async (t) => {
  const { page, errors } = await fixture(t);
  for (const [id, home] of homes) {
    const card = page.locator("#" + id);
    await openPlace(page, home);
    await card.waitFor({ state: "visible", timeout: 60000 });
    assert.ok((await card.locator("h2").innerText()).trim().length > 0, `${id} has a title`);
    await openPlace(page, "chat");
    assert.equal(await card.isVisible(), false, `${id} shows only on ${home}`);
  }
  assert.equal(await page.locator("#look-back-switch").inputValue(), "off");
  assert.equal(await page.locator("#new-skills-switch").inputValue(), "off");
  assert.deepEqual(errors, []);
});

test("looking back: save the switch, look now, and accept the batch from the card", async (t) => {
  const { page, errors, app } = await fixture(t);
  await app.runtime.run({ prompt: "remind me that I water the plants on Sundays" });
  await openPlace(page, "settings:memory");
  const card = page.locator("#learning-look-back");
  await card.waitFor({ state: "visible", timeout: 60000 });
  await card.locator("#look-back-switch").selectOption("when-needed");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#learning-look-back [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.equal(app.learningLoop.settings().reflection, "when-needed");
  await page.locator("#learning-look-back").getByRole("button", { name: "Look back at my latest conversation now" }).click();
  const batch = page.locator("#look-back-list .record");
  await batch.first().waitFor();
  assert.match(await batch.first().innerText(), /Waters the plants on Sundays/);
  assert.equal(app.store.list("memory", "local").length, 0, "nothing written before the yes");
  await batch.first().getByRole("button", { name: "Accept all that are waiting" }).click();
  await page.locator("#learning-look-back [role=status]").filter({ hasText: "1 decided" }).waitFor();
  assert.deepEqual(app.store.list("memory", "local").map((r) => r.data.text), ["Waters the plants on Sundays"]);
  assert.deepEqual(errors, []);
});

test("new skills: draft one from a conversation, see it tried, and keep it", async (t) => {
  const { page, errors, app } = await fixture(t);
  await app.runtime.run({ prompt: "water the plants in the kitchen" });
  await openPlace(page, "customize:skills");
  const card = page.locator("#learning-new-skills");
  await card.waitFor({ state: "visible", timeout: 60000 });
  await card.locator("#new-skills-switch").selectOption("when-needed");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#learning-new-skills [role=status]").filter({ hasText: "Saved" }).waitFor();
  await page.locator("#learn-notes").fill("keep it short");
  await page.locator("#learning-new-skills").getByRole("button", { name: "Draft a skill from it" }).click();
  /* ci-flakes-4: "being written" is a passing state, and the card's next look can already show the
     finished draft instead; either one means the writing started. The press itself is not made again,
     because a second press would draft a second skill. */
  await page.waitForFunction(() =>
    /being written/.test(document.querySelector("#learning-new-skills [role=status]")?.textContent ?? "")
    || Boolean(document.querySelector("#new-skills-list .record")),
    undefined, { timeout: 120000 });
  /* The card looks again by itself while the draft is being written and tried. */
  const draft = page.locator("#new-skills-list .record").first();
  await draft.waitFor({ timeout: 60000 });
  await app.learningLoop.idle();
  /* The trial can finish between two of the card's looks, so wait for the look that shows it. */
  await draft.filter({ hasText: "Did at least as well" }).waitFor({ timeout: 60000 });
  assert.match(await draft.innerText(), /water-the-plants/);
  assert.match(await draft.innerText(), /Did at least as well: 1 of 1/);
  const [{ skillId }] = app.learningLoop.newSkills();
  assert.equal(app.store.skills.view("local", skillId).activeVersion, null, "it arrives switched off");
  await draft.getByRole("button", { name: "Keep it", exact: true }).click();
  await page.locator("#learning-new-skills [role=status]").filter({ hasText: "is switched on" }).waitFor();
  assert.equal(app.store.skills.view("local", skillId).activeVersion, 1);
  assert.deepEqual(errors, []);
});

test("at 400 px nothing scrolls sideways, and every fixed word has a key with real French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.setViewportSize({ width: 400, height: 900 });
  for (const [id, home] of homes) {
    await openPlace(page, home);
    await page.locator("#" + id).waitFor({ state: "visible", timeout: 60000 });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    assert.equal(wide, false, `${home} does not scroll sideways at 400 px`);
  }
  const { missing, keys } = await page.evaluate((ids) => {
    const out = [], found = [];
    for (const id of ids) {
      const card = document.getElementById(id);
      for (const node of card.querySelectorAll("[data-t]")) found.push(node.dataset.t);
      /* Records and status lines are assembled through t() from what happened, so they carry no fixed key. */
      for (const node of card.querySelectorAll("h2, p, label, option, button, summary"))
        if (!node.closest(".record, [role=status], #learn-session") && !node.classList.contains("field-note") && !node.dataset.t && node.textContent.trim())
          out.push(`${id}: "${node.textContent.trim().slice(0, 40)}"`);
    }
    return { missing: out, keys: found };
  }, homes.map(([id]) => id));
  assert.deepEqual(missing, [], "every fixed word carries a data-t key");
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const script = await readFile(new URL("../public/learning-loop.js", import.meta.url), "utf8");
  const assembled = [...script.matchAll(/t\("(learning\.[a-z.-]+)"/g)].map((m) => m[1]);
  const all = [...new Set([...keys, ...assembled, "learning.status.accepted", "learning.status.rejected", "learning.decision.accepted", "learning.decision.rejected"])];
  assert.deepEqual(all.filter((key) => !english[key]), [], "every key has English words");
  assert.deepEqual(all.filter((key) => !french[key] || (french[key] === english[key] && /[a-z]{4}/.test(english[key]) && !/^\{/.test(english[key]))), [], "and real French");
  assert.deepEqual(errors, []);
});

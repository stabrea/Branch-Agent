/**
 * Public list, bucket 13: the two cards in a real (headless) browser, opened the way a person opens
 * them (tests/places.mjs). Each names its home, keeps to the card anatomy, fits 400 px, and works:
 * a finished task is played back step by step, and the event-loop switch is saved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor } from "./places.mjs";

function writesAFile(name) {
  let round = 0;
  return {
    name: "scripted",
    async complete() {
      round += 1;
      return round % 2 === 1
        ? { content: "", toolCalls: [{ id: `c${round}`, name: "files.write", arguments: JSON.stringify({ path: name, content: "one" }) }] }
        : { content: "done", toolCalls: [] };
    },
  };
}

async function signIn(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

function cardShape(page, id) {
  return page.evaluate((cardId) => {
    const card = document.getElementById(cardId);
    const filled = [...card.querySelectorAll("button")].filter((b) => !b.classList.contains("quiet-button") && !b.classList.contains("text-button"));
    const unnamed = [...card.querySelectorAll("input, select, textarea")].filter((c) => !c.labels?.length);
    return {
      home: card.dataset.home, tag: card.tagName, headings: card.querySelectorAll("h2, h3.settings-card-title").length,
      sentence: card.querySelector(":is(h2, h3.settings-card-title) + p.subtle")?.textContent ?? "", filled: filled.length, unnamed: unnamed.length,
      keyless: [...card.querySelectorAll("h2, h3.settings-card-title, label, button, summary")].filter((n) => !n.dataset.t).length,
    };
  }, id);
}

function assertAnatomy(shape, id, home) {
  assert.equal(shape.home, home, id);
  assert.equal(shape.tag, "SECTION");
  assert.equal(shape.headings, 1);
  assert.ok(shape.sentence.length > 10, `${id} says what it is for`);
  assert.equal(shape.filled, 1, `${id} has one filled button`);
  assert.equal(shape.unnamed, 0, `${id}: every control can be named`);
  assert.equal(shape.keyless, 0, `${id}: every word goes through a key`);
}

test("Watch a task again: off at first, then a finished task plays back step by step at 400 px", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bucket13-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writesAFile("seen.txt") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "write the seen file" });
  assert.equal(run.status, "completed", run.output);
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await openPlace(page, "inbox:history");
  const card = page.locator("#recordings-card");
  await card.locator("h2").waitFor({ state: "visible" });
  assertAnatomy(await cardShape(page, "recordings-card"), "recordings-card", "inbox:history");
  assert.equal(await card.locator("#recordings-task").count(), 0, "nothing to pick while off");

  await card.locator("#recordings-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#recordings-task").waitFor({ state: "visible" });
  await page.locator("#recordings-card").getByRole("button", { name: "Play it back" }).click();
  const steps = page.locator("#recordings-card .recording-steps li");
  await steps.first().waitFor({ state: "visible" });
  assert.ok((await steps.count()) >= 4, "asked, thought, acted, finished");
  assert.equal(await steps.first().getAttribute("aria-current"), "step");
  await page.locator("#recordings-card").getByRole("button", { name: "Step on" }).click();
  assert.equal(await steps.nth(1).getAttribute("aria-current"), "step");
  await page.locator("#recordings-card summary").click();
  await page.locator("#recordings-card svg[role=img]").waitFor({ state: "visible" });
  assertAnatomy(await cardShape(page, "recordings-card"), "recordings-card (open)", "inbox:history");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `no sideways scrolling at 400 px (${wide} px over)`);

  await page.locator("#recordings-card").getByRole("button", { name: "Make a workflow from it" }).click();
  await page.locator("#recordings-card [role=status]", { hasText: "Automations" }).waitFor();
  assert.equal(app.workflows.list(app.runtime.owner).length, 1);
  assert.deepEqual(errors, []);
});

test("Is Branch keeping up: lives in Settings, Advanced, and its switch is saved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bucket13-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await page.locator("#event-loop-card").waitFor({ state: "attached" });
  await openSettingFor(page, "#event-loop-card");
  await page.locator("#event-loop-card h3.settings-card-title").waitFor({ state: "visible" });
  assertAnatomy(await cardShape(page, "event-loop-card"), "event-loop-card", "settings:advanced");
  await page.locator("#event-loop-mode").selectOption("when-needed");
  await page.locator("#event-loop-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#event-loop-card [role=status]", { hasText: "Saved" }).waitFor();
  await page.locator("#event-loop-card").getByRole("button", { name: "Check now" }).click();
  await page.waitForFunction(() => /Branch is/.test(document.getElementById("event-loop-reading")?.textContent ?? ""), null, { timeout: 15000 });
  const response = await fetch(`${server.url}/api/event-loop`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal((await response.json()).settings.mode, "when-needed");
  assert.deepEqual(errors, []);
});

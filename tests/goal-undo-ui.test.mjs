/**
 * Wave mac2, goal-undo: the goal strip, the Edit form on an earlier message and the switches card,
 * in a real (headless) browser at 400 px. Screens are opened the way a person does, through
 * tests/places.mjs; a conversation is opened through the page's own openConversation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, saveGoalUndoSettings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor, showEverything } from "./places.mjs";

async function signIn(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
}

/** An app whose model answers "done <what you said>", a browser at 400 px, signed in. */
async function setUp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-goal-undo-ui-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), snapshotGit: null,
    provider: { name: "scripted", async complete(request) { return { content: `done ${request.messages.at(-1).content}`, toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  /* This file exercises the full window's own controls: "Show everything" since 0.18.1. */
  await showEverything(page);
  return { app, page, errors };
}
const open = (page, sessionId) => page.evaluate((id) => import("/app.js").then((m) => m.openConversation(id)), sessionId);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("the goal strip shows the round, score, what is missing and Resume/Stop, and fits 400 px", async (t) => {
  const { app, page, errors } = await setUp(t, "strip");
  const run = await app.runtime.run({ prompt: "hello" });
  app.store.save("settings", "local", `goal:${run.sessionId}`, {
    sessionId: run.sessionId, objective: "Make the tests pass", status: "paused", round: 2, maxRounds: 6, score: 0.4,
    best: 0.4, flatRounds: 0, missing: ["the login test"], reason: "Paused. Resume to carry on.", checks: null,
    startedAt: new Date().toISOString(), elapsedMs: 65_000, activeSince: null, lastRunId: run.id,
  });
  await open(page, run.sessionId);
  await openPlace(page, "chat");
  // The strip lives with the conversation's plan; on a narrow window that pane opens from the title bar.
  // phase2/panels: the one panel switch opens it, then the Plan tab inside the panel.
  await page.locator("#aside-toggle").click();
  await page.locator('.lx-pane-tab[data-pane="plan"]').click();
  const strip = page.locator("#goal-strip");
  await strip.waitFor({ state: "visible", timeout: 10_000 });
  const text = await strip.textContent();
  for (const words of ["Goal paused", "Make the tests pass", "Round 2 of 6", "Score 0.40 of 1", "1 min 05 sec", "the login test"])
    assert.ok(text.includes(words), `the strip says "${words}": ${text}`);
  assert.deepEqual(await strip.locator("button").allTextContents(), ["Resume", "Stop"]);
  assert.equal(await strip.locator("progress").getAttribute("aria-label"), "Score 0.40 of 1");
  assert.ok((await overflow(page)) <= 0, "no sideways scrolling at 400 px");
  // Stop through the page's own request: the strip rewords itself and only offers Hide.
  await page.evaluate((id) => import("/app.js").then((m) => m.api(`sessions/${id}/goal`, { action: "stop" })), run.sessionId);
  await page.waitForFunction(() => /Goal stopped/.test(document.getElementById("goal-strip")?.textContent ?? ""), null, { timeout: 10_000 });
  assert.deepEqual(await strip.locator("button").allTextContents(), ["Hide"]);
  await page.waitForTimeout(2500); // one more poll: the new state reopens the conversation
  assert.equal(await strip.isVisible(), true, "a new round or state does not close the pane the strip is in");
  await strip.getByRole("button", { name: "Hide" }).click();
  assert.equal(await strip.evaluate((node) => node.hidden), true);
  assert.deepEqual(errors, []);
});

test("Edit on an earlier message offers what to take back, goes back, and Undo puts it forward", async (t) => {
  const { app, page, errors } = await setUp(t, "edit");
  const one = await app.runtime.run({ prompt: "first" });
  await app.runtime.run({ prompt: "second", sessionId: one.sessionId });
  await open(page, one.sessionId);
  const firstMessage = page.locator("#conversation .message.user").first();
  await firstMessage.getByRole("button", { name: "Edit" }).click();
  const form = firstMessage.locator(".rewind-editor");
  await form.waitFor({ state: "visible" });
  assert.equal(await form.locator("textarea").inputValue(), "first");
  assert.equal(await form.locator("input[type=radio]").count(), 3);
  assert.equal(await form.locator("input[type=radio]:checked").getAttribute("value"), "both");
  assert.match(await form.textContent(), /own file tools/, "without git it says what cannot be covered");
  assert.ok((await overflow(page)) <= 0, "the open Edit form fits 400 px");
  await form.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await firstMessage.locator(".rewind-editor").count(), 0);

  await firstMessage.getByRole("button", { name: "Edit" }).click();
  await form.locator("input[value=conversation]").check();
  await form.locator("textarea").fill("first, reworded");
  await form.locator("button[type=submit]").click();
  const undo = page.locator("#rewind-undo");
  await page.waitForFunction(() => document.getElementById("rewind-undo")?.hidden === false, null, { timeout: 10_000 });
  await page.waitForFunction((id) => {
    const users = [...document.querySelectorAll("#conversation .message.user")].map((node) => node.textContent);
    return users.length === 1 && users[0].includes("first, reworded");
  }, one.sessionId, { timeout: 15_000 });
  const said = () => app.store.sessionView("local", one.sessionId).messages.filter((m) => m.role === "user").map((m) => m.content);
  await page.waitForFunction(() => !document.querySelector("#conversation .message.assistant:last-child")?.textContent.includes("…"));
  assert.deepEqual(said(), ["first, reworded"], "the old turns were taken back and the new words sent");

  await undo.getByRole("button", { name: "Undo" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#conversation .message.user").length === 2, null, { timeout: 10_000 });
  assert.deepEqual(said(), ["first", "second"], "undo puts the conversation back as it was before going back");
  assert.deepEqual(errors, []);
});

test("the switches card sits beside workspace snapshots, saves, and shows the Goal button only when on", async (t) => {
  const { app, page, errors } = await setUp(t, "switches");
  await openSettingFor(page, "#goal-undo-form");
  const card = page.locator("#goal-undo-form");
  await card.waitFor({ state: "visible" });
  const shape = await card.evaluate((form) => ({
    home: form.dataset.home,
    page: form.closest(".lx-page")?.dataset.page ?? "",
    snapshotsPage: document.getElementById("snapshots-card")?.closest(".lx-page")?.dataset.page ?? "",
    headings: form.querySelectorAll("h2").length,
    unnamed: [...form.querySelectorAll("select")].filter((c) => !c.closest("label")).length,
    keyless: [...form.querySelectorAll("h2, label > span, button, option")].filter((n) => !n.dataset.t).length,
    values: [...form.querySelectorAll("select")].map((s) => s.value),
  }));
  assert.equal(shape.home, "settings:data");
  assert.equal(shape.page, "data", "it lives on the Data page of Settings");
  assert.equal(shape.snapshotsPage, "data", "the same page as Workspace snapshots");
  assert.equal(shape.headings, 1);
  assert.equal(shape.unnamed, 0, "every switch has a label");
  assert.equal(shape.keyless, 0, "every word goes through a key");
  assert.deepEqual(shape.values, ["off", "off"], "both ship off");
  assert.ok((await overflow(page)) <= 0, "the card fits 400 px");
  assert.equal(await page.locator("#goal-start").evaluate((node) => node.hidden), true);
  await card.locator("#goal-undo-goal").selectOption("on");
  await card.locator("#goal-undo-snapshots").selectOption("when-needed");
  await card.getByRole("button", { name: "Save these switches" }).click();
  await card.getByText("Saved.").waitFor({ state: "visible" });
  const { goalUndoSettings } = await import("../dist/index.js");
  assert.deepEqual(goalUndoSettings(app.store, "local"), { goal: "on", snapshots: "when-needed" });
  assert.equal(await page.locator("#goal-start").evaluate((node) => node.hidden), false, "switched on: the Goal button shows");
  saveGoalUndoSettings(app.store, "local", { goal: "off" });
  assert.deepEqual(errors, []);
});

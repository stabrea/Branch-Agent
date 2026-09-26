/**
 * Wave mac2, goal-undo: the goal strip, the Edit form on an earlier message and the switches card,
 * in a real (headless) browser at 400 px. Screens are opened the way a person does, through
 * tests/places.mjs; a conversation is opened through the page's own openConversation.
 * Redesign: the new window (public/app/**). The goal strip is drawn at the top of the conversation (chat/goal.js); Edit on
 * a message opens "Edit and send again" (chat/messages.js), and Undo is on the toast that follows. A conversation is opened
 * from its row in the side list at full width, then the window is narrowed to 400 px for the fit checks (on a phone the
 * side list stays over the conversation after a row is chosen: the WINDOW BUG marked in library-tabs.test.mjs).
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
import { openSettingFor } from "./places.mjs";
import { signIn } from "./new-window-places.mjs";

/** An app whose model answers "done <what you said>", a browser at 400 px, signed in. */
async function setUp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-goal-undo-ui-${name}-`));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), snapshotGit: null,
    provider: { name: "scripted", async complete(request) { return { content: `done ${request.messages.at(-1).content}`, toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, page, errors };
}
/** Opens a conversation from its row in the side list, then narrows the window to 400 px. */
async function open(page, sessionId) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side .list [data-act="chat"][data-id="${sessionId}"]`).click();
  await page.locator("#conversation .u").first().waitFor({ timeout: 15000 });
  await page.setViewportSize({ width: 400, height: 900 });
}
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
  const strip = page.locator("#conversation .goal6, .goal6").first();
  await strip.waitFor({ state: "visible", timeout: 10_000 });
  const text = await strip.textContent();
  for (const words of ["Goal: Make the tests pass", "Round 2 of 6", "score 0.4 of 1", "1 min", "still missing: the login test"])
    assert.ok(text.includes(words), `the strip says "${words}": ${text}`);
  assert.deepEqual(await strip.locator("button").allTextContents(), ["Resume", "Stop"]);
  assert.ok((await overflow(page)) <= 0, "no sideways scrolling at 400 px");
  // Stop, as a person presses it: a finished goal has no strip (it is said in the conversation itself). Redesign: the old
  // strip's "Goal stopped" wording and its Hide button are replaced by the new window.
  await strip.getByRole("button", { name: "Stop", exact: true }).click();
  await page.locator(".goal6").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(app.store.get("settings", "local", `goal:${run.sessionId}`)?.data?.status, "stopped");
  assert.deepEqual(errors, []);
});

test("Edit on an earlier message offers what to take back, goes back, and Undo puts it forward", async (t) => {
  const { app, page, errors } = await setUp(t, "edit");
  const one = await app.runtime.run({ prompt: "first" });
  await app.runtime.run({ prompt: "second", sessionId: one.sessionId });
  await open(page, one.sessionId);
  const firstMessage = page.locator("#conversation .u").first();
  await firstMessage.hover();
  await firstMessage.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.locator(".dlg");
  await form.waitFor({ state: "visible" });
  assert.equal(await form.getByLabel("Your message", { exact: true }).inputValue(), "first");
  const choices = form.getByRole("group", { name: "What to put back", exact: true }).getByRole("button");
  assert.equal(await choices.count(), 3);
  assert.equal(await form.locator('[data-act="rw-what"][aria-pressed="true"]').getAttribute("data-v"), "both");
  assert.match(await form.textContent(), /own file tools/, "without git it says what cannot be covered");
  assert.ok((await overflow(page)) <= 0, "the open Edit form fits 400 px");
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await form.waitFor({ state: "detached" });

  await firstMessage.hover();
  await firstMessage.getByRole("button", { name: "Edit", exact: true }).click();
  await form.locator('[data-act="rw-what"][data-v="conversation"]').click();
  await form.getByLabel("Your message", { exact: true }).fill("first, reworded");
  await form.getByRole("button", { name: "Send", exact: true }).click();
  const undo = page.locator(".toast").getByRole("button", { name: "Undo", exact: true });
  await undo.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => {
    const users = [...document.querySelectorAll("#conversation .u")].map((node) => node.textContent);
    return users.length === 1 && users[0].includes("first, reworded");
  }, null, { timeout: 15_000 });
  const said = () => app.store.sessionView("local", one.sessionId).messages.filter((m) => m.role === "user").map((m) => m.content);
  await page.waitForFunction(() => !document.querySelector("#conversation .typing"), null, { timeout: 15_000 });
  assert.deepEqual(said(), ["first, reworded"], "the old turns were taken back and the new words sent");

  await undo.click();
  await page.waitForFunction(() => document.querySelectorAll("#conversation .u").length === 2, null, { timeout: 10_000 });
  assert.deepEqual(said(), ["first", "second"], "undo puts the conversation back as it was before going back");
  assert.deepEqual(errors, []);
});

test.skip("the switches card sits beside workspace snapshots, saves, and shows the Goal button only when on", async (t) => {
  // Redesign: replaced by the new window (prototype.html has no goal and snapshots switches card; "Set a goal" is always in
  // the message box's + menu, data-act="goal-fill").
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

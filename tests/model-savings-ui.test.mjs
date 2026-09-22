/**
 * R17-E: the model cards open where docs/places.md says, every control is described by its own
 * sentence, a change saved on the screen reaches the server, a mixture appears in the model list,
 * the cards fit at 400 px, and the round-by-round chart shows up under the meter when switched on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readSavings, saveSavings } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor, showEverything } from "./places.mjs";

const homes = {
  "savings-phases-card": "#lx-models-defaults",
  "savings-difficulty-card": "#lx-models-defaults",
  "savings-reported-tokens-card": "#lx-models-defaults",
  "savings-keep-alive-card": "#lx-models-defaults",
  "savings-openrouter-card": "#lx-models-connection",
  "savings-mixtures-card": "#lx-models-second",
  "savings-round-chart-card": "#lx-page-appearance",
};
const reportedUsage = { input: 700, output: 20, cachedInput: 500 };
/** A model whose answers report `usages` in turn; one without `cachedInput` never said what the cache served. */
const fake = (name, usages = [reportedUsage]) => {
  let at = 0;
  return { name, async complete() { return { content: "Done.", toolCalls: [], usage: usages[at++ % usages.length] }; } };
};

async function openApp(t, width = 1280, usages = undefined) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-savings-ui-"));
  const presets = [{ id: "main", name: "Main", provider: fake("main", usages), model: "m" }, { id: "second", name: "Second", provider: fake("second"), model: "s" }];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  /* This file exercises the full window's own controls: "Show everything" since 0.18.1. */
  await showEverything(page);
  await page.locator("#savings-mixtures-card").waitFor({ state: "attached" });
  return { app, page, errors };
}

const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

test("each model card is in its home, every control has its own sentence, and saving reaches the server", async (t) => {
  const { app, page, errors } = await openApp(t);
  for (const [id, host] of Object.entries(homes)) {
    await page.waitForFunction(([card, slot]) => document.getElementById(card)?.closest(slot), [id, host]);
    await openSettingFor(page, `#${id}`);
    assert.ok(await page.locator(`#${id}`).isVisible(), `${id} can be seen on its page`);
    assert.equal(await page.locator(`#${id} h2 + p.subtle`).count(), 1, `${id} says what it is for`);
    assert.deepEqual(await undescribed(page, id), [], `${id} has a control without a sentence`);
    assert.equal(await page.locator(`#${id} [data-t]`).evaluateAll((nodes) => nodes.filter((n) => /^savings\./.test(n.textContent)).length), 0, `${id} shows a key`);
  }

  await openSettingFor(page, "#savings-keep-alive-card");
  await page.locator("#savings-keep-alive-mode").selectOption("on");
  await page.locator("#savings-keep-alive-spendCapDollars").fill("0.02");
  await page.locator("#savings-keep-alive-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#savings-keep-alive-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(readSavings(app.store, "local", "keepAlive"), { mode: "on", everyMinutes: 4, maxPings: 3, spendCapDollars: 0.02 });
  await page.locator("#savings-keep-alive-card").getByRole("button", { name: "Put back as shipped" }).click();
  await page.locator("#savings-keep-alive-card [role=status]").filter({ hasText: "Put back" }).waitFor();
  assert.equal(readSavings(app.store, "local", "keepAlive").mode, "off");
  assert.equal(await page.locator("#savings-keep-alive-mode").inputValue(), "off");

  await openSettingFor(page, "#savings-mixtures-card");
  await page.locator("#savings-mixtures-name").fill("Both of them");
  await page.locator("#savings-mixtures-card").getByLabel("Main").check();
  await page.locator("#savings-mixtures-card").getByLabel("Second").check();
  await page.locator("#savings-mixtures-aggregator").selectOption("main");
  await page.locator("#savings-mixtures-card").getByRole("button", { name: "Add this mixture" }).click();
  await page.locator("#savings-mixtures-card").getByText("Both of them: Main, Second, written by Main").waitFor();
  assert.ok(app.runtime.models.presets.has("mixture-both-of-them"), "the mixture is in the model list");

  await openSettingFor(page, "#savings-difficulty-card");
  await page.locator("#savings-difficulty-mode").selectOption("when-needed");
  await page.locator("#savings-difficulty-easyModel").selectOption("main");
  await page.locator("#savings-difficulty-hardModel").selectOption("second");
  await page.locator("#savings-difficulty-card").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#savings-difficulty-card [role=status]").filter({ hasText: "Saved" }).waitFor();
  assert.deepEqual(readSavings(app.store, "local", "difficulty"), { mode: "when-needed", classifierModel: null, easyModel: "main", hardModel: "second" });
  assert.deepEqual(errors, []);
});

test("the French words are real, and the cards fit at 400 px", async (t) => {
  const { page } = await openApp(t, 400);
  for (const id of ["savings-openrouter-card", "savings-mixtures-card", "savings-keep-alive-card"]) {
    await openSettingFor(page, `#${id}`);
    const box = await page.locator(`#${id}`).evaluate((card) => ({ scroll: card.scrollWidth, client: card.clientWidth }));
    assert.ok(box.scroll <= box.client + 1, `${id} is wider than its card (${box.scroll} > ${box.client})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${id} scrolls the page sideways`);
  }
  const { readFile } = await import("node:fs/promises");
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const ours = Object.keys(en).filter((key) => key.startsWith("savings."));
  assert.ok(ours.length > 60);
  const copied = ours.filter((key) => !fr[key] || (fr[key] === en[key] && !/^\{|^Nom$/.test(en[key])));
  assert.deepEqual(copied, [], "every word has its own French");
});

test("R17-049 the round-by-round chart appears in the meter's popover only when switched on", async (t) => {
  const { app, page, errors } = await openApp(t);
  const run = await app.runtime.run({ prompt: "hello" });
  await page.evaluate((id) => { document.getElementById("conversation").dataset.sessionId = id; }, run.sessionId);
  await page.evaluate(() => window.branchTokenMeter.refresh());
  await page.locator("#meter-row").waitFor({ state: "visible" });
  await page.locator("#meter-button").click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#round-chart:not([hidden])").count(), 0, "off: no chart");
  await page.locator("#meter-button").click();

  saveSavings(app.store, "local", "roundChart", { mode: "on" });
  await page.evaluate(() => window.branchModelSavings.refresh());
  await page.locator("#meter-button").click();
  await page.locator("#round-chart svg rect").first().waitFor();
  const summary = await page.locator("#round-chart-summary").textContent();
  assert.match(summary, /Rounds: 1\. Tokens in: 700\. Served from the cache: 500\. Summaries: 0\./);
  // The meter redraws its numbers every few seconds; the chart stays.
  await page.evaluate(() => window.branchTokenMeter.refresh());
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#meter-popover #round-chart svg").count(), 1);
  assert.deepEqual(errors, []);
});

test("a round whose service never reported the cache is said to be unknown, never drawn or counted as none", async (t) => {
  const { app, page, errors } = await openApp(t, 1280, [{ input: 700, output: 20 }, reportedUsage]);
  saveSavings(app.store, "local", "roundChart", { mode: "on" });
  const first = await app.runtime.run({ prompt: "hello" });
  await page.evaluate((id) => { document.getElementById("conversation").dataset.sessionId = id; }, first.sessionId);
  await page.evaluate(() => window.branchModelSavings.refresh());
  await page.evaluate(() => window.branchTokenMeter.refresh());
  await page.locator("#meter-row").waitFor({ state: "visible" });
  await page.locator("#meter-button").click();
  /** Draws the chart now, waiting for that drawing itself, and answers its summary and its bars. */
  const drawn = async () => {
    await page.evaluate(() => window.branchRoundChart.refresh());
    const bars = await page.locator("#round-chart svg rect:not(.round-chart-fold)").count();
    return { summary: await page.locator("#round-chart-summary").textContent(), bars };
  };
  // Only an unreported round: no cache figure at all, and its input is drawn faded.
  const only = await drawn();
  assert.match(only.summary, /Rounds: 1\. Tokens in: 700\. Served from the cache: not reported\. Summaries: 0\./);
  assert.doesNotMatch(only.summary, /Served from the cache: 0/);
  assert.equal(only.bars, 2, "one round: what was sent and the answer");
  assert.equal(await page.locator("#round-chart .round-chart-unreported").count(), 1);
  // One reported round beside it: the figure is a floor, and says how many rounds did not report.
  await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
  const both = await drawn();
  assert.equal(both.bars, 5, "the second round is drawn too: from the cache, the rest sent, and the answer");
  assert.match(both.summary, /Rounds: 2\. Tokens in: 1,400\. Served from the cache: at least 500 \(not reported for 1 of the rounds\)\. Summaries: 0\./);
  assert.equal(await page.locator("#round-chart .round-chart-unreported").count(), 1, "only the unreported round is faded");
  assert.deepEqual(errors, []);
});

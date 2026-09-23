/**
 * DG-044: the models Branch tries next when one fails are rows in an order the person sets, not a plain tick list.
 * Each row has Move up and Move down buttons (named in the page's language, off at the ends), the new order is saved
 * as it is made, a keyboard press keeps focus on the moved row, and the list opens in the saved order. At 400 px the
 * rows fit without pushing the page sideways.
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

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-fallback-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const answer = async () => ({ content: "ok", toolCalls: [] });
  for (const [id, name, provider, model] of [["order-gpt", "OpenAI", "openai-compatible", "gpt-5.5"],
    ["order-claude", "Anthropic", "anthropic", "claude-sonnet-4-5"], ["order-local", "Ollama", "ollama", "llama3.1:8b"]])
    app.runtime.models.register({ id, name, model, provider: { name: provider, complete: answer } });
  /* Saved in the reverse of the list's own order, so the page must follow the saved order to show it. */
  app.runtime.models.configure(app.runtime.owner, { activePreset: "order-gpt", fallbackOrder: ["order-local", "order-claude"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const saved = () => app.runtime.models.settings(app.runtime.owner).fallbackOrder.join(" ");
  const until = async (want, what) => {
    for (let i = 0; i < 100 && saved() !== want; i++) await page.waitForTimeout(100);
    assert.equal(saved(), want, what);
  };
  return { page, errors, saved, until };
}
async function openSettingsPage(page, name) {
  if (!(await page.locator("#settings-window").isVisible())) {
    const cog = page.locator(".sg-foot-line > .sg-gear:visible");
    if (!(await cog.count())) await page.locator("#rail-toggle").click();
    await cog.click();
  }
  await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
}
async function openFallbacks(page) {
  await openSettingsPage(page, "models");
  await page.locator("#lx-models-connection").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  await page.locator('#models-fallback input[value="order-claude"]').waitFor({ state: "visible", timeout: 30000 });
}
const order = (page) => page.locator("#models-fallback input").evaluateAll((boxes) => boxes.map((box) => box.value));
const row = (page, id) => page.locator("#models-fallback .fallback-row").filter({ has: page.locator(`input[value="${id}"]`) });

test("DG-044: the models tried next open in the saved order, and Move up and Move down reorder and save them", async (t) => {
  const { page, errors, until } = await fixture(t, 1440);
  await openFallbacks(page);
  assert.deepEqual(await order(page), ["order-local", "order-claude", "default", "order-gpt"], "the saved order first, then the rest in the list's own order (the offline demonstration is first there)");
  assert.equal(await page.locator("#models-fallback legend").innerText(), "If the default fails, try these in order");
  assert.equal(await row(page, "order-local").getByRole("button", { name: "Move up" }).isDisabled(), true, "the first row cannot go up");
  assert.equal(await row(page, "order-gpt").getByRole("button", { name: "Move down" }).isDisabled(), true, "the last row cannot go down");

  await row(page, "order-claude").getByRole("button", { name: "Move up" }).click();
  assert.deepEqual(await order(page), ["order-claude", "order-local", "default", "order-gpt"]);
  await until("order-claude order-local", "the new order is saved as it is made");

  /* By keyboard: focus stays on the row that moved, on the button that can still move it. */
  await row(page, "order-local").getByRole("button", { name: "Move up" }).focus();
  await page.keyboard.press("Enter");
  await until("order-local order-claude", "a key press saves the order too");
  const focused = await page.evaluate(() => {
    const now = document.activeElement;
    return { value: now.closest(".fallback-row")?.querySelector("input").value, name: now.getAttribute("aria-label") };
  });
  assert.deepEqual(focused, { value: "order-local", name: "Move down" }, "focus stays on the moved row, on a button that works");

  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await openFallbacks(page);
  assert.deepEqual(await order(page), ["order-local", "order-claude", "default", "order-gpt"], "the saved order comes back");
  assert.deepEqual(errors, []);
});

test("DG-044 at 400: the rows fit, and their buttons are named in French", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openSettingsPage(page, "appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await openFallbacks(page);
  const fit = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#models-fallback .fallback-row")];
    const holder = document.getElementById("models-fallback").getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, inside: rows.every((one) => one.getBoundingClientRect().right <= holder.right + 1) };
  });
  assert.ok(fit.page <= 400, `the page is not pushed sideways: ${fit.page}`);
  assert.ok(fit.inside, "each row fits its list");
  assert.equal(await row(page, "order-claude").getByRole("button", { name: "Monter" }).count(), 1);
  assert.equal(await row(page, "order-claude").getByRole("button", { name: "Descendre" }).count(), 1);
  assert.equal(await page.locator("#models-fallback legend").innerText(), "Si le modèle par défaut échoue, essayer ceux-ci dans l'ordre");
  assert.deepEqual(errors, []);
});

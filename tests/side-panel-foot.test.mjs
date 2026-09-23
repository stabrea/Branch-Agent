/* DG-116, DG-117, DG-118: the side panel card's own foot switch, the Terminal tab's "Open a terminal for me", and its
   close control and Escape, as in the approved sample. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-side-foot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const run = app.store.createRun(app.runtime.owner, "Compare the quotes");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Here is a short answer." });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => globalThis.branchPanels);
  errors.length = 0;
  await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, run.sessionId);
  await page.locator(".message.assistant").first().waitFor();
  return { page, errors, sessionId: run.sessionId };
}
async function openCard(page) {
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "visible" });
}
const tab = (page, id) => page.locator(`#context-panel .lx-pane-tab[data-pane="${id}"]`).click();

test("DG-116 the card ends in one switch, on by default, pinned to its bottom edge on every tab, and kept", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  const foot = page.locator("#lx-pane-foot");
  for (const id of ["activity", "plan", "files", "memory", "browser", "terminal"]) {
    await tab(page, id);
    await foot.waitFor();
    const where = await page.evaluate(() => {
      const panel = document.getElementById("context-panel"), card = panel.getBoundingClientRect();
      const box = document.getElementById("lx-pane-foot").getBoundingClientRect();
      return { bottom: card.bottom - box.bottom, left: box.left - card.left, right: card.right - box.right };
    });
    assert.ok(where.bottom >= 0 && where.bottom <= 2, `${id}: the foot sits on the card's bottom edge (${where.bottom})`);
    assert.ok(where.left <= 2 && where.right <= 2, `${id}: the foot runs edge to edge (${where.left}, ${where.right})`);
  }
  assert.equal((await foot.textContent()).trim(), "Open this by itself while a task works");
  const toggle = page.locator("#lx-pane-auto");
  assert.equal(await toggle.getAttribute("role"), "switch");
  assert.equal(await toggle.isChecked(), true, "on unless turned off, as in the sample");
  assert.deepEqual(await toggle.evaluate((el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; }), [40, 24], "the shared switch");
  await toggle.click();
  assert.equal(await page.evaluate(() => localStorage.getItem("branch-pane-auto")), "off", "turning it off is kept");
  assert.equal(await page.locator("#context-panel").isVisible(), true, "turning it off does not close a card the owner opened");
  await toggle.click();
  assert.equal(await page.evaluate(() => localStorage.getItem("branch-pane-auto")), null);
  /* In French the same line is French. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("lx-pane-foot").textContent.trim() === "L'ouvrir de lui-même quand une tâche s'exécute");
  assert.deepEqual(errors, []);
});

test("DG-117 the Terminal tab offers Open a terminal for me, the sample's small button, joining this conversation safely", async (t) => {
  const { page, errors, sessionId } = await fixture(t);
  await openCard(page);
  await tab(page, "terminal");
  const open = page.locator("#panels-terminal-open");
  await open.waitFor();
  assert.equal((await open.textContent()).trim(), "Open a terminal for me");
  const shape = await open.evaluate((el) => { const s = getComputedStyle(el); return [el.getBoundingClientRect().height, s.fontSize, s.fontWeight, s.borderTopLeftRadius]; });
  assert.deepEqual(shape, [30, "12.5px", "540", "9px"], "the sample's small button");
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), false, "only the button until pressed");
  await open.click();
  assert.equal(await open.getAttribute("aria-expanded"), "true");
  const shown = await page.locator("#panels-terminal-attach code").textContent();
  assert.equal(shown, `branch chat --attach --session ${sessionId}`, "the existing way in: this conversation, through the same rules");
  /* It stays open across the tab's own redraws. */
  await page.waitForTimeout(3500);
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), true);
  await page.locator("#panels-terminal-open").click();
  assert.equal(await page.locator("#panels-terminal-attach").isVisible(), false);
  assert.deepEqual(errors, []);
});

test("DG-118 the card's own close and Escape put it away, hand the keyboard back, and the title bar agrees", async (t) => {
  const { page, errors } = await fixture(t);
  for (const everything of [false, true]) {
    if (everything) {
      await page.evaluate(async () => (await import("/appearance.js")).changeAppearance({ showEverything: true }));
      await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
    }
    await openCard(page);
    const close = page.locator("#lx-pane-close");
    assert.equal(await close.getAttribute("aria-label"), "Close the side panel");
    await close.click();
    await page.locator("#context-panel").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "aside-toggle");
    assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "false");
    await openCard(page);
    await page.locator('#context-panel .lx-pane-tab[data-pane="plan"]').focus();
    await page.keyboard.press("Escape");
    await page.locator("#context-panel").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "aside-toggle", `${everything}: Escape hands the keyboard back`);
    assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "false", `${everything}: the switch says closed`);
  }
  assert.deepEqual(errors, []);
});

test("DG-115 in French all six tabs keep their names in the 340 px card", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  for (const id of ["activity", "browser", "terminal"]) {
    await tab(page, id);
    await page.waitForFunction(() => document.querySelector('.lx-pane-tab[data-pane="browser"] .lx-words')?.textContent === "Navigateur");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const words = await page.evaluate(() => [...document.querySelectorAll("#context-panel .lx-pane-tab .lx-words")]
      .map((word) => ({ text: word.textContent, shown: word.getClientRects().length > 0, cut: word.scrollWidth > word.clientWidth + 1 })));
    assert.equal(words.length, 6);
    assert.deepEqual(words.filter((word) => !word.shown || word.cut).map((word) => word.text), [], `${id}: every name shows whole`);
  }
  assert.deepEqual(errors, []);
});

/* DG-114: the side panel is the approved sample's card (design/Branch-Grown-Up.html, `.pane`): one card named
   "Side panel" with a close button and its tabs, floating over the conversation instead of taking a column,
   closed until asked for, never covering the message box, and never clipping what is in it. Headless only. */
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
  const root = await mkdtemp(join(tmpdir(), "branch-side-card-"));
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
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, run.sessionId);
  await page.locator(".message.assistant").first().waitFor();
  return { page, errors };
}

const shown = (page) => page.locator("#context-panel").isVisible();
const width = (page, id) => page.evaluate((el) => document.getElementById(el).getBoundingClientRect().width, id);
async function openCard(page) {
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "visible" });
}

test("DG-114 the side panel is one card named Side panel, over the conversation, closed until asked for", async (t) => {
  const { page, errors } = await fixture(t);
  assert.equal(await shown(page), false, "closed until asked for");
  const before = await width(page, "chat");
  await openCard(page);
  assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#context-panel .lx-pane-name").textContent(), "Side panel", "named Side panel, not for a tab");
  assert.equal(await page.locator("#context-panel .lx-pane-tab").count(), 6, "its six tabs are inside it");
  assert.equal(await width(page, "chat"), before, "it floats over the conversation instead of narrowing it");
  const card = await page.evaluate(() => {
    const panel = document.getElementById("context-panel"), style = getComputedStyle(panel), box = panel.getBoundingClientRect();
    return { position: style.position, radius: style.borderTopLeftRadius, right: box.right, bottom: box.bottom, left: box.left,
      box: document.getElementById("chat-form").getBoundingClientRect().top, grid: getComputedStyle(document.body).gridTemplateColumns.split(" ").at(-1) };
  });
  assert.equal(card.position, "fixed");
  assert.equal(card.radius, "16px", "the sample's rounded card");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector("body > main")).borderTopRightRadius), "0px",
    "the conversation keeps its own corner beside it");
  assert.equal(card.grid, "0px", "no column is kept for it");
  assert.ok(card.right <= 1440, "inside the window");
  assert.ok(card.bottom <= card.box, `it stops above the message box (${card.bottom} over ${card.box})`);
  /* The handle that resizes it sits on the card's own edge. */
  const handle = page.locator('.panels-rz[data-rz="aside"]');
  await handle.waitFor({ timeout: 5000 }).catch(() => assert.fail("the resize handle shows on the open card"));
  const grip = await handle.boundingBox();
  assert.ok(Math.abs(grip.x + 5 - card.left) <= 1, `the resize handle is on the card's edge (${grip.x} for ${card.left})`);
  /* Choosing a tab keeps the card's name: the tabs say which one is chosen. */
  await page.locator('#context-panel .lx-pane-tab[data-pane="plan"]').click();
  assert.equal(await page.locator("#context-panel .lx-pane-name").textContent(), "Side panel", "never titled by its tab");
  /* Its close button shuts it and hands the keyboard back to the button that opens it again. */
  await page.locator("#lx-pane-close").click();
  await page.locator("#context-panel").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "aside-toggle", "the keyboard goes back to the switch that opens it");
  assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "false");
  assert.deepEqual(errors, []);
});

test("DG-114 the full window's side panel is the same card, closed until asked for", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/appearance.js")).changeAppearance({ showEverything: true }));
  await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  assert.equal(await shown(page), false, "no longer a column open by default");
  const before = await width(page, "chat");
  await openCard(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("context-panel")).position), "fixed");
  assert.equal(await width(page, "chat"), before, "it floats over the conversation instead of narrowing it");
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

test("DG-114 nothing in the card is clipped at 1440, 1280, 1180, 860 and 400 wide", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  for (const [w, h] of [[1440, 1000], [1280, 900], [1180, 900], [860, 900], [400, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    /* Read the card only once the window has taken the new width and drawn it, never the frame before. */
    await page.waitForFunction((width) => innerWidth === width
      && new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))), w);
    /* Crossing 1180 px the calm window puts the card away; one press of its switch must bring it back (it used to
       take two: the first only cleared a request the window still counted). */
    if (!(await shown(page))) {
      await page.locator("#aside-toggle").click();
      await page.locator("#context-panel").waitFor({ state: "visible", timeout: 5000 })
        .catch(() => assert.fail(`${w}: one press of the switch brings the card back`));
    }
    const fit = await page.evaluate(() => {
      const panel = document.getElementById("context-panel"), card = panel.getBoundingClientRect(), slack = 0.5;
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= card.left - slack && r.right <= card.right + slack; };
      const parts = [".lx-pane-name", "#lx-pane-close", ...[...panel.querySelectorAll(".lx-pane-tab")].map((_, i) => `.lx-pane-tab:nth-child(${i + 1})`)];
      const style = getComputedStyle(panel);
      return {
        inWindow: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
        clipped: parts.filter((sel) => { const el = panel.querySelector(sel); return !el || el.getClientRects().length === 0 ? false : !inside(el); }),
        sideways: panel.scrollWidth > panel.clientWidth + 1,
        /* Every tab says its whole name: none is cut short with an ellipsis. */
        cut: [...panel.querySelectorAll(".lx-pane-tab .lx-words")].filter((word) => word.getClientRects().length && word.scrollWidth > word.clientWidth + 1)
          .map((word) => word.textContent),
        /* Whatever does not fit in its height can be scrolled to rather than cut off. */
        reachable: panel.scrollHeight <= panel.clientHeight + 1 || /auto|scroll/.test(style.overflowY),
      };
    });
    assert.equal(fit.inWindow, true, `${w}: the card is inside the window`);
    assert.deepEqual(fit.clipped, [], `${w}: its name, close button and tabs are all inside it`);
    assert.equal(fit.sideways, false, `${w}: nothing runs off its side`);
    assert.deepEqual(fit.cut, [], `${w}: every tab shows its whole name`);
    assert.equal(fit.reachable, true, `${w}: what is below the fold can be scrolled to`);
  }
  assert.deepEqual(errors, []);
});

/* DG-114, the fine geometry of the sample's .pane-top, .ib, .pane-tabs and .pane-body, measured from the card's inner edge:
   a 42px name row with the name 14px in and a 34px close button with a 10px corner 6px from the edge, a tabs row that
   spans the card with its tabs 6px in and 47px tall, the first section 14px under the tabs, and a head that stays at the
   top while the card scrolls. */
async function cardGeometry(page) {
  return page.evaluate(() => {
    const panel = document.getElementById("context-panel"), box = panel.getBoundingClientRect(), style = getComputedStyle(panel);
    const inner = { left: box.left + parseFloat(style.borderLeftWidth), right: box.right - parseFloat(style.borderRightWidth),
      top: box.top + parseFloat(style.borderTopWidth) };
    const rect = (sel) => panel.querySelector(sel).getBoundingClientRect();
    const top = rect(".lx-pane-top"), close = rect("#lx-pane-close"), name = rect(".lx-pane-name"), tabs = rect("#lx-pane-tabs");
    const tab = rect(".lx-pane-tab"), last = [...panel.querySelectorAll(".lx-pane-tab")].filter((t) => t.getClientRects().length).at(-1).getBoundingClientRect();
    const first = [...panel.children].find((c) => c.getClientRects().length && !c.matches(".lx-pane-head, .lx-pane-foot")).getBoundingClientRect();
    const r = (n) => Math.round(n * 2) / 2;
    return { rowHeight: r(top.height), rowTop: r(top.top - inner.top), nameIn: r(name.left - inner.left), closeW: r(close.width),
      closeH: r(close.height), closeRadius: getComputedStyle(panel.querySelector("#lx-pane-close")).borderTopLeftRadius,
      closeIn: r(inner.right - close.right), closeTop: r(close.top - inner.top), tabsLeft: r(tabs.left - inner.left),
      tabsRight: r(inner.right - tabs.right), tabIn: r(tab.left - inner.left), lastIn: r(inner.right - last.right),
      tabHeight: r(tab.height), firstGap: r(first.top - tabs.bottom) };
  });
}
const sampleGeometry = { rowHeight: 42, rowTop: 0, nameIn: 14, closeW: 34, closeH: 34, closeRadius: "10px", closeIn: 6, closeTop: 8,
  tabsLeft: 0, tabsRight: 0, tabIn: 6, lastIn: 6, tabHeight: 47, firstGap: 14 };

test("DG-114 the card's head, close button, tabs and first section sit where the sample puts them", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  for (const [w, h] of [[1440, 950], [400, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForFunction((width) => innerWidth === width
      && new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))), w);
    if (!(await shown(page))) { await page.locator("#aside-toggle").click(); await page.locator("#context-panel").waitFor({ state: "visible" }); }
    for (const [everything, appearance] of [[false, "daylight"], [true, "forest"]]) {
      await page.evaluate(async (look) => (await import("/appearance.js")).changeAppearance(look),
        { showEverything: everything, followSystem: false, appearance });
      await page.waitForFunction((on) => document.documentElement.dataset.everything === (on ? "on" : "off")
        || (!on && document.documentElement.dataset.everything !== "on"), everything);
      if (!(await shown(page))) { await page.locator("#aside-toggle").click(); await page.locator("#context-panel").waitFor({ state: "visible" }); }
      assert.deepEqual(await cardGeometry(page), sampleGeometry, `${w}, Show everything ${everything ? "on" : "off"}, ${appearance}`);
      /* Every tab keeps its name in the card at every width, as the sample's do. */
      assert.equal(await page.locator("#context-panel .lx-pane-tab .lx-words:visible").count(), 6, `${w}: all six tabs say their names`);
    }
  }
  /* A short window: the card scrolls, and its head with the close button stays at its top. */
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.waitForFunction(() => innerHeight === 600);
  if (!(await shown(page))) { await page.locator("#aside-toggle").click(); await page.locator("#context-panel").waitFor({ state: "visible" }); }
  await page.locator('#context-panel .lx-pane-tab[data-pane="plan"]').click();
  const stuck = await page.evaluate(async () => {
    const panel = document.getElementById("context-panel");
    const before = panel.querySelector(".lx-pane-top").getBoundingClientRect().top;
    panel.scrollTop = panel.scrollHeight;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { scrolled: panel.scrollTop, moved: Math.round(panel.querySelector(".lx-pane-top").getBoundingClientRect().top - before) };
  });
  assert.ok(stuck.scrolled > 0, "the short card has something to scroll");
  assert.equal(stuck.moved, 0, "the head stays at the top of the card while it scrolls");
  /* What scrolls under the head and the foot never shows through them. */
  const opaque = await page.evaluate(() => ["#context-panel > .lx-pane-head", "#lx-pane-foot"].map((sel) => {
    const colour = getComputedStyle(document.querySelector(sel)).backgroundColor;
    return /^rgb\(/.test(colour) ? 1 : Number(colour.match(/[\d.]+(?=\)$)/)?.[0] ?? 0);
  }));
  assert.deepEqual(opaque, [1, 1], "the head and the foot are solid over what scrolls under them");
  /* Help, read in the same card, hides the close button but keeps the same 42px row. */
  await page.evaluate(async () => (await import("/help.js")).openHelpForCurrentView());
  await page.locator("#context-help").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => Math.round(document.querySelector("#context-panel .lx-pane-top").getBoundingClientRect().height)), 42,
    "Help keeps the head's 42px row");
  assert.deepEqual(errors, []);
});

/* Q34: a menu that opens from inside the conversation (More, Lockdown, the label picker, "+") used to draw
   under the floating side-panel card. `main` is its own stacking context (z-index 1 with a backdrop filter),
   so nothing inside it could rise above the card (z-index 60), whatever its own z-index. While open, a menu
   now sits on the page itself, exactly where and as it was drawn, and goes back to its place when it closes.
   Headless only. */
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

async function fixture(t, width, { everything = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-popovers-"));
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
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  if (everything) {
    await page.evaluate(async () => (await import("/appearance.js")).changeAppearance({ showEverything: true }));
    await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  }
  await page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, run.sessionId);
  await page.locator(".message.assistant").first().waitFor();
  await watchLifts(page);
  return { page, errors };
}

async function openCard(page) {
  if (await page.locator("#context-panel").isVisible()) return;
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "visible" });
}

/**
 * Records how a menu and everything in it look in their own place at the moment it is lifted into the top
 * layer (when `popover` is set on it), so the open menu can be compared with exactly that.
 */
const watchLifts = (page) => page.evaluate(() => {
  globalThis.__look = (menu) => [menu, ...menu.querySelectorAll("*")].filter((el) => el.getClientRects().length).map((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [el.id || el.className || el.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
      s.color, s.backgroundColor, s.fontSize, s.fontWeight, s.fontFamily, s.borderTop, s.borderRadius, s.boxShadow,
      s.backdropFilter, s.padding].join(" | ");
  });
  globalThis.__home = new Map();
  const set = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "popover") globalThis.__home.set(this, globalThis.__look(this));
    return set.call(this, name, value);
  };
});

/**
 * The open menu, measured: whether it was lifted, how much of it a click can reach, and how it and everything in
 * it compare with how they looked in their own place.
 */
const measure = (page, selector) => page.evaluate((sel) => {
  const menu = document.querySelector(sel), box = menu.getBoundingClientRect();
  /* Points in a rounded corner are outside the menu's own shape, so the page behind rightly answers there. */
  const round = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 0;
  const corner = (x, y) => (x < box.left + round || x > box.right - round) && (y < box.top + round || y > box.bottom - round);
  let points = 0, covered = 0;
  const under = new Set();
  for (let x = box.left + 3; x < Math.min(box.right, innerWidth) - 3; x += 12)
    for (let y = Math.max(box.top, 0) + 3; y < Math.min(box.bottom, innerHeight) - 3; y += 12) {
      if (corner(x, y)) continue;
      points++;
      const hit = document.elementFromPoint(x, y);
      if (!menu.contains(hit)) { covered++; under.add(hit?.id || String(hit?.className) || hit?.tagName); }
    }
  /* Its looks are compared without the keyboard in it: the focus ring comes after it opens, not from where it is. */
  const focused = menu.contains(document.activeElement) ? document.activeElement : null;
  focused?.blur();
  const shown = globalThis.__look(menu);
  focused?.focus();
  return { lifted: menu.matches(":popover-open"), points, covered, under: [...under].slice(0, 4),
    shown, home: globalThis.__home.get(menu) ?? null };
}, selector);

for (const width of [1440, 860, 400]) {
  test(`Q34 at ${width} px More opens over the side-panel card, where and as it always drew, and goes home on close`, async (t) => {
    const { page, errors } = await fixture(t, width);
    const place = await page.evaluate(() => { const menu = document.getElementById("lx-more-menu"); return { parent: menu.parentElement.tagName, before: menu.previousElementSibling?.id }; });
    await openCard(page);
    await page.locator("#lx-more").click();
    await page.locator("#lx-more-menu").waitFor({ state: "visible" });
    const seen = await measure(page, "#lx-more-menu");
    assert.ok(seen.points > 20, "the menu was measured");
    assert.equal(seen.covered, 0, `nothing covers the menu (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
    assert.equal(seen.lifted, true, "it is lifted above the card");
    assert.deepEqual(seen.shown, seen.home, "it and every row in it open where and as they always drew");
    /* Its keys still work, and a click on one of its rows still reaches it. */
    assert.equal(await page.evaluate(() => document.getElementById("lx-more-menu").contains(document.activeElement)), true, "the keyboard is in it");
    await page.keyboard.press("Escape");
    await page.locator("#lx-more-menu").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lx-more", "Escape hands the keyboard back to More");
    const home = await page.evaluate(() => { const menu = document.getElementById("lx-more-menu"); return { parent: menu.parentElement.tagName, before: menu.previousElementSibling?.id, inline: menu.getAttribute("style") ?? "" }; });
    assert.deepEqual({ parent: home.parent, before: home.before }, place, "closed, it is back in its own place");
    assert.equal(home.inline, "", "with nothing left on it from being open");
    /* An outside click still closes it, and it opens again the same way. */
    await page.locator("#lx-more").click();
    await page.locator("#lx-more-menu").waitFor({ state: "visible" });
    await page.mouse.click(5, 895);
    await page.locator("#lx-more-menu").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  });
}

test("Q34 the label picker, built on each open, also draws over the card and leaves nothing behind", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await openCard(page);
  await page.evaluate(async () => {
    const { openLabelPicker } = await import("/labels-ui.js");
    await openLabelPicker(document.getElementById("thread-labels"), document.getElementById("conversation").dataset.sessionId || "x");
  });
  await page.locator(".label-picker").waitFor({ state: "visible" });
  const seen = await measure(page, ".label-picker");
  assert.equal(seen.covered, 0, `nothing covers the picker (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
  assert.deepEqual(seen.shown, seen.home, "it opens where and as it always drew");
  await page.keyboard.press("Escape");
  await page.locator(".label-picker").waitFor({ state: "detached" });
  assert.equal(await page.locator(".label-picker").count(), 0, "closed, it is gone from the page");
  assert.deepEqual(errors, []);
});

test("Q34 a menu inside a part that scrolls stays in its place, and a lifted one closes when the window changes size", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const inScroller = await page.evaluate(async () => {
    const { popover } = await import("/popover.js");
    const box = document.createElement("div");
    box.style.overflowY = "auto";
    box.style.height = "120px";
    const trigger = document.createElement("button"), panel = document.createElement("div");
    trigger.textContent = "Open";
    panel.hidden = true;
    panel.textContent = "Menu";
    box.append(trigger, panel);
    document.querySelector("body > main").append(box);
    const control = popover(trigger, panel);
    control.open();
    const seen = { lifted: panel.hasAttribute("popover"), shown: !panel.hidden };
    control.close();
    box.remove();
    return seen;
  });
  assert.deepEqual(inScroller, { lifted: false, shown: true }, "a menu that scrolls with its page is left where it is, and still opens");
  await page.locator("#lx-more").click();
  await page.locator("#lx-more-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#lx-more-menu").getAttribute("popover"), "manual", "More is lifted while open");
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.locator("#lx-more-menu").waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => assert.fail("a menu pinned in place closes when the window changes size"));
  assert.equal(await page.locator("#lx-more-menu").getAttribute("popover"), null, "and is no longer lifted");
  assert.deepEqual(errors, []);
});

test("Q34 a tracked menu that is hidden, not removed, on close is put back each time and lifts again when reopened", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const seen = await page.evaluate(async () => {
    const { trackPopover } = await import("/popover.js");
    const header = document.querySelector("body > main > header");
    const trigger = document.createElement("button"), panel = document.createElement("div");
    trigger.textContent = "Room";
    panel.textContent = "Room menu";
    panel.style.position = "absolute";
    header.append(trigger, panel);
    const rounds = [];
    for (let round = 0; round < 2; round++) {
      panel.hidden = false;
      const entry = trackPopover(trigger, panel, () => { panel.hidden = true; });
      const open = { lifted: panel.matches(":popover-open") };
      entry.close();
      rounds.push({ ...open, after: panel.getAttribute("popover"), inline: panel.style.cssText });
    }
    trigger.remove();
    panel.remove();
    return rounds;
  });
  assert.deepEqual(seen, [{ lifted: true, after: null, inline: "position: absolute;" }, { lifted: true, after: null, inline: "position: absolute;" }],
    "each close puts it back as it was, so the next open lifts it again");
  assert.deepEqual(errors, []);
});

/* The message box sits in the scrolling conversation but is placed against `main`, so scrolling never moves it:
   its menus are lifted too (Codex's review of a789ac29 found them still under the card). */
for (const [width, menus] of [[1440, [["#mode-chip", "#mode-menu"]]], [400, [["#mode-chip", "#mode-menu"], ["#lx-plus", "#lx-plus-menu"]]]]) {
  test(`Q34 at ${width} px the message box's menus open over the side-panel card, where and as they always drew`, async (t) => {
    const { page, errors } = await fixture(t, width, { everything: true });
    await openCard(page);
    for (const [button, selector] of menus) {
      await page.locator(button).click();
      await page.locator(selector).waitFor({ state: "visible" });
      const seen = await measure(page, selector);
      assert.equal(seen.lifted, true, `${selector} is lifted above the card`);
      assert.ok(seen.points > 20, `${selector} was measured`);
      assert.equal(seen.covered, 0, `nothing covers ${selector} (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
      assert.deepEqual(seen.shown, seen.home, `${selector} and every row in it open where and as they always drew`);
      await page.keyboard.press("Escape");
      await page.locator(selector).waitFor({ state: "hidden" });
      assert.equal(await page.locator(selector).getAttribute("popover"), null, `${selector} is put back when it closes`);
    }
    assert.deepEqual(errors, []);
  });
}

test("Q34 a menu centred by its own transform (the phone's meter) opens where it drew, not shifted twice", async (t) => {
  const { page, errors } = await fixture(t, 400, { everything: true });
  const seen = await page.evaluate(async () => {
    const { popover } = await import("/popover.js");
    const header = document.querySelector("body > main > header");
    const trigger = document.createElement("button"), panel = document.createElement("div");
    trigger.textContent = "Meter";
    panel.hidden = true;
    panel.textContent = "Centred by a transform";
    Object.assign(panel.style, { position: "absolute", top: "100%", left: "50%", width: "200px", transform: "translateX(-50%)" });
    header.append(trigger, panel);
    const control = popover(trigger, panel);
    control.open();
    const result = { lifted: panel.matches(":popover-open"), shown: globalThis.__look(panel), home: globalThis.__home.get(panel) };
    control.close();
    result.after = panel.style.cssText;
    trigger.remove();
    panel.remove();
    return result;
  });
  assert.equal(seen.lifted, true);
  assert.deepEqual(seen.shown, seen.home, "the transform applies once, as in its own place");
  assert.match(seen.after, /translateX\(-50%\)/, "and its own transform is kept");
  assert.deepEqual(errors, []);
});

test("Q34 only a scroller that carries the menu keeps it in place: one it escapes does not", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const seen = await page.evaluate(async () => {
    const { popover } = await import("/popover.js");
    const main = document.querySelector("body > main");
    const tryIn = (scrollerPosition) => {
      const scroller = document.createElement("div"), trigger = document.createElement("button"), panel = document.createElement("div");
      Object.assign(scroller.style, { overflowY: "auto", height: "80px", position: scrollerPosition });
      trigger.textContent = "Open";
      panel.hidden = true;
      panel.textContent = "Menu";
      Object.assign(panel.style, { position: "absolute", top: "40px", left: "40px" });
      scroller.append(trigger, panel);
      main.append(scroller);
      const control = popover(trigger, panel);
      control.open();
      const lifted = panel.matches(":popover-open");
      control.close();
      scroller.remove();
      return lifted;
    };
    /* A static scroller is not the absolutely placed menu's containing block, so scrolling it leaves the menu
       where it is (the message box's case); a positioned scroller holds the menu and scrolls it along. */
    return { escapes: tryIn("static"), carried: tryIn("relative") };
  });
  assert.deepEqual(seen, { escapes: true, carried: false });
  assert.deepEqual(errors, []);
});

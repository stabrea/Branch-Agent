/* Redesign phase 1: every select opens a glass list, and every icon-only button has glass hover help.
   The native select stays the source of truth, so its label, its value and its change event are the
   ones everything else already uses. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openSettingFor } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, contextOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-glass-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  await fetch(new URL("/api/deployment/suggestion", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "updates", answer: "never" }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  return { app, page, errors };
}

test("every single-choice select in the page is dressed, those drawn later too, and none is taken out", async (t) => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const written = [...html.matchAll(/<select\b[^>]*>/g)].filter((m) => !/\bmultiple\b/.test(m[0])).length;
  assert.ok(written >= 50, `index.html has its selects (${written})`);
  const f = await fixture(t);
  const seen = await f.page.evaluate(() => {
    const all = [...document.querySelectorAll("select")].filter((select) => !select.multiple && select.size <= 1);
    return { all: all.length, dressed: all.filter((select) => select.classList.contains("glass")).length,
      popup: all.filter((select) => select.getAttribute("aria-haspopup") === "listbox").length };
  });
  assert.ok(seen.all >= written, "every select is still there");
  assert.equal(seen.dressed, seen.all, "and every one is dressed");
  assert.equal(seen.popup, seen.all, "and says it opens a list");
  assert.deepEqual(f.errors, []);
});

test("a select opens the glass list; arrows, Enter and type-ahead choose through the select itself", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  const select = f.page.locator("#policy-preset");
  await f.page.waitForFunction(() => document.getElementById("policy-preset").options.length >= 4);
  await f.page.evaluate(() => {
    globalThis.__changes = [];
    document.getElementById("policy-preset").addEventListener("change", (event) => globalThis.__changes.push(event.target.value));
  });
  const before = await select.inputValue();
  await select.click();
  const list = f.page.locator("#glass-list");
  await list.waitFor({ state: "visible" });
  assert.equal(await list.getAttribute("role"), "listbox");
  assert.equal(await select.getAttribute("aria-expanded"), "true");
  const texts = await list.locator("[role=option]").allInnerTexts();
  assert.deepEqual(texts, await select.evaluate((node) => [...node.options].map((o) => o.textContent.trim())));
  assert.equal(await f.page.evaluate(() => document.activeElement.getAttribute("aria-selected")), "true", "the chosen one has the keyboard");
  await f.page.keyboard.press("ArrowDown");
  const aimed = await f.page.evaluate(() => document.activeElement.textContent);
  await f.page.keyboard.press("Enter");
  await list.waitFor({ state: "hidden" });
  const after = await select.inputValue();
  assert.notEqual(after, before, "the select's own value changed");
  assert.equal(await select.evaluate((node) => node.options[node.selectedIndex].textContent.trim()), aimed.trim());
  assert.deepEqual(await f.page.evaluate(() => globalThis.__changes), [after], "one change event, from the select");
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "policy-preset", "the keyboard is back on the select");
  /* Enter opens it from the keyboard; the first letter jumps; Escape closes and gives the keyboard back. */
  await f.page.keyboard.press("Enter");
  await list.waitFor({ state: "visible" });
  const first = (await list.locator("[role=option]").allInnerTexts()).find((text) => /^R/i.test(text));
  await f.page.keyboard.press("r");
  assert.equal((await f.page.evaluate(() => document.activeElement.textContent)).trim(), first?.trim());
  await f.page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "policy-preset");
  assert.equal(await select.inputValue(), after, "Escape chose nothing");
  assert.deepEqual(f.errors, []);
});

test("pressing the select again closes the list, and a click elsewhere does too", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  const select = f.page.locator("#policy-preset"), list = f.page.locator("#glass-list");
  await select.click();
  await list.waitFor({ state: "visible" });
  await select.click();
  await list.waitFor({ state: "hidden" });
  assert.equal(await select.getAttribute("aria-expanded"), "false");
  await select.click();
  await list.waitFor({ state: "visible" });
  await f.page.locator("#policy-card h2").click();
  await list.waitFor({ state: "hidden" });
  /* Filling the form the usual way still works, because the select is still the select. */
  await select.selectOption("read-only");
  assert.equal(await select.inputValue(), "read-only");
  assert.deepEqual(f.errors, []);
});

test("an icon-only button explains itself in glass on hover, once, and never shows the system's own tip too", async (t) => {
  const f = await fixture(t);
  const plus = f.page.locator("#lx-plus");
  await plus.waitFor({ state: "visible" });
  const words = await plus.getAttribute("aria-label");
  await plus.hover();
  const tip = f.page.locator("#glass-tip");
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), words);
  assert.equal(await tip.getAttribute("role"), "tooltip");
  assert.equal(await plus.getAttribute("title"), null, "the system's tooltip is not shown as well");
  assert.equal(await plus.getAttribute("aria-describedby"), "glass-tip");
  await f.page.mouse.move(700, 300);
  await f.page.mouse.down();
  await f.page.mouse.up();
  await tip.waitFor({ state: "hidden" });
  assert.equal(await plus.getAttribute("aria-describedby"), null, "and what describes it is put back as it was");
  /* A button that says its own words needs no tip. */
  await f.page.locator("#lx-more").hover();
  await f.page.waitForTimeout(700);
  assert.equal(await tip.isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test("on a touch-only phone the select keeps its own picker and no hover help appears", async (t) => {
  const f = await fixture(t, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  assert.equal(await f.page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches), true);
  await openSettingFor(f.page, "#policy-preset");
  await f.page.locator("#policy-preset").dispatchEvent("mousedown", { button: 0 });
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator("#glass-list").isVisible(), false, "the phone's own picker is used");
  await f.page.locator("#lx-plus").tap().catch(() => undefined);
  await f.page.waitForTimeout(600);
  assert.equal(await f.page.locator("#glass-tip").isVisible(), false, "no hover help from a touch");
  assert.deepEqual(f.errors, []);
});

/* ---------------------------------------------------------------- integration review */

test("integration review: the list sits flush under the select and fully covers the help line under it", async (t) => {
  for (const viewport of [{ width: 1440, height: 950 }, { width: 390, height: 844 }]) {
    const f = await fixture(t, { viewport });
    await openSettingFor(f.page, "#policy-preset");
    /* phase2/settings: on a phone the Settings list is a search, a page choice and the level above the page,
       so "if needed" left the select at the very bottom, where the list rightly opens upwards. Room below it: */
    await f.page.locator("#policy-preset").evaluate((node) => node.scrollIntoView({ block: "center" }));
    /* Pressed at once, while the window may still be rising into place: the list follows the select there
       (public/glass-select.js placeWhenSettled), as it must for a person who taps straight away. */
    await f.page.locator("#policy-preset").click();
    await f.page.locator("#glass-list").waitFor({ state: "visible" });
    await f.page.waitForTimeout(300); // the opening glide is over
    const seen = await f.page.evaluate(() => {
      if (document.getElementById("glass-list").hidden) return { closed: true };
      const select = document.getElementById("policy-preset").getBoundingClientRect();
      const list = document.getElementById("glass-list");
      const box = list.getBoundingClientRect();
      const note = document.getElementById("policy-preset").nextElementSibling.getBoundingClientRect();
      const probe = document.elementFromPoint(note.left + 20, Math.ceil(select.bottom) + 1);
      return { gap: box.top - select.bottom, overNote: list.contains(probe), noteTop: note.top, listTop: box.top,
        alpha: Number(/\/\s*([\d.]+)\)/.exec(getComputedStyle(list).backgroundColor)?.[1] ?? 1) };
    });
    assert.ok(!seen.closed, `the list is still open at ${viewport.width}`);
    assert.ok(seen.gap >= 0 && seen.gap <= 2, `flush under the select at ${viewport.width} (gap ${seen.gap})`);
    assert.ok(seen.overNote, `the list, not the help line, is what shows right under the select at ${viewport.width}`);
    assert.ok(seen.alpha >= 0.97, `the glass is opaque enough to read (${seen.alpha})`);
    assert.deepEqual(f.errors, []);
  }
});

test("integration review: groups, greyed choices, one change event, the form's value, and a list that changes while open", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  await f.page.evaluate(() => {
    const form = document.createElement("form");
    form.id = "probe-form";
    form.innerHTML = '<label for="probe">Pick one</label><select id="probe" name="pick">'
      + '<optgroup label="Fruit"><option value="a">Apple</option><option value="b" disabled>Banana</option></optgroup>'
      + '<optgroup label="Roots"><option value="c">Carrot</option></optgroup></select>';
    document.getElementById("policy-preset").closest(".card").append(form);
    globalThis.__probe = [];
    form.querySelector("select").addEventListener("change", (event) => globalThis.__probe.push(event.target.value));
  });
  const select = f.page.locator("#probe"), list = f.page.locator("#glass-list");
  await f.page.waitForFunction(() => document.getElementById("probe").classList.contains("glass"));
  await select.scrollIntoViewIfNeeded();
  await select.click();
  await list.waitFor({ state: "visible" });
  assert.equal(await list.getAttribute("aria-label"), "Pick one", "the list is named by the select's label");
  assert.deepEqual(await list.locator("[role=group]").evaluateAll((groups) => groups.map((g) => g.getAttribute("aria-label"))), ["Fruit", "Roots"]);
  assert.equal(await list.locator("[role=option]", { hasText: "Banana" }).getAttribute("aria-disabled"), "true");
  await list.locator("[role=option]", { hasText: "Banana" }).click({ force: true });
  assert.equal(await list.isVisible(), true, "a greyed choice does nothing");
  await f.page.keyboard.press("ArrowDown");
  assert.equal((await f.page.evaluate(() => document.activeElement.textContent)).trim(), "Carrot", "arrows skip a greyed choice");
  await f.page.keyboard.press("Enter");
  await list.waitFor({ state: "hidden" });
  assert.deepEqual(await f.page.evaluate(() => globalThis.__probe), ["c"], "exactly one change event");
  assert.equal(await f.page.evaluate(() => new FormData(document.getElementById("probe-form")).get("pick")), "c", "the form sends the chosen value");
  await select.click();
  await list.waitFor({ state: "visible" });
  await f.page.evaluate(() => document.getElementById("probe").prepend(new Option("Aubergine", "z")));
  await list.waitFor({ state: "hidden" });
  assert.equal(await select.inputValue(), "c", "a list that changed under the pointer closes and chooses nothing");
  assert.deepEqual(await f.page.evaluate(() => globalThis.__probe), ["c"]);
  assert.deepEqual(f.errors, []);
});

test("an open list stays open when the window's refresh writes the same choices again", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  const select = f.page.locator("#policy-preset"), list = f.page.locator("#glass-list");
  await select.click();
  await list.waitFor({ state: "visible" });
  /* What a redraw on the window's refresh every 3 s can do: the same choices written again (approvals.js
     did it to the presets until p2-shell). That closed the list on the macOS runner before it could be
     measured (trunk 677e7d34); any select's redraw must leave an open list alone when nothing changed. */
  await f.page.evaluate(() => {
    const picker = document.getElementById("policy-preset");
    picker.replaceChildren(...[...picker.options].map((option) => new Option(option.text, option.value, false, option.selected)));
  });
  await f.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await list.isVisible(), true, "the same choices written again leave the list open");
  assert.equal(await select.getAttribute("aria-expanded"), "true");
  assert.deepEqual(f.errors, []);
});

test("phase2/settings integration: a list opened while the Settings window is still rising lands flush under its select", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  await f.page.locator(".lx-settings-close").click();
  /* Opened and pressed in one go, the way a quick tap lands while the window rises for a fifth of a second. */
  const rising = await f.page.evaluate(() => {
    globalThis.branchLayout.go("settings:permissions");
    const moving = document.querySelector(".lx-settings-win").getAnimations().some((animation) => animation.playState === "running");
    document.getElementById("policy-preset").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    return moving;
  });
  assert.equal(rising, true, "the window was still rising when the select was pressed");
  await f.page.locator("#glass-list").waitFor({ state: "visible" });
  await f.page.waitForTimeout(500);
  const gap = await f.page.evaluate(() => {
    const select = document.getElementById("policy-preset").getBoundingClientRect(), list = document.getElementById("glass-list").getBoundingClientRect();
    return list.top >= select.bottom - 1 ? list.top - select.bottom : select.top - list.bottom;
  });
  assert.ok(Math.abs(gap) <= 2, `the list was left where the select was while it moved (gap ${gap})`);
  assert.deepEqual(f.errors, []);
});

/* Redesign phase 1: every select opens a glass list, and owner-facing controls reuse their accessible
   descriptions as glass hover help. The native select stays the source of truth, so its label, value and
   change event are the ones everything else already uses. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace, openSettingFor } from "./places.mjs";
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce", ...contextOptions });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("every ordinary single-choice select is dressed while segmented sources stay native", async (t) => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const written = [...html.matchAll(/<select\b[^>]*>/g)].filter((m) => !/\bmultiple\b/.test(m[0])).length;
  assert.ok(written >= 50, `index.html has its selects (${written})`);
  const f = await fixture(t);
  const seen = await f.page.evaluate(() => {
    const all = [...document.querySelectorAll("select")].filter((select) => !select.multiple && select.size <= 1);
    const native = all.filter((select) => select.dataset.native === "keep");
    const dressed = all.filter((select) => select.dataset.native !== "keep");
    return { all: all.length, native: native.length,
      nativeDressed: native.filter((select) => select.classList.contains("glass")).length,
      dressed: dressed.filter((select) => select.classList.contains("glass")).length,
      popup: dressed.filter((select) => select.getAttribute("aria-haspopup") === "listbox").length };
  });
  assert.ok(seen.all >= written, "every select is still there");
  assert.ok(seen.native > 0, "segmented controls keep a real native source");
  assert.equal(seen.nativeDressed, 0, "a segmented source is not dressed as a second control");
  assert.equal(seen.dressed, seen.all - seen.native, "every ordinary select is dressed");
  assert.equal(seen.popup, seen.all - seen.native, "every ordinary select says it opens a list");
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
  const press = () => select.dispatchEvent("mousedown", { button: 0 });
  await press();
  assert.equal(await list.isVisible(), true);
  await press();
  assert.equal(await list.isHidden(), true);
  assert.equal(await select.getAttribute("aria-expanded"), "false");
  await press();
  assert.equal(await list.isVisible(), true);
  await f.page.locator("#policy-card h2").dispatchEvent("click");
  assert.equal(await list.isHidden(), true);
  /* Filling the form the usual way still works, because the select is still the select. */
  const changed = await select.evaluate((node) => {
    node.value = "read-only";
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return node.value;
  });
  assert.equal(changed, "read-only");
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

test("a described control reuses its live English and French help without changing its accessibility link", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#policy-preset");
  const control = f.page.locator("#policy-preset"), tip = f.page.locator("#glass-tip");
  const description = async () => control.evaluate((node) => (node.getAttribute("aria-describedby") || "")
    .split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" "));
  const linked = await control.getAttribute("aria-describedby");
  const english = await description();
  assert.ok(english, "the real setting has explanatory words");

  await control.hover();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), english, "hover help reuses the accessible sentence");
  assert.equal(await control.getAttribute("aria-describedby"), linked, "the existing accessibility link is unchanged");

  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const french = await description();
  assert.ok(french && french !== english, "the source sentence changed with the language");
  assert.equal(await tip.innerText(), french, "open help refreshes as soon as its source language changes");
  await f.page.mouse.down();
  await f.page.mouse.up();
  await tip.waitFor({ state: "hidden" });
  await f.page.mouse.move(10, 10);
  await control.hover();
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), french, "the tooltip reads the current sentence instead of copying one");
  assert.equal(await control.getAttribute("aria-describedby"), linked);
  assert.deepEqual(f.errors, []);
});

test("a described text button moves its native title so only the glass help appears", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "described-button-probe";
    button.textContent = "Check now";
    button.title = "Checks the connection";
    button.setAttribute("aria-description", "Checks the connection without changing it.");
    document.getElementById("workspace").append(button);
  });
  const button = f.page.locator("#described-button-probe"), tip = f.page.locator("#glass-tip");
  await button.dispatchEvent("pointerover", { pointerType: "mouse" });
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), "Checks the connection without changing it.");
  assert.equal(await button.getAttribute("title"), null, "the browser cannot show a second tooltip");
  assert.equal(await button.getAttribute("data-native-tip"), "Checks the connection");
  assert.deepEqual(f.errors, []);
});

test("keyboard focus shows the same help and Escape closes it", async (t) => {
  const f = await fixture(t);
  await openSettingFor(f.page, "#appearance-language");
  const control = f.page.locator("#appearance-language"), tip = f.page.locator("#glass-tip");
  await control.focus();
  await f.page.keyboard.press("Shift+Tab");
  await f.page.keyboard.press("Tab");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "appearance-language");
  assert.ok(await control.getAttribute("aria-describedby"), "the control has help to show");
  assert.ok(await control.evaluate((node) => (node.getAttribute("aria-describedby") || "").split(/\s+/)
    .some((id) => document.getElementById(id)?.textContent?.trim())), "the linked help has words");
  await tip.waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await tip.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("a mouse-focused text field keeps delayed help while keyboard focus is immediate", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "modality-help-probe";
    input.setAttribute("aria-description", "Words for the modality probe.");
    document.getElementById("workspace").prepend(input);
  });
  const input = f.page.locator("#modality-help-probe"), tip = f.page.locator("#glass-tip");
  await input.click();
  await f.page.waitForTimeout(500);
  assert.equal(await tip.isVisible(), false, "click focus is not mistaken for keyboard navigation");
  await f.page.keyboard.press("Shift+Tab");
  await f.page.keyboard.press("Tab");
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), "Words for the modality probe.");
  assert.deepEqual(f.errors, []);
});

test("hover help covers the text of a wrapping control label", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const label = document.createElement("label");
    label.id = "wrapping-help-label";
    label.innerHTML = '<input type="checkbox" aria-description="Help across the whole label."> Label words';
    document.getElementById("workspace").prepend(label);
    label.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  });
  const tip = f.page.locator("#glass-tip");
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), "Help across the whole label.");
  assert.deepEqual(f.errors, []);
});

test("a segmented control shows the description linked to its native source", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const note = document.createElement("p");
    note.id = "hover-segment-note";
    note.textContent = "Choose how often Branch may do this.";
    const control = globalThis.branchControlMakers.segmented({ id: "hover-segment" });
    control.querySelector("select").setAttribute("aria-describedby", note.id);
    document.getElementById("workspace").append(control, note);
  });
  const source = f.page.locator("#hover-segment");
  const control = f.page.locator(".segmented-control:has(#hover-segment)");
  const words = await source.evaluate((node) => (node.getAttribute("aria-describedby") || "").split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" "));
  assert.ok(words, "the native source has real explanatory words");
  await control.hover();
  const tip = f.page.locator("#glass-tip");
  await tip.waitFor({ state: "visible" });
  assert.equal(await tip.innerText(), words);
  assert.deepEqual(f.errors, []);
});

test("keyboard help for a segmented source is anchored to its visible control", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const note = document.createElement("p");
    note.id = "keyboard-segment-note";
    note.textContent = "Choose how Branch should ask.";
    const control = globalThis.branchControlMakers.segmented({ id: "keyboard-segment" });
    control.querySelector("select").setAttribute("aria-describedby", note.id);
    document.getElementById("workspace").prepend(control, note);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    control.querySelector("select").focus();
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", bubbles: true }));
  });
  const tip = f.page.locator("#glass-tip");
  await tip.waitFor({ state: "visible" });
  const position = await f.page.evaluate(() => {
    const wrapper = document.querySelector(".segmented-control:has(#keyboard-segment)").getBoundingClientRect();
    const source = document.getElementById("keyboard-segment").getBoundingClientRect();
    return { tipTop: Number.parseFloat(document.getElementById("glass-tip").style.top),
      wrapperBottom: wrapper.bottom, sourceBottom: source.bottom };
  });
  assert.ok(Math.abs(position.tipTop - (position.wrapperBottom + 8)) < 1,
    "the tooltip sits below the visible segmented control");
  assert.ok(Math.abs(position.tipTop - (position.sourceBottom + 8)) > 1,
    "the clipped native source is not used as the anchor");
  assert.deepEqual(f.errors, []);
});

test("a disabled segmented control shows no hover help", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const note = document.createElement("p");
    note.id = "disabled-segment-note";
    note.textContent = "This setting is unavailable.";
    const control = globalThis.branchControlMakers.segmented({ id: "disabled-segment" });
    control.querySelector("select").setAttribute("aria-describedby", note.id);
    control.disabled = true;
    document.getElementById("workspace").append(control, note);
  });
  const control = f.page.locator(".segmented-control:has(#disabled-segment)");
  await control.hover();
  await f.page.waitForTimeout(700);
  assert.equal(await f.page.locator("#glass-tip").isVisible(), false);
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
    /* ...and once the window has risen into place. Playwright's click on a still-moving select retries with a
       scroll of its own, and any scroll closes an open list (rightly); a person's click at the same point keeps
       it open (checked 6 of 6 at 390, integration). A list opened mid-rise follows its select: the next test. */
    await f.page.locator(".lx-settings-win").evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished)));
    /* A click that lands while the window is still settling can be swallowed (Windows saw the list stay
       shut for 30 s), so it is pressed again while it is still not open. */
    const list = f.page.locator("#glass-list");
    for (let tries = 0; tries < 10 && !(await list.isVisible()); tries += 1) {
      await f.page.locator("#policy-preset").click();
      await list.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
    }
    await list.waitFor({ state: "visible" });
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

test("the window's refresh leaves a half-filled ceiling, half-filled connection minutes and the category choosers alone", async (t) => {
  const f = await fixture(t);
  /* ci-flakes-3 listed three more places where the window's refresh every 3 s wrote over what somebody
     was in the middle of. Each is driven here by the very call that refresh makes, with no sleep. */
  await openSettingFor(f.page, "#policy-tool-limit");
  await f.page.locator("#policy-tool-limit").fill("42");
  await f.page.evaluate(() => globalThis.branchApprovals.render());
  assert.equal(await f.page.locator("#policy-tool-limit").inputValue(), "42", "the ceiling being typed is still theirs");

  /* The category rows used to be thrown away and made again every 3 s, which shut an open list under
     the person and threw the keyboard out of it. A mark of our own survives only if the row does. */
  await f.page.waitForFunction(() => document.querySelectorAll("#approval-categories select").length > 0);
  const category = f.page.locator("#approval-categories select").first();
  await category.waitFor({ state: "visible" });
  await category.evaluate((one) => { one.dataset.stillTheirs = "yes"; });
  await category.focus();
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), "SELECT", "the chooser starts with the keyboard");
  await f.page.evaluate(() => globalThis.branchMisc.render());
  assert.equal(await f.page.locator("#approval-categories select").first().getAttribute("data-still-theirs"), "yes",
    "a chooser somebody may have open is not thrown away and made again");
  assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), "SELECT", "and the keyboard is still in it");

  await openPlace(f.page, "customize:connections");
  await f.page.locator("#mcp-keep-warm").fill("17");
  await f.page.evaluate(() => globalThis.branchMcpWorkbench.render());
  assert.equal(await f.page.locator("#mcp-keep-warm").inputValue(), "17", "the minutes being typed are still theirs");
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

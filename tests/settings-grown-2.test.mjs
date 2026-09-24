/**
 * phase2/settings: Settings grown up — part 2 of 3
 * S2, S3, S9 directories, S11, S13, S15, S16, S17, S19, S20:
 * controls and defaults, directory navigation, keeping place, mirrors, second-opinion limits, parity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fixture, openSettings, visitEverything, switchEverythingOn, whereEach, cog, cardState, INVENTORY, SETTINGS_DIRECTORIES, SAFETY, INDEX } from "./settings-grown-helpers.mjs";

test("S2 every setting has a real control, where the audit says it lives", async (t) => {
  const f = await fixture(t);
  await visitEverything(f.page);
  await switchEverythingOn(f.page);
  await visitEverything(f.page);
  const where = await whereEach(f.page);
  const none = INVENTORY.filter((s) => where[s.id] === null).map((s) => s.id);
  assert.deepEqual(none, [], "these settings have no control in the window");
  /* Lockdown is the one switch that lives in the rail and the More menu rather than on a page. */
  const astray = INVENTORY.filter((s) => where[s.id] !== s.home && !(s.id === "lockdown" && where[s.id] === "elsewhere"))
    .map((s) => `${s.id}: ${where[s.id]} (audit: ${s.home})`);
  assert.deepEqual(astray, [], "these controls are not where the audit says they live");
  /* Rows added since the audit point at a real control too, at the home they give. */
  const windowsOnly = new Set(["addons-windows-without-wall"]);
  /* How much to show sits in the Settings list itself, beside every page rather than on one. */
  const inTheList = new Set(["sg-level-seg"]);
  const since = INDEX.values();
  assert.ok([...since].filter((row) => !INVENTORY.some((s) => s.id === row[0])).length >= 8, "the settings added at integration are in the index");
  assert.deepEqual([...INDEX.values()].filter((row) => !INVENTORY.some((s) => s.id === row[0]) && !(windowsOnly.has(row[0]) && process.platform !== "win32")).filter((row) => where[row[0]] !== (inTheList.has(row[0]) ? "elsewhere" : row[1])).map((row) => `${row[0]}: ${where[row[0]]} (index: ${row[1]})`), [],
    "these settings added since the audit have no control where the index says");
  assert.deepEqual(f.errors, []);
});

test("S3 on a fresh install every setting starts at its real default", async (t) => {
  const f = await fixture(t);
  await visitEverything(f.page);
  const checked = INVENTORY.filter((s) => !s.gated && ["switch", "three-way", "select", "number"].includes(s.type) && s.defaultRaw !== null);
  const found = await f.page.evaluate((rows) => rows.map(({ id, type }) => {
    const node = document.getElementById(id);
    if (!node || !("value" in node)) return [id, undefined];
    if (type === "switch") return [id, node.type === "checkbox" ? node.checked : node.value];
    return [id, node.value];
  }), checked.map(({ id, type }) => ({ id, type })));
  const wrong = [];
  let compared = 0;
  for (const [id, value] of found) {
    if (value === undefined) continue;
    const want = INVENTORY.find((s) => s.id === id).defaultRaw;
    const same = typeof value === "boolean" ? value === (want === true || want === "on") : String(value) === String(want);
    compared += 1;
    if (!same) wrong.push(`${id}: ${JSON.stringify(value)} (audit: ${JSON.stringify(want)})`);
  }
  assert.ok(compared > 250, `only ${compared} defaults could be read`);
  assert.deepEqual(wrong, [], "these settings do not start at their real default");
});

for (const [width, height] of [[1440, 950], [390, 844]]) {
  test(`S9 directories at ${width}x${height} open their real Branch places`, async (t) => {
    const f = await fixture(t, { width, height });
    for (const [page, entries] of Object.entries(SETTINGS_DIRECTORIES)) {
      await openSettings(f.page, page);
      assert.equal(await f.page.locator(`#lx-page-${page} .settings-directory-card`).count(), entries.length);
      for (const [id, place, tab] of entries) {
        const card = f.page.locator(`#settings-directory-${page}-${id}`);
        const open = card.getByRole("button");
        assert.match(await open.getAttribute("aria-label"), /^Open .+/);
        assert.equal(await open.getAttribute("aria-describedby"), `${await card.getAttribute("id")}-description`);
        await open.click();
        assert.equal(await f.page.locator("#settings-window").isVisible(), false);
        assert.equal(await f.page.locator(`#${place}`).isVisible(), true, `${page}:${id} did not open ${place}`);
        assert.equal(await f.page.locator(`.lx-panel[data-place="${place}"][data-tab="${tab}"]`).getAttribute("hidden"), null,
          `${page}:${id} did not open ${place}:${tab}`);
        await openSettings(f.page, page);
      }
    }
    assert.deepEqual(f.errors, []);
  });
}

test("S11 closing and opening Settings, pressing the same page, or changing the level keeps your place", async (t) => {
  const f = await fixture(t, { width: 1024, height: 700, preferences: { showEverything: true, settingsLevel: "technical" } });
  await openSettings(f.page, "permissions");
  const body = f.page.locator("#lx-settings-body");
  await body.evaluate((node) => { node.scrollTop = 900; });
  await f.page.waitForTimeout(100);
  const at = await body.evaluate((node) => node.scrollTop);
  assert.ok(at > 500, "the page is long enough to scroll");
  await f.page.locator(".lx-settings-close").click();
  await cog(f.page).click();
  await f.page.waitForTimeout(150);
  const reopened = await body.evaluate((node) => node.scrollTop);
  assert.ok(Math.abs(reopened - at) < 2, `reopening lost the place: ${at} became ${reopened}`);
  await f.page.locator('.lx-settings-link[data-page="permissions"]').click();
  await f.page.waitForTimeout(150);
  assert.ok(Math.abs(await body.evaluate((node) => node.scrollTop) - at) < 2, "pressing the same page lost the place");
  /* The heading you are reading stays where it is when the level changes. */
  const heading = '.sg-head[data-bucket="permissions:safe"]';
  await f.page.locator(heading).scrollIntoViewIfNeeded();
  /* Scrolled there the way a person does (a wheel turn), not by the page itself. */
  await body.evaluate((node, css) => {
    node.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    node.scrollTop += document.querySelector(css).getBoundingClientRect().top - node.getBoundingClientRect().top - 40;
  }, heading);
  const before = await f.page.locator(heading).evaluate((node) => node.getBoundingClientRect().top);
  await f.page.locator('.sg-level [data-level-pick="advanced"]').click();
  await f.page.waitForTimeout(300);
  const after = await f.page.locator(heading).evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) < 4, `the heading moved from ${before} to ${after}`);
  /* Another page starts at its top. */
  await f.page.locator('.lx-settings-link[data-page="voice"]').click();
  await f.page.waitForTimeout(150);
  assert.equal(await body.evaluate((node) => node.scrollTop), 0);
  assert.deepEqual(f.errors, []);
});

test("S13 Appearance: two live mirrors of your own window, Moonlight and Daylight, that follow the tile you point at", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "appearance");
  const mirrors = () => f.page.evaluate(() => [...document.querySelectorAll(".sg-mirror")].map((figure) => {
    const doc = figure.querySelector("iframe").contentDocument;
    return { mode: figure.dataset.mode, theme: doc?.documentElement.dataset.theme, panes: doc?.body.children.length ?? 0,
      prompt: Boolean(doc?.getElementById("prompt")), caption: figure.querySelector("figcaption").textContent };
  }));
  await f.page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror iframe")].every((frame) => frame.contentDocument?.body?.children.length > 0));
  const drawn = await mirrors();
  assert.deepEqual(drawn.map(({ mode, theme }) => [mode, theme]), [["dark", "forest"], ["light", "daylight"]]);
  for (const mirror of drawn) {
    assert.ok(mirror.panes >= 2, "the mirror holds the rail and the conversation");
    assert.ok(mirror.prompt, "the mirror is a copy of this window, message box included");
  }
  /* DG-039: the sample's chips name the light, not the theme. */
  assert.deepEqual(drawn.map(({ caption }) => caption), ["Moonlight", "Daylight"]);
  assert.equal(await f.page.locator("#prompt").count(), 1, "the copy never adds a second message box to the window itself");
  /* DG-039: stacked in the sample's preview column beside the themes, Moonlight above Daylight. */
  const boxes = await f.page.locator(".sg-mirror").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  assert.ok(boxes[1].top >= boxes[0].bottom - 1 && Math.abs(boxes[0].left - boxes[1].left) < 2, "the two mirrors are stacked");
  assert.ok(boxes[0].left > (await f.page.locator("#lx-theme-gallery").boundingBox()).x + 200, "beside the themes");
  await f.page.locator('#lx-theme-gallery .lx-tile[data-family="cherry"]').hover();
  await f.page.waitForFunction(() => document.querySelector(".sg-mirror iframe").contentDocument.documentElement.dataset.palette === "cherry");
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "slate", "pointing at a theme does not choose it");
  /* The sample's words on a few tiles instead of numbers (DG-037). */
  assert.match(await f.page.locator('#lx-theme-gallery .lx-tile[data-family="mono"] .lx-tile-badge').textContent(), /High contrast/);
  /* The eye beside Day or night clears the view. */
  await f.page.locator("#sg-clear-view").click();
  await f.page.waitForFunction(() => document.documentElement.dataset.quiet === "1");
  assert.equal(await f.page.locator("#settings-window").isVisible(), false);
  assert.deepEqual(f.errors, []);
});

for (const [width, height] of [[1440, 950], [390, 844]]) {
  test(`S15 at ${width}×${height} Regular, with nothing peeked, shows Lockdown, what Branch may do, approvals, updates and background work`, async (t) => {
    const f = await fixture(t, { width, height });
    assert.equal(await f.page.evaluate(() => document.documentElement.dataset.settingsLevel), "regular");
    /* Lockdown is one press away in the More menu, in the calm window too. */
    await f.page.locator("#lx-more").click();
    await f.page.locator('#lx-more-menu [data-kind="lockdown"]').waitFor({ state: "visible" });
    await f.page.keyboard.press("Escape");
    for (const [page, ids] of Object.entries(SAFETY)) {
      await openSettings(f.page, page);
      await f.page.waitForTimeout(200);
      for (const id of ids) {
        const state = await cardState(f.page, id);
        assert.ok(state, `${id} is not in the window`);
        assert.equal(state.level, "regular", `${id} waits for a higher level`);
        assert.equal(state.peeked, false, `${id} was only shown by a peek`);
        /* The Updates card is the desktop app's alone (public/app.js hides it in a browser); every other one shows. */
        if (!state.hidden) assert.equal(state.visible, true, `${id} is hidden on Regular`);
      }
    }
    await openSettings(f.page, "permissions");
    assert.equal(await f.page.locator("#policy-preset").isVisible(), true, "what Branch may do without asking");
    assert.equal(await f.page.locator("#approval-reviewer-mode").isVisible(), true, "a second look at approvals");
    assert.deepEqual(f.errors, []);
  });
}

test("S16 the window loads and opens Settings with no Content Security Policy refusal, and the scope chips are dressed", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "general");
  await f.page.locator("#projects-form > .kit-scope").waitFor();
  await openSettings(f.page, "appearance");
  await f.page.waitForTimeout(1500);
  assert.deepEqual(f.refused, [], "the console reported a Content Security Policy refusal");
  assert.deepEqual(await f.page.evaluate(() => globalThis.__refused), [], "the page saw a Content Security Policy violation");
  await openSettings(f.page, "general");
  /* DG-010: the sample shows no scope chip, so the chip is now `sr-only` -- read aloud, never drawn.
     It can no longer stand in for "the stylesheet loaded", so a note that IS still styled does. */
  const chip = await f.page.locator("#projects-form > .kit-scope").evaluate((node) => {
    const look = getComputedStyle(node), box = node.getBoundingClientRect();
    return { hidden: box.width <= 1 && box.height <= 1, clipped: look.position === "absolute", text: node.textContent.trim() };
  });
  assert.ok(chip.hidden, "the scope chip is drawn: it should be read aloud and never seen");
  assert.ok(chip.clipped, "the scope chip is not clipped away");
  assert.ok(chip.text.length > 0, "the scope chip says nothing, so a screen reader announces nothing");
  const note = await f.page.locator("#lx-settings-body .field-note").first()
    .evaluate((node) => getComputedStyle(node).fontSize);
  assert.ok(parseFloat(note) > 0 && parseFloat(note) < 16, `a field note is ${note}: settings-kit.css did not load`);
  assert.deepEqual(f.errors, []);
});

test("S17 the second-opinion limits load when Settings opens from the cog, and saving them untouched keeps them", async (t) => {
  const f = await fixture(t);
  const chosen = { advisor: false, advisorPreset: null, advisorMaxTokens: 7000, debateExchanges: 2, debateMaxTokens: 90000 };
  await f.call("/api/second-opinion", chosen);
  await openSettings(f.page, "models");
  await f.page.locator('#lx-page-models .lx-subtab[data-sub="second"]').click();
  await f.page.waitForFunction(() => document.getElementById("advisor-ceiling")?.value === "7000");
  assert.equal(await f.page.locator("#debate-exchanges").inputValue(), "2");
  assert.equal(await f.page.locator("#debate-ceiling").inputValue(), "90000");
  await f.page.locator("#second-opinion-form").evaluate((form) => form.requestSubmit());
  await f.page.waitForTimeout(500);
  const saved = await f.call("/api/second-opinion");
  assert.deepEqual([saved.advisorMaxTokens, saved.debateExchanges, saved.debateMaxTokens], [7000, 2, 90000], "saving changed the limits");
  assert.deepEqual(f.errors, []);
});

test("S19 in French, a setting found elsewhere is named in French, from the words beside its control", async (t) => {
  const f = await fixture(t);
  await f.page.evaluate(() => globalThis.branchLayout.go("library:memory"));
  await f.page.locator("#knobs-snapshotFacts").waitFor({ state: "attached" });
  await f.page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await f.page.waitForFunction(() => document.documentElement.lang === "fr");
  const french = await f.page.evaluate(() => document.getElementById("knobs-snapshotFacts").labels[0].textContent.replace(/\s+/g, " ").trim());
  assert.notEqual(french, "Remembered facts given to a new conversation", "the label was not translated");
  await openSettings(f.page, "general");
  await f.page.locator("#lx-settings-search").fill(french);
  const row = f.page.locator('#sg-found [data-setting="knobs-snapshotFacts"] b');
  await row.waitFor();
  assert.equal(await row.textContent(), french);
  assert.deepEqual(f.errors, []);
});

test("S20 the mirrors redraw without a single request of their own, pictures included", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "appearance");
  await f.page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror iframe")].every((frame) => frame.contentDocument?.body?.children.length > 0));
  await f.page.waitForTimeout(1500);
  const asked = [];
  f.page.on("request", (request) => { if (request.frame() !== f.page.mainFrame()) asked.push(request.url()); });
  for (let round = 0; round < 3; round++) {
    await f.page.evaluate((n) => { const note = document.createElement("p"); note.textContent = `change ${n}`; document.querySelector("body > main").append(note); }, round);
    await f.page.waitForTimeout(1300);
  }
  const copies = await f.page.evaluate(() => [...document.querySelectorAll(".sg-mirror iframe")].map((frame) => frame.contentDocument.body.textContent.includes("change 2")));
  assert.deepEqual(copies, [true, true], "the mirrors did not redraw");
  assert.deepEqual(asked, [], "a mirror asked the server for something as it redrew");
  const pictures = await f.page.evaluate(() => [...document.querySelector(".sg-mirror iframe").contentDocument.querySelectorAll("img[src]")].map((img) => img.getAttribute("src").slice(0, 5)));
  assert.ok(pictures.every((src) => src === "data:"), "a copied picture still names a file");
  assert.deepEqual(f.errors, []);
});

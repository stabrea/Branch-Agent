/**
 * phase2/settings: Settings grown up — part 3 of 3
 * S9 every page, S12, S14, S18: grouping, overflow, declared settings, preview staying in sight.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { settingKeys } from "../scripts/check-docs.mjs";
import { fixture, openSettings, visitEverything, switchEverythingOn, sweep, INVENTORY, SETTINGS_INDEX, BUCKETS, NOT_IN_SEARCH, ROOT } from "./settings-grown-helpers.mjs";

test("S9 every page is grouped, and a card no group names still shows under More on this page", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "general");
  for (const page of Object.keys(BUCKETS)) {
    const host = page.startsWith("models:") ? `#lx-models-${page.slice(7)}` : `#lx-page-${page}`;
    const heads = await f.page.locator(`${host} > .sg-head`).count();
    assert.ok(heads >= 1, `${page} has no group heading`);
  }
  /* The order on the page is the order of the groups: each card after its own heading. */
  const order = await f.page.evaluate(() => [...document.querySelectorAll("#lx-page-general > *")].map((node) => node.dataset.bucket ?? node.dataset.sgBucket ?? node.className));
  const firstHead = order.indexOf("general:start"), projects = order.indexOf("general:projects");
  assert.ok(firstHead > -1 && projects > firstHead);
  assert.ok(order.slice(firstHead + 1, projects).every((item) => item === "general:start"), "a card stands under the wrong heading");
  /* Settled, the groups do not keep writing to the page (a write that sets off another write loops forever). */
  const churn = await f.page.evaluate(() => new Promise((done) => {
    const count = new Map();
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const head = record.target.closest?.(".sg-head") ?? record.target.parentElement?.closest(".sg-head");
        if (!head) continue;
        const key = `${head.dataset.bucket}:${record.type}:${record.attributeName ?? ""}:${record.target.className || record.target.nodeName}`;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    });
    watch.observe(document.getElementById("settings-window"), { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { watch.disconnect(); done([...count]); }, 1500);
  }));
  /* Separate cards may arrive late together on a slow runner. A loop repeats the same write every frame. */
  const repeating = churn.filter(([, writes]) => writes >= 4);
  assert.deepEqual(repeating, [], `the same group-heading write keeps repeating: ${JSON.stringify(repeating.slice(0, 5))}`);
  await f.page.evaluate(() => {
    const card = document.createElement("section");
    card.className = "card";
    card.id = "someone-elses-card";
    card.dataset.home = "settings:general";
    card.textContent = "A card added later";
    document.body.append(card);
  });
  await f.page.locator("#lx-page-general > #someone-elses-card").waitFor({ state: "visible" });
  await f.page.waitForFunction(() => {
    const card = document.getElementById("someone-elses-card");
    if (card?.dataset.sgBucket !== "general:other") return false;
    let before = card.previousElementSibling;
    while (before && !before.classList.contains("sg-head")) before = before.previousElementSibling;
    return before?.dataset.bucket === "general:other";
  });
  assert.deepEqual(f.errors, []);
});

for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
  test(`S12 at ${width}×${height} no Settings page overflows sideways and no chip leaves its card`, async (t) => {
    const f = await fixture(t, { width, height, preferences: { showEverything: true, settingsLevel: "technical" } });
    /* With every switch that only changes a record on, so the chips and lists behind them are drawn too. */
    await visitEverything(f.page);
    await switchEverythingOn(f.page);
    await openSettings(f.page, "general");
    const pages = await f.page.evaluate(() => [...document.querySelectorAll(".lx-settings-link")].map((link) => link.dataset.page));
    const problems = [];
    for (const name of pages) {
      await f.page.evaluate((page) => document.querySelector(`.lx-settings-link[data-page="${page}"]`).click(), name);
      const tabs = name === "models" ? await f.page.locator("#lx-page-models .lx-subtab").count() : 1;
      for (let tab = 0; tab < tabs; tab++) {
        if (name === "models") await f.page.locator("#lx-page-models .lx-subtab").nth(tab).click();
        await f.page.waitForTimeout(250);
        problems.push(...(await f.page.evaluate(sweep)).map((line) => `${name}${tabs > 1 ? "#" + tab : ""}: ${line}`));
      }
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(f.errors, []);
  });
}

test("S14 every setting Branch declares has a Settings search entry, or a stated reason on the list above", () => {
  /* A declared key counts as found when an index row names it where it is saved ("voice.liveMaxDollars",
     "model-savings.openrouter-sort"). Loose on purpose: a common word such as "mode" is found by any row that
     saves a mode, so this can miss a setting but never invents one. */
  const INDEX = new Map(SETTINGS_INDEX.map((row) => [row[0], row]));
  const saved = new Set(SETTINGS_INDEX.flatMap((row) => (row[4] ?? "").split(/[.· -]+/)).filter(Boolean));
  const declared = [];
  for (const [key, where] of settingKeys(ROOT)) for (const place of where) declared.push(`${place.split("Schema (")[0]}.${key}`);
  assert.ok(declared.length > 400, `only ${declared.length} declared settings were read`);
  const listed = Object.values(NOT_IN_SEARCH).flat();
  const unfound = declared.filter((name) => !saved.has(name.split(".")[1]) && !listed.includes(name));
  assert.deepEqual(unfound, [], "these settings are declared in src/ but Settings search cannot find them: add a row to " +
    "public/settings-index.js for the control, or name them in NOT_IN_SEARCH with the reason");
  assert.deepEqual(listed.filter((name) => !declared.includes(name)), [], "NOT_IN_SEARCH names settings that no longer exist");
  assert.equal(new Set(listed).size, listed.length, "a setting is listed twice");
});

test("the desktop Settings level and version stay at the bottom of the rail", async (t) => {
  const f = await fixture(t, { width: 1440, height: 1800 });
  await openSettings(f.page, "general");
  const layout = await f.page.evaluate(() => {
    const nav = document.querySelector(".lx-settings-nav").getBoundingClientRect();
    const level = document.querySelector(".sg-level").getBoundingClientRect();
    const version = document.querySelector("#lx-settings-version").getBoundingClientRect();
    return { navTop: nav.top, navBottom: nav.bottom, navHeight: nav.height,
      levelTop: level.top, versionBottom: version.bottom };
  });
  assert.ok(layout.levelTop > layout.navTop + layout.navHeight / 2, "the footer group follows the rail spacer");
  assert.ok(layout.navBottom - layout.versionBottom < 30,
    `the version remains against the rail bottom: ${JSON.stringify(layout)}`);
  assert.deepEqual(f.errors, []);
});

for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
  test(`S18 at ${width}×${height} the preview stays in sight while you scroll down the themes and point at one`, async (t) => {
    const f = await fixture(t, { width, height });
    await openSettings(f.page, "appearance");
    const wide = await f.page.evaluate(() => getComputedStyle(document.querySelector(".sg-strip")).display === "none");
    assert.equal(wide, width >= 1440, "the strip shows only where the page is narrower than the sample's 980px");
    if (wide) await f.page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror iframe")].every((frame) => frame.contentDocument?.body?.children.length > 0));
    const last = f.page.locator("#lx-theme-gallery .lx-tile").last();
    await last.scrollIntoViewIfNeeded();
    const inSight = await f.page.evaluate((isWide) => {
      const body = document.getElementById("lx-settings-body").getBoundingClientRect();
      const shown = document.querySelector(isWide ? ".sg-mirror-pair" : ".sg-strip").getBoundingClientRect();
      return shown.height > 0 && shown.top >= body.top - 2 && shown.bottom <= body.bottom + 2;
    }, wide);
    assert.equal(inSight, true, "scrolling down the themes took the preview out of sight");
    if (!wide) {
      /* Riding along, the strip sits right at the top: no half row of tiles shows above it. */
      const above = await f.page.evaluate(() => document.querySelector(".sg-mirrors").getBoundingClientRect().top - document.getElementById("lx-settings-body").getBoundingClientRect().top);
      assert.ok(Math.abs(above) <= 2, `the strip rides ${above}px below the top of the page`);
    }
    /* The words on the tiles are whole, never cut short. */
    const cut = await f.page.evaluate(() => [...document.querySelectorAll(".lx-tile-badge")].filter((tag) => tag.scrollWidth > tag.clientWidth + 1 || tag.getBoundingClientRect().right > tag.closest(".lx-tile").getBoundingClientRect().right + 1).map((tag) => tag.textContent));
    assert.deepEqual(cut, [], "a tile's tag is cut short");
    /* The tile you point at is not under the preview riding along above it, and the preview follows it. */
    const covered = await last.evaluate((tile) => {
      const box = tile.getBoundingClientRect(), top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !tile.contains(top);
    });
    assert.equal(covered, false, "the preview covers the tile being pointed at");
    await last.hover();
    const family = await last.getAttribute("data-family");
    const name = await f.page.evaluate(async (id) => (await import("/theme-bridge.js")).themeById(id)[1], family);
    if (wide) await f.page.waitForFunction((id) => document.querySelector(".sg-mirror iframe").contentDocument.documentElement.dataset.palette === id, family);
    else await f.page.waitForFunction((words) => document.querySelector(".sg-strip b").textContent === `${words} (preview)`, name);
    assert.deepEqual(f.errors, []);
  });
}

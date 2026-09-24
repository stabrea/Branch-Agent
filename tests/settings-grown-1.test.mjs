/**
 * phase2/settings: Settings grown up — part 1 of 3
 * Intro, S1, S4-S8, S10: basic audits and search functionality.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { settingKeys } from "../scripts/check-docs.mjs";
import { offLimitsToHousehold } from "../dist/server.js";
import { fixture, openSettings, visitEverything, switchEverythingOn, whereEach, cog, INDEX, INVENTORY, SETTINGS_INDEX, ROOT } from "./settings-grown-helpers.mjs";

test("every Settings page introduction has English and French words", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const page of ["trunks", "channels", "connections", "skills", "memory", "automations"]) {
    const key = `settings.window.${page}.intro`;
    assert.ok(en[key], `${key} has English words`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} has real French words`);
  }
});

test("S1 every setting in the audit is in the index, at the home the audit gives it", () => {
  assert.equal(INVENTORY.length, 530, "the audit lists 530 settings");
  const missing = INVENTORY.filter((s) => !INDEX.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], "these settings are not in public/settings-index.js, so search cannot find them");
  const moved = INVENTORY.filter((s) => INDEX.get(s.id)?.[1] !== s.home).map((s) => s.id);
  assert.deepEqual(moved, [], "the index puts these somewhere other than their home");
  for (const row of SETTINGS_INDEX) assert.ok(row[3].length > 1, `${row[0]} has no words to search by`);
  /* Search lists a name and its card; two that read the same cannot be told apart (#48). */
  const alike = new Map();
  for (const row of SETTINGS_INDEX) alike.set(`${row[3]} · ${row[6]}`, [...(alike.get(`${row[3]} · ${row[6]}`) ?? []), row[0]]);
  assert.deepEqual([...alike].filter(([, ids]) => ids.length > 1), [], "these settings read the same in search");
  assert.deepEqual(SETTINGS_INDEX.filter((row) => /^\(|\|/.test(row[3])).map((row) => row[0]), [], "a placeholder or a raw list format instead of words");
});

test("S4 Settings search finds every one of the 530 settings, at any level", async (t) => {
  const f = await fixture(t);
  await visitEverything(f.page);
  await openSettings(f.page, "general");
  const lost = await f.page.evaluate(async (rows) => {
    const input = document.getElementById("lx-settings-search");
    const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
    const lost = [];
    for (const [id, , card, label, , selector] of rows) {
      input.value = label;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await frame();
      document.querySelector(".sg-found-all")?.click();
      if (document.querySelector(`#sg-found [data-setting="${CSS.escape(id)}"]`)) continue;
      const node = document.getElementById(id) ?? (selector ? document.querySelector(selector) : null) ?? document.getElementById(card);
      const holder = node?.closest(".lx-page > *, .lx-subpanel > *");
      if (holder && !holder.classList.contains("lx-miss") && holder.checkVisibility()) continue;
      lost.push(`${id} ("${label}")`);
    }
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return lost;
  }, [...INDEX.values()]);
  assert.deepEqual(lost, [], "Settings search did not find these by their own words");
  assert.deepEqual(f.errors, []);
});

test("a household profile redirected from Instructions keeps the phone page strip in sync", async (t) => {
  const f = await fixture(t, { width: 390, height: 844 });
  await openSettings(f.page, "instructions");
  assert.equal(await f.page.locator('.sg-pages .lx-settings-link[aria-current="true"]').getAttribute("data-page"), "instructions");
  const sam = await fetch(new URL("/api/profiles", f.url), {
    method: "POST", headers: f.headers, body: JSON.stringify({ name: "Sam", pin: "2468" }),
  }).then((response) => response.json());
  const switched = await fetch(new URL("/api/profiles/switch", f.url), {
    method: "POST", headers: f.headers, body: JSON.stringify({ profileId: sam.id, pin: "2468" }),
  });
  assert.equal(switched.status, 200);
  await f.page.waitForFunction(() => document.documentElement.dataset.household === "on", null, { timeout: 15000 });
  await f.page.waitForFunction(() => document.querySelector(".lx-settings-link[aria-current='true']")?.dataset.page === "general");
  /* General is the tab on show, in sight in the strip, and Instructions has left it. */
  assert.deepEqual(await f.page.evaluate(() => {
    const strip = document.querySelector(".sg-pages").getBoundingClientRect();
    const tab = document.querySelector('.sg-pages .lx-settings-link[data-page="general"]').getBoundingClientRect();
    return { inSight: tab.left >= strip.left - 0.5 && tab.right <= strip.right + 0.5,
      instructions: document.querySelector('.lx-settings-link[data-page="instructions"]').checkVisibility() };
  }), { inSight: true, instructions: false });
  assert.deepEqual(f.errors, []);
});

test("S5 Go there opens the place and shows the card, even above the level", async (t) => {
  const f = await fixture(t);
  await openSettings(f.page, "general");
  /* "Key name in Secrets" for making videos only exists once that card's switch is on. */
  await f.page.locator("#lx-settings-search").fill("Key name in Secrets");
  const row = f.page.locator('#sg-found [data-setting="reach-video-secret"]');
  await row.waitFor();
  assert.match(await row.textContent(), /Shows once the switch on its card is on/);
  await row.locator(".sg-found-go").click();
  await f.page.locator("#reach-video-card").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#lx-models-media").isVisible(), true);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.settingsLevel), "regular", "the level did not change");
  /* A setting that lives in another place takes you there. */
  await f.page.locator("#lx-settings-search").fill("Requests for new packages and tool servers");
  await f.page.locator('#sg-found [data-setting="flows-switch-install-requests"] .sg-found-go').click();
  await f.page.locator("#flows-switch-install-requests").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#settings-window").isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test("S6 Regular shows the essentials; each level shows more; the choice is kept with Show everything", async (t) => {
  const f = await fixture(t);
  const level = () => f.page.evaluate(() => document.documentElement.dataset.settingsLevel);
  assert.equal(await level(), "regular", "a fresh install starts on Regular");
  await openSettings(f.page, "general");
  assert.equal(await f.page.locator("#deployment-card").isVisible(), true, "a Regular card shows");
  assert.equal(await f.page.locator("#never-break-card").isVisible(), false, "an Advanced card waits for Advanced");
  /* DG-073: the link ends its section, wherever that section's last card on show is. */
  const more = f.page.locator('.sg-more-line[data-bucket="general:start"] .sg-more');
  /* DG-199: it counts the section's settings kept out of sight, row by row, as the sample does. */
  assert.match(await more.textContent(), /^\d+ more with Advanced$/);
  await more.click();
  await f.page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "advanced");
  assert.equal(await f.page.locator("#never-break-card").isVisible(), true);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.everything), "on", "Advanced is the full window");
  await f.page.waitForTimeout(400);
  let saved = (await f.call("/api/state")).preferences;
  assert.equal(saved.settingsLevel, "advanced");
  assert.equal(saved.showEverything, true);
  /* Technical shows the plumbing and where each card is saved. */
  /* Under the hood waits for Technical (the sample's rule, DG-199). */
  await openSettings(f.page, "advanced");
  assert.equal(await f.page.locator("#counters-card").isVisible(), false);
  await f.page.locator('.sg-level [data-level-pick="technical"]').click();
  await f.page.locator("#counters-card").waitFor({ state: "visible" });
  await openSettings(f.page, "general");
  assert.equal(await f.page.locator("#never-break-card .sg-keys").isVisible(), true);
  assert.match(await f.page.locator("#never-break-card .sg-keys-names").textContent(), /never-break\.mode/);
  /* Show everything off is Regular again, and the other way round. */
  await openSettings(f.page, "appearance");
  await f.page.locator("#settings-form").evaluate((card) => { card.dataset.sgPeek = "1"; });
  await f.page.locator("#appearance-everything").uncheck();
  await f.page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "regular");
  await f.page.waitForTimeout(400);
  saved = (await f.call("/api/state")).preferences;
  assert.equal(saved.settingsLevel, "regular");
  assert.equal(saved.showEverything, false);
  assert.deepEqual(f.errors, []);
});

test("S7 someone who already had Show everything on starts on Advanced, and search ignores the level", async (t) => {
  const f = await fixture(t, { preferences: { showEverything: true } });
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.settingsLevel), "advanced");
  await openSettings(f.page, "advanced");
  assert.equal(await f.page.locator("#counters-card").isVisible(), false, "a Technical card waits");
  await f.page.locator("#lx-settings-search").fill("counters");
  await f.page.locator("#counters-card").waitFor({ state: "visible" });
  await f.page.locator("#lx-settings-search").fill("");
  assert.equal(await f.page.locator("#counters-card").isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test("S8 somebody else's profile sees Regular, cannot change the level, and search never names the owner's settings", async (t) => {
  const f = await fixture(t, { preferences: { showEverything: true, settingsLevel: "technical" } });
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.settingsLevel), "technical");
  const sam = await fetch(new URL("/api/profiles", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ name: "Sam", pin: "2468" }) }).then((r) => r.json());
  const switched = await fetch(new URL("/api/profiles/switch", f.url), { method: "POST", headers: f.headers, body: JSON.stringify({ profileId: sam.id, pin: "2468" }) });
  assert.equal(switched.status, 200);
  await f.page.waitForFunction(() => document.documentElement.dataset.household === "on", null, { timeout: 15000 });
  await f.page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "regular");
  await openSettings(f.page, "general");
  assert.equal(await f.page.locator(".sg-level [data-level-pick='technical']").isDisabled(), true);
  assert.match(await f.page.locator(".sg-level-note").textContent(), /owner keeps this profile on Regular/);
  await f.page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.settingsLevel), "regular", "the level stayed on Regular");
  /* Search: "Key name in Secrets" is the owner's; the one setting a household person may change still shows. */
  await f.page.locator("#lx-settings-search").fill("Key name in Secrets");
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator('#sg-found [data-setting="reach-video-secret"]').count(), 0, "an owner-only setting was named to somebody else");
  await f.page.locator("#lx-settings-search").fill("Also name the files of this project");
  await f.page.locator('#sg-found [data-setting="documents-repository"]').waitFor();
  /* The server keeps the level the owner's too. */
  assert.notEqual(offLimitsToHousehold("POST", "/api/preferences"), null);
  assert.deepEqual(f.errors, []);
});

test("S10 Settings is a cog at the right end of the icon line over the account row, in the calm and the full window, and draws every card", async (t) => {
  const f = await fixture(t);
  const after = () => f.page.evaluate(() => {
    const cog = [...document.querySelectorAll(".lx-foot-line > .sg-gear")].find((node) => node.checkVisibility());
    const owner = document.getElementById("owner-menu-button");
    const a = owner.getBoundingClientRect(), b = cog?.getBoundingClientRect();
    /* DG-094: the cog ends the icon line, above the account row, at its right edge */
    return { owner: owner.checkVisibility(), cog: Boolean(cog), right: b ? Math.abs(b.right - a.right) < 2 : false, row: b ? b.bottom <= a.top + 1 : false };
  });
  assert.deepEqual(await after(), { owner: true, cog: true, right: true, row: true }, "calm window");
  await cog(f.page).click();
  assert.equal(await f.page.locator("#settings-window").isVisible(), true);
  assert.equal(await cog(f.page).getAttribute("aria-expanded"), "true");
  /* Cards that used to draw only when the old Settings button was pressed are there. */
  await f.page.locator("#speech-engines-card").waitFor({ state: "attached" });
  await f.page.locator("#video-programs-card").waitFor({ state: "attached" });
  await f.page.locator(".lx-settings-close").click();
  await f.page.evaluate(async () => {
    const { changeAppearance } = await import("/appearance.js");
    changeAppearance({ showEverything: true, settingsLevel: "advanced" });
  });
  assert.deepEqual(await after(), { owner: true, cog: true, right: true, row: true }, "full window");
  assert.deepEqual(f.errors, []);
});

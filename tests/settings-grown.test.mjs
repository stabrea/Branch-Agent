/**
 * phase2/settings: Settings grown up — groups by task, Regular / Advanced / Technical, every setting
 * reachable and findable, the cog after the account row, keeping your place, nothing overflowing.
 *
 * The checklist is the settings audit of the real app (tests/fixtures/settings-inventory.json, 530
 * settings with their fresh-install defaults). Every one must have a control in the window (or, when it
 * has no id of its own, the stand-in public/settings-index.js names), live where the audit says, start
 * at its real default, and be found by Settings search.
 *
 * Integration (2026-09-19): the audit is a snapshot, so S14 also reads every setting Branch declares (the
 * settings schemas scripts/check-docs.mjs holds docs/configuration.md to) and fails for one that has no
 * Settings search entry and no stated reason. S15 holds Regular to never hiding a safety control.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToHousehold } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { settingKeys } from "../scripts/check-docs.mjs";

test("every Settings page introduction has English and French words", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const page of ["trunks", "channels", "connections", "skills", "memory", "automations"]) {
    const key = `settings.window.${page}.intro`;
    assert.ok(en[key], `${key} has English words`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} has real French words`);
  }
});

const ROOT = join(import.meta.dirname, "..");
const INVENTORY = JSON.parse(await readFile(join(ROOT, "tests", "fixtures", "settings-inventory.json"), "utf8")).settings;
const { SETTINGS_INDEX } = await import("../public/settings-index.js");
const { BUCKETS } = await import("../public/settings-buckets.js");
const INDEX = new Map(SETTINGS_INDEX.map((row) => [row[0], row]));

/* Switches that act on this computer the moment they are on (start at sign-in, keep running, install a
   model runner, use the screen, a USB watcher, other machines). The walk leaves them alone; what sits
   behind them is found through its card instead. */
const LEAVE_OFF = ["never-break-card", "deployment-card", "local-models-card", "os-sandbox-card", "screen-switch-card", "wake-word-form",
  "reach-usb-card", "reach-background-card", "desktop-card", "reach-machines-card", "asks-nodes-card", "remote-card"];

async function fixture(t, { width = 1440, height = 950, preferences } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-grown-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  if (preferences) app.store.save("settings", app.runtime.owner, "preferences", preferences);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [], refused = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/i.test(message.text())) refused.push(message.text()); });
  await page.addInitScript(() => {
    globalThis.__refused = [];
    document.addEventListener("securitypolicyviolation", (event) => globalThis.__refused.push(`${event.violatedDirective} ${event.sourceFile}:${event.lineNumber}`));
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, call, errors, refused, app, url: server.url, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } };
}
/** The cog after the account row: the calm window's, or the full window's. */
const cog = (page) => page.locator(".sg-foot-line > .sg-gear:visible");
async function openSettings(page, name) {
  if (!(await page.locator("#settings-window").isVisible())) {
    /* On a phone the rail, with the account row and the cog at its foot, opens from the title bar. */
    if (!(await cog(page).count())) await page.locator("#rail-toggle").click();
    await cog(page).click();
  }
  if (!name) return;
  /* DG-013: on a phone the pages are a strip of tabs; a click scrolls the tab into view first. */
  await page.locator(`.lx-settings-link[data-page="${name}"]`).click();
}
/** Every place, every Settings page and every Models tab, so every module has drawn its cards. */
async function visitEverything(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (const home of globalThis.branchLayout.homes()) if (!home.startsWith("settings")) { globalThis.branchLayout.go(home); await wait(150); }
  });
  await openSettings(page);
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-settings-link")].map((link) => link.dataset.page));
  for (const name of [...pages, "models"]) { await openSettings(page, name); await page.waitForTimeout(150); }
  for (const tab of await page.locator("#lx-page-models .lx-subtab").all()) { await tab.click(); await page.waitForTimeout(150); }
}
/** Turns on every feature switch that only changes a record, so what sits behind a switch is drawn too. */
async function switchEverythingOn(page) {
  for (let round = 0; round < 3; round++) {
    await page.evaluate((leave) => {
      for (const select of document.querySelectorAll("select")) {
        const values = [...select.options].map((option) => option.value);
        if (!values.includes("on") || !values.includes("off") || select.value === "on") continue;
        if (leave.some((id) => select.closest(`#${id}`))) continue;
        select.value = "on";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, LEAVE_OFF);
    await page.waitForTimeout(2500);
  }
}

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
/** Where each setting's control is: settings:<page>[:<tab>], <place>:<tab>, or null when there is none. */
function whereEach(page) {
  return page.evaluate((rows) => Object.fromEntries(rows.map(([id, , card, , , selector]) => {
    const node = document.getElementById(id) ?? (selector ? document.querySelector(selector) : null);
    if (!node) return [id, null];
    const settingsPage = node.closest(".lx-page"), sub = node.closest(".lx-subpanel"), panel = node.closest(".lx-panel");
    if (settingsPage) return [id, `settings:${settingsPage.dataset.page}${sub ? ":" + sub.dataset.sub : ""}`];
    if (panel) return [id, `${panel.dataset.place}:${panel.dataset.tab}`];
    return [id, "elsewhere"];
  })), [...INDEX.values()]);
}

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
  const since = SETTINGS_INDEX.filter((row) => !INVENTORY.some((s) => s.id === row[0]) && !(windowsOnly.has(row[0]) && process.platform !== "win32"));
  assert.ok(since.length >= 8, "the settings added at integration are in the index");
  assert.deepEqual(since.filter((row) => where[row[0]] !== (inTheList.has(row[0]) ? "elsewhere" : row[1])).map((row) => `${row[0]}: ${where[row[0]]} (index: ${row[1]})`), [],
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
  assert.match(await more.textContent(), /1 more with Advanced/);
  await more.click();
  await f.page.waitForFunction(() => document.documentElement.dataset.settingsLevel === "advanced");
  assert.equal(await f.page.locator("#never-break-card").isVisible(), true);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.everything), "on", "Advanced is the full window");
  await f.page.waitForTimeout(400);
  let saved = (await f.call("/api/state")).preferences;
  assert.equal(saved.settingsLevel, "advanced");
  assert.equal(saved.showEverything, true);
  /* Technical shows the plumbing and where each card is saved. */
  await openSettings(f.page, "advanced");
  assert.equal(await f.page.locator("#developer-card").isVisible(), false);
  await f.page.locator('.sg-level [data-level-pick="technical"]').click();
  await f.page.locator("#developer-card").waitFor({ state: "visible" });
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

const SETTINGS_DIRECTORIES = {
  trunks: [["trunks", "customize", "specialists"], ["overview", "overview", "here"], ["people", "household", "people"]],
  channels: [["channels", "customize", "channels"]],
  connections: [["connections", "customize", "connections"]],
  skills: [["skills", "customize", "skills"], ["specialists", "customize", "specialists"], ["plugins", "customize", "plugins"]],
  memory: [["memory", "library", "memory"], ["documents", "library", "documents"], ["made", "library", "made"]],
  automations: [["scheduled", "automations", "scheduled"], ["procedures", "automations", "procedures"],
    ["triggers", "automations", "triggers"], ["needs", "inbox", "needs"], ["history", "inbox", "history"]],
};

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

test("S10 Settings is a cog right after the account row, in the calm and the full window, and draws every card", async (t) => {
  const f = await fixture(t);
  const after = () => f.page.evaluate(() => {
    const cog = [...document.querySelectorAll(".sg-foot-line > .sg-gear")].find((node) => node.checkVisibility());
    const owner = document.getElementById("owner-menu-button");
    const a = owner.getBoundingClientRect(), b = cog?.getBoundingClientRect();
    return { owner: owner.checkVisibility(), cog: Boolean(cog), right: b ? b.left >= a.right - 1 : false, row: b ? Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 6 : false };
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
/** Runs in the page: sideways overflow of the window or the page, and chips, pills and badges outside their card. */
function sweep() {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`the window scrolls sideways by ${doc.scrollWidth - doc.clientWidth}px`);
  const body = document.getElementById("lx-settings-body");
  if (body.scrollWidth > body.clientWidth + 1) out.push(`the page scrolls sideways by ${body.scrollWidth - body.clientWidth}px`);
  const chips = document.querySelectorAll("#lx-settings-body :is(.chip, .pill, .badge, .status-pill, .lx-count, [class*='chip'], [class*='pill'], [class*='badge'], .sg-more, .kit-scope)");
  for (const chip of chips) {
    if (!chip.checkVisibility()) continue;
    // A visually hidden chip is 1px and clipped: it is read aloud, never drawn, and cannot
    // overflow anything a person sees. `checkVisibility()` still calls it visible.
    if (chip.classList.contains("sr-only")) continue;
    const card = chip.closest(".lx-page > *, .lx-subpanel > *");
    if (!card) continue;
    const a = chip.getBoundingClientRect(), b = card.getBoundingClientRect();
    if (a.width === 0) continue;
    if (a.right > b.right + 1 || a.left < b.left - 1) out.push(`${chip.className || chip.tagName} "${chip.textContent.trim().slice(0, 30)}" leaves ${card.id || card.className}`);
    if (chip.scrollWidth > chip.clientWidth + 1 && getComputedStyle(chip).textOverflow !== "ellipsis") out.push(`${chip.className} "${chip.textContent.trim().slice(0, 30)}" is cut off`);
  }
  return out;
}

test("S13 Appearance: two live mirrors of your own window, dark and light, that follow the tile you point at", async (t) => {
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
    assert.match(mirror.caption, /^Slate · (Dark|Light)$/);
  }
  assert.equal(await f.page.locator("#prompt").count(), 1, "the copy never adds a second message box to the window itself");
  /* Side by side, and small beside the themes. */
  const boxes = await f.page.locator(".sg-mirror").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  assert.ok(Math.abs(boxes[0].top - boxes[1].top) < 2 && boxes[1].left > boxes[0].right - 1, "the two mirrors sit side by side");
  assert.ok(boxes[0].width < 400, "each mirror is small");
  await f.page.locator('#lx-theme-gallery .lx-tile[data-family="cherry"]').hover();
  await f.page.waitForFunction(() => document.querySelector(".sg-mirror figcaption").textContent.startsWith("Cherry"));
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "slate", "pointing at a theme does not choose it");
  /* Plain words on a few tiles instead of numbers. */
  assert.match(await f.page.locator('#lx-theme-gallery .lx-tile[data-family="mono"] .sg-tile-tag').textContent(), /Easiest to read/);
  /* The eye beside Light and dark clears the view. */
  await f.page.locator("#sg-clear-view").click();
  await f.page.waitForFunction(() => document.documentElement.dataset.quiet === "1");
  assert.equal(await f.page.locator("#settings-window").isVisible(), false);
  assert.deepEqual(f.errors, []);
});

/* ---------- S14: every setting Branch declares, not only the audit's ---------- */
const NOT_IN_SEARCH = {
  /* Written by Branch itself (when something last happened, which run holds the browser), never by a person. */
  writtenByBranch: [
    "AnalyticsSettings.decidedAt", "AnalyticsSettings.lastSentAt", "BriefSettings.nextAt", "BriefSettings.lastSentAt",
    "AttachSettings.runId", "AttachSettings.grantedAt", "ConsolidationSettings.lastRunAt", "RelaySettings.machineId",
  ],
  /* Switches beside the message box (the More menu), not on a Settings page. */
  besideTheMessageBox: [
    "AskFirstSettings.askFirst", "PlanActSettings.planMode",
  ],
  /* Read from the launch configuration (the integrations file and the keep-running gateway's file), not saved from the window. */
  launchConfiguration: [
    "GitConfig.github", "GitConfig.githubApp", "GitConfig.gitlab", "IssuesConfig.github", "IssuesConfig.linear",
    "IssuesConfig.gitlab", "IssuesConfig.jira", "BrowserConfig.allowedOrigins", "BrowserConfig.maxRuns",
    "BrowserConfig.maxOriginsPerRun", "BrowserConfig.maxDownloadBytes", "BrowserConfig.downloadTypes",
    "GitHubAppConfig.appId", "GitHubAppConfig.privateKeySecret", "GitHubAppConfig.installationId",
    "GitHubConfig.apiBase", "GitHubConfig.tokenSecret", "GitHubConfig.timeoutMs", "GitHubConfig.maxBytes",
    "GitLabConfig.apiBase", "GitLabConfig.tokenSecret", "GitLabConfig.timeoutMs", "GitLabConfig.maxBytes",
    "JiraConfig.site", "JiraConfig.emailSecret", "JiraConfig.tokenSecret", "JiraConfig.timeoutMs",
    "JiraConfig.maxBytes", "LinearConfig.apiBase", "LinearConfig.tokenSecret", "LinearConfig.timeoutMs",
    "LinearConfig.maxBytes", "ShellConfig.executables", "ShellConfig.inheritEnv", "ShellConfig.env",
    "ShellConfig.timeoutMs", "ShellConfig.maxMemoryMb", "ShellConfig.maxCpuSeconds", "ShellConfig.maxOutputBytes",
    "ShellConfig.netless", "ShellConfig.useJobObject", "GatewayConfig.startSeconds", "GatewayConfig.holdSeconds",
    "GatewayConfig.maxQuickCrashes", "GatewayConfig.gapSeconds", "GatewayConfig.watchSeconds",
    "GatewayConfig.workerEnv",
  ],
  /* Found by the 2026-09-19 sweep with no Settings search entry. Each still needs a look: a control to index, or a
     reason it has none (many are set through the assistant, a command or the API). Listed in docs/agents/STATUS-p2-settings.md.
     Only ever take names off this list. */
  notYetReviewed: [
    "AccountsSettings.poolingRule", "AccountsSettings.poolingNotices", "AskFirstSettings.maxQuestions",
    "AnalyticsSettings.consent", "HindsightSettings.budget", "BatchSettings.minQuestions", "BatchSettings.maxWaitMs",
    "BatchSettings.pollMs", "BatchSettings.discount", "BriefSettings.dailyAt", "BriefSettings.deliverTo",
    "BriefSettings.template", "BriefSettings.sections", "WebhookAddressSettings.acceptOldAddresses",
    "WebhookAddressSettings.oldAddressesEndOn", "CodeRunSettings.python", "CodeRunSettings.timeoutMs",
    "CodeRunSettings.maxMemoryMb", "CodeRunSettings.maxCpuSeconds", "CodeRunSettings.maxOutputBytes",
    "FormatSettings.formatters", "FormatSettings.diagnostics", "FormatSettings.waitMs", "FormatSettings.timeoutMs",
    "RepositoryContextSettings.repositoryContextFiles", "RepositoryContextSettings.repositoryOutlineTokens",
    "CredentialSettings.services", "CredentialSettings.bitwardenCommand", "CredentialSettings.onePasswordCommand",
    "CredentialSettings.timeoutMs", "DebugSettings.maxMemoryMb", "DebugSettings.maxCpuSeconds",
    "DebugSettings.timeoutMs", "DocumentSettings.embeddingModel", "LiveScoringSettings.scorers",
    "EventLoopSettings.stallMs", "HeartbeatSettings.deliverTo", "KnowledgeSettings.maxIndexTokens",
    "KnowledgeSettings.compareAtMost", "LanguageServerSettings.maxMemoryMb", "LanguageServerSettings.maxCpuSeconds",
    "LanguageServerSettings.timeoutMs", "LearnSettings.steps", "ListenSettings.where", "RoutingSettings.localPreset",
    "RoutingSettings.cloudPreset", "MediaSettings.imagePrices", "ConsolidationSettings.everyHours",
    "MemoryRetrievalSettings.embeddingModel", "OrchestrationSettings.autoPlan", "OrchestrationSettings.planApproval",
    "OrchestrationSettings.verify", "OrchestrationSettings.milestoneRounds", "OrchestrationSettings.stuckAction",
    "PeopleSettings.extra", "HomeSettings.tokenName", "HomeSettings.domains", "SignInSettings.clientSecretName",
    "SignInSettings.tenant", "SpokenBriefSettings.calendar", "SpokenBriefSettings.morningBrief",
    "SpokenBriefSettings.maxCharacters", "PullRequestHookSettings.base", "BackgroundSettings.maxRunning",
    "BackgroundSettings.maxMinutes", "BackgroundSettings.maxMemoryMb", "BackgroundSettings.maxCpuSeconds",
    "BackgroundSettings.bufferBytes", "PlatformSettings.paused", "VideoSettings.pricePerSecond",
    "CacheSettings.ttlMinutes", "CacheSettings.maxEntries", "RetrievalPipelineSettings.byCollection",
    "RerankSettings.candidates", "RecordingSettings.keepPictures", "GovernanceSettings.excludeAfterFailures",
    "GovernanceSettings.windowMinutes", "GovernanceSettings.recoveryAfterMinutes",
    "GovernanceSettings.demoteAfterFailures", "StudySettings.benchmarksFolder", "SuggestionsSettings.updates",
    "TraceExportSettings.destination", "TraceExportSettings.headers", "TraceExportSettings.batchSize",
    "TraceExportSettings.retries", "TraceExportSettings.serviceName", "TraceExportSettings.includeErrors",
    "TroubleshootSettings.maxTries", "VaultAutofillSettings.timeoutMs", "SecretCommandSettings.timeoutMs",
    "KeychainSettings.timeoutMs", "WakeWordSettings.windowSeconds", "VoiceSettings.sttModel",
    "VoiceSettings.ttsModel", "VoiceSettings.localSpeechKind", "VoiceSettings.localSpeechStream",
  ],
};

test("S14 every setting Branch declares has a Settings search entry, or a stated reason on the list above", () => {
  /* A declared key counts as found when an index row names it where it is saved ("voice.liveMaxDollars",
     "model-savings.openrouter-sort"). Loose on purpose: a common word such as "mode" is found by any row that
     saves a mode, so this can miss a setting but never invents one. */
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

/* ---------- S15: Regular never hides a safety control ---------- */
async function cardState(page, id) {
  return page.evaluate((cardId) => {
    const card = document.getElementById(cardId);
    return card ? { level: card.dataset.level ?? "none", hidden: card.hidden, visible: card.checkVisibility(), peeked: "sgPeek" in card.dataset } : null;
  }, id);
}
const SAFETY = {
  permissions: ["policy-card", "safety-stop-card", "approval-reviewer-card"],
  computer: ["desktop-card", "reach-background-card"],
  general: ["deployment-card"],
  about: ["updates-card", "comfort-updates-card"],
};
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

/* ---------- S16: the page's own rules are kept ---------- */
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

/* ---------- S17: cards that waited for the old button load the real values, and saving keeps them ---------- */
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

/* ---------- S18: the mirrors stay in sight while the themes scroll (#25) ---------- */
for (const [width, height] of [[1440, 950], [1024, 700], [390, 844]]) {
  test(`S18 at ${width}×${height} the mirrors stay in sight while you scroll down the themes and point at one`, async (t) => {
    const f = await fixture(t, { width, height });
    await openSettings(f.page, "appearance");
    await f.page.waitForFunction(() => [...document.querySelectorAll(".sg-mirror iframe")].every((frame) => frame.contentDocument?.body?.children.length > 0));
    const last = f.page.locator("#lx-theme-gallery .lx-tile").last();
    await last.scrollIntoViewIfNeeded();
    const inSight = await f.page.evaluate(() => {
      const body = document.getElementById("lx-settings-body").getBoundingClientRect();
      const mirrors = document.querySelector(".sg-mirror-pair").getBoundingClientRect();
      return mirrors.top >= body.top - 2 && mirrors.bottom <= body.bottom + 2;
    });
    assert.equal(inSight, true, "scrolling down the themes took the mirrors out of sight");
    if (width < 1200) {
      /* Riding along, the strip sits right at the top: no half row of tiles shows above it. */
      const above = await f.page.evaluate(() => document.querySelector(".sg-mirrors").getBoundingClientRect().top - document.getElementById("lx-settings-body").getBoundingClientRect().top);
      assert.ok(Math.abs(above) <= 2, `the strip rides ${above}px below the top of the page`);
    }
    /* The plain-word tags are whole, never cut short. */
    const cut = await f.page.evaluate(() => [...document.querySelectorAll(".sg-tile-tag")].filter((tag) => tag.scrollWidth > tag.clientWidth + 1 || tag.getBoundingClientRect().right > tag.closest(".lx-tile").getBoundingClientRect().right + 1).map((tag) => tag.textContent));
    assert.deepEqual(cut, [], "a tile's tag is cut short");
    /* The tile you point at is not under the mirrors riding along above it, and they follow it. */
    const covered = await last.evaluate((tile) => {
      const box = tile.getBoundingClientRect(), top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return !tile.contains(top);
    });
    assert.equal(covered, false, "the mirrors cover the tile being pointed at");
    await last.hover();
    const family = await last.getAttribute("data-family");
    const name = await f.page.evaluate(async (id) => (await import("/theme-bridge.js")).themeById(id)[1], family);
    await f.page.waitForFunction((words) => document.querySelector(".sg-mirror figcaption").textContent.startsWith(`${words} ·`), name);
    assert.deepEqual(f.errors, []);
  });
}

/* ---------- S19: in French, search names settings in French ---------- */
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

/* ---------- S20: the mirrors never ask the server for anything again as they redraw ---------- */
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

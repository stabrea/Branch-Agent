/**
 * phase2/settings: Settings grown up — groups by task, Regular / Advanced / Technical, every setting
 * reachable and findable, the cog after the account row, keeping your place, nothing overflowing.
 *
 * The checklist is the settings audit of the real app (tests/fixtures/settings-inventory.json, 530
 * settings with their fresh-install defaults). Every one must have a control in the window (or, when it
 * has no id of its own, the stand-in public/settings-index.js names), live where the audit says, start
 * at its real default, and be found by Settings search.
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, call, errors, app };
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
  const link = page.locator(`.lx-settings-link[data-page="${name}"]`);
  /* On a phone the pages are one choice under the search box. */
  if (await link.isVisible()) await link.click();
  else await page.locator("#sg-page-pick").selectOption(name);
}
/** Every place, every Settings page and every Models tab, so every module has drawn its cards. */
async function visitEverything(page) {
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    for (const home of globalThis.branchLayout.homes()) if (!home.startsWith("settings")) { globalThis.branchLayout.go(home); await wait(150); }
  });
  await openSettings(page);
  const pages = await page.evaluate(() => [...document.querySelectorAll("#sg-page-pick option")].map((option) => option.value));
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
  const more = f.page.locator('.sg-head[data-bucket="general:start"] .sg-more');
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
  assert.match(await f.page.locator("#never-break-card .sg-keys-names").getAttribute("data-keys"), /never-break\.mode/);
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

test("S8 the level is the owner's to change: a household profile is refused, as for every preference", () => {
  assert.notEqual(offLimitsToHousehold("POST", "/api/preferences"), null);
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
    const count = [];
    const watch = new MutationObserver((records) => { for (const r of records) if (r.target.closest?.(".sg-head") || r.target.parentElement?.closest(".sg-head")) count.push(`${r.type} ${r.attributeName ?? ""} on ${r.target.className || r.target.nodeName}`); });
    watch.observe(document.getElementById("settings-window"), { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { watch.disconnect(); done(count); }, 1500);
  }));
  /* A card arriving late may rightly change a heading once or twice; a loop rewrites it every frame. */
  assert.ok(churn.length < 10, `the group headings keep rewriting themselves: ${churn.slice(0, 5).join("; ")}`);
  await f.page.evaluate(() => {
    const card = document.createElement("section");
    card.className = "card";
    card.id = "someone-elses-card";
    card.dataset.home = "settings:general";
    card.textContent = "A card added later";
    document.body.append(card);
  });
  await f.page.locator("#lx-page-general > #someone-elses-card").waitFor({ state: "visible" });
  await f.page.locator('#lx-page-general > .sg-head[data-bucket="general:other"] + #someone-elses-card').waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

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
    const pages = await f.page.evaluate(() => [...document.querySelectorAll("#sg-page-pick option")].map((option) => option.value));
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
  const chips = document.querySelectorAll("#lx-settings-body :is(.chip, .pill, .badge, .status-pill, .lx-count, [class*='chip'], [class*='pill'], [class*='badge'], .sg-more)");
  for (const chip of chips) {
    if (!chip.checkVisibility()) continue;
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

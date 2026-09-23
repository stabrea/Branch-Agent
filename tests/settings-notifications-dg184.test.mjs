/* DG-184: Settings › Notifications is the approved sample's page: its one section, When Branch gets your attention,
   with Hold messages overnight, Where you are told and Sound on show at Regular and "5 more with Advanced" for the
   rest; at Advanced the same three, then the sample's "More options 5" holding news only, a second opinion,
   holidays, from and until, in that order. Its cards read as that section's rows, with no titles of their own
   (DG-008, DG-024), and every choice is saved the moment it changes, with no Save button (DG-025). The same at 1440,
   860 and 400 px, with Show everything on and off, and in French. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BUCKETS } from "../public/settings-buckets.js";

const REGULAR = ["hold-overnight", "comfort-method", "comfort-sound"];
/* The sample's order behind "More options" (design/Branch-Grown-Up.html, Notifications at Advanced). */
const ADVANCED = ["quiet-switch-news", "heartbeat-second", "holidays", "hold-from", "hold-until"];

test("DG-184 Notifications has the sample's one section, in the sample's order, every card kept", () => {
  assert.deepEqual(BUCKETS.notifications.map((bucket) => bucket[2]), ["When Branch gets your attention"]);
  assert.deepEqual(BUCKETS.notifications[0][4].map(([card]) => card),
    ["lx-collab-overnight", "comfort-notify-card", "quiet-interruptions", "lx-collab-days-off"]);
  assert.deepEqual(BUCKETS.notifications[0][5], { moreAfter: "comfort-notify-card" });
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-notifications-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchLayout.go("settings:notifications"));
  await page.locator("#heartbeat-second").waitFor({ state: "attached" });
  await page.locator("#hold-overnight").waitFor({ state: "attached" });
  return { app, page, call, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value))
  .then(() => page.waitForTimeout(300));
/**
 * What the page shows: its headings, its "N more" line, its "More options" and whether it is open, the settings on
 * show in the order they stand (by place in the page, and checked to run down the screen), and any Save button.
 */
const shown = (page) => page.evaluate((ids) => {
  const box = document.getElementById("lx-page-notifications");
  const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const text = (node) => node.textContent.trim().replace(/\s+/g, " ");
  const controls = ids.map((id) => document.getElementById(id)).filter((node) => node && box.contains(node) && seen(node))
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const tops = controls.map((node) => node.getBoundingClientRect().top);
  return {
    headings: [...box.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(seen).map(text),
    more: [...box.querySelectorAll(".sg-more")].filter(seen).map(text),
    options: [...box.querySelectorAll(".sg-fold")].filter(seen).map((node) => `${text(node)} ${node.getAttribute("aria-expanded")}`),
    controls: controls.map((node) => node.id),
    downward: tops.every((top, i) => i === 0 || top > tops[i - 1]),
    saves: [...box.querySelectorAll("button")].filter(seen).filter((button) => /^(Save|Enregistrer)$/.test(text(button))).length,
    wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}, [...REGULAR, ...ADVANCED]);

const moreOptions = (page) => page.locator("#lx-page-notifications .sg-fold").click().then(() => page.waitForTimeout(200));

test("DG-184 the page's sections, counts and rows match the sample at 1440, 860 and 400, Show everything on and off", async (t) => {
  const { page, errors } = await fixture(t);
  for (const width of [1440, 860, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const everything of ["off", "on"]) {
      await page.evaluate((one) => { document.documentElement.dataset.everything = one; }, everything);
      const where = `${width} px, Show everything ${everything}`;
      await level(page, "regular");
      /* The cards come from three modules that each draw when their data arrives; the count settles after the last. */
      await page.waitForFunction(() => [...document.querySelectorAll("#lx-page-notifications .sg-more")]
        .some((node) => node.getClientRects().length && node.textContent.trim().startsWith("5 ")), null, { timeout: 5000 }).catch(() => {});
      const regular = await shown(page);
      assert.deepEqual(regular.headings, ["Notifications", "When Branch gets your attention"], where);
      assert.deepEqual(regular.more, ["5 more with Advanced"], where);
      assert.deepEqual(regular.options, [], `${where}: nothing to fold at Regular`);
      assert.deepEqual(regular.controls, REGULAR, where);
      assert.ok(regular.downward, where);
      assert.equal(regular.saves, 0, `${where}: saved as you go`);
      assert.ok(regular.wide <= 0, `${where}: no sideways scrolling`);
      await level(page, "advanced");
      const advanced = await shown(page);
      assert.deepEqual(advanced.headings, ["Notifications", "When Branch gets your attention"], where);
      assert.deepEqual(advanced.more, [], where);
      assert.deepEqual(advanced.options, ["More options 5 false"], where);
      assert.deepEqual(advanced.controls, REGULAR, `${where}: the rest wait behind More options`);
      await moreOptions(page);
      const opened = await shown(page);
      assert.deepEqual(opened.options, ["More options 5 true"], where);
      assert.deepEqual(opened.controls, [...REGULAR, ...ADVANCED], `${where}: the sample's order`);
      assert.ok(opened.downward, `${where}: ${opened.controls.join(", ")} run down the page`);
      assert.equal(opened.saves, 0, where);
      assert.ok(opened.wide <= 0, `${where}: no sideways scrolling`);
      await moreOptions(page);
      assert.deepEqual((await shown(page)).controls, REGULAR, `${where}: More options closes again`);
    }
  }
  assert.deepEqual(errors, []);
});

test("DG-184 search finds what More options keeps folded, and each choice is saved the moment it changes", async (t) => {
  const { app, page, call, errors } = await fixture(t);
  await level(page, "advanced");
  await page.locator("#lx-settings-search").fill("Holidays for");
  await page.locator("#holidays").waitFor({ state: "visible" });
  await page.locator("#lx-settings-search").fill("");
  await page.waitForFunction(() => !document.body.classList.contains("lx-settings-searching"));
  await page.locator("#holidays").waitFor({ state: "hidden" });
  await moreOptions(page);
  await page.locator("#comfort-sound").selectOption("chime");
  await page.waitForFunction(() => document.querySelector("#comfort-notify-card [role=status]")?.textContent.trim().length > 0);
  assert.equal(readComfort(app.store, "local", "notify").sound, "chime");
  await page.locator("#hold-overnight").check();
  await page.waitForFunction(() => document.getElementById("hold-overnight")?.checked);
  await page.waitForTimeout(500);
  assert.equal((await call("/api/calendar")).settings.quietHours.enabled, true);
  await page.locator("#quiet-switch-news").selectOption("on");
  await page.waitForTimeout(800);
  assert.equal((await app.scheduler.overview("local")).switches.notifyGate, "on");
  assert.deepEqual(errors, []);
});

test("DG-184 in French the page keeps its one section and its rows speak French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForTimeout(500);
  await level(page, "regular");
  const regular = await shown(page);
  assert.equal(regular.headings.length, 2);
  assert.equal(regular.headings[1], "Quand Branch attire votre attention");
  assert.deepEqual(regular.controls, REGULAR);
  await level(page, "advanced");
  assert.deepEqual((await shown(page)).options, ["Plus d’options 5 false"]);
  const words = await page.evaluate(() => ["hold-overnight", "hold-from", "hold-until", "holidays"]
    .map((id) => document.getElementById(id).labels[0].textContent.trim()));
  assert.deepEqual(words, ["Retenir les messages la nuit", "Retenir les messages à partir de", "Retenir les messages jusqu’à", "Jours fériés de"]);
  assert.deepEqual(errors, []);
});

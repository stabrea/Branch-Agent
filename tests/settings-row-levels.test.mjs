/* DG-199: Settings levels each setting's row as the approved sample does (public/settings-row-levels.js, measured from
   design/Branch-Grown-Up.html), and "N more with …" counts what a section keeps out of sight row by row, as the
   sample counts it: each setting out of sight, in a card on show or not; a card with no setting rows counts for
   nothing, and a card shows at the lowest level of its rows (coordinator, 2026-09-23). The
   sample's Under the hood has no head and no "N more" line until something in it is on show, is Technical, and comes
   last. A row is only ever the words, the control and the note of one setting, never a title or a neighbour. Search
   and a link to one setting still show a row whatever the level. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { SETTINGS_INDEX } from "../public/settings-index.js";
import { ROW_LEVELS } from "../public/settings-row-levels.js";
import { BUCKETS } from "../public/settings-buckets.js";

test("DG-199 the row levels name real settings, with a level each", () => {
  const known = new Set(SETTINGS_INDEX.map((row) => row[0]));
  const ids = Object.keys(ROW_LEVELS);
  assert.ok(ids.length >= 450, `the sample's rows are all there (${ids.length})`);
  assert.deepEqual(ids.filter((id) => !known.has(id)), [], "every leveled row is a setting Branch has");
  assert.deepEqual(ids.filter((id) => !["R", "A", "T"].includes(ROW_LEVELS[id])), []);
});

test("DG-199 Under the hood is Technical and last on every page that has it", () => {
  for (const [page, buckets] of Object.entries(BUCKETS)) {
    const at = buckets.findIndex((bucket) => bucket[0] === "under");
    if (at < 0) continue;
    assert.equal(at, buckets.length - 1, `${page}: last`);
    assert.deepEqual([...new Set(buckets[at][4].map(([, level]) => level))], ["technical"], `${page}: Technical`);
  }
});

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-row-levels-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  /* Opened as a person opens it, not through the helper that also shows every card of the page. */
  await page.keyboard.press("Control+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  return { page, errors };
}
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value));
const pages = (page) => page.evaluate(() => [...document.querySelectorAll(".lx-settings-link[data-page]")].map((link) => link.dataset.page));
const open = async (page, name) => {
  await page.evaluate((one) => globalThis.branchLayout.go(`settings:${one}`), name);
  await page.waitForTimeout(400);
};

test("DG-199 each marked row holds one setting and its words, never a title or a neighbour", async (t) => {
  const { page, errors } = await settings(t);
  await level(page, "technical");
  for (const name of await pages(page)) await open(page, name);
  const seen = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const ids = new Set(SETTINGS_INDEX.map((row) => row[0]));
    const pieces = [...document.querySelectorAll("[data-sg-row]")];
    const wrong = pieces.filter((piece) => piece.matches("h2, h3") || piece.querySelector("h2, h3")
      || [...piece.querySelectorAll("[id]")].filter((node) => ids.has(node.id) && node.matches("input, select, textarea")).some((node) => node.id !== piece.dataset.sgRow));
    return { rows: new Set(pieces.map((piece) => piece.dataset.sgRow)).size, wrong: wrong.map((piece) => `${piece.tagName}:${piece.dataset.sgRow}`) };
  });
  assert.ok(seen.rows >= 140, `the sample's Advanced and Technical rows are found in their cards (${seen.rows})`);
  assert.deepEqual(seen.wrong, []);
  assert.deepEqual(errors, []);
});

/** On the page open now: each marked row's level and whether it is on show, and each section's line and its own count. */
const onPage = (page, name) => page.evaluate(async (name) => {
  const { SETTINGS_INDEX } = await import("/settings-index.js");
  const { ROW_LEVELS } = await import("/settings-row-levels.js");
  const word = { R: "regular", A: "advanced", T: "technical" }, rank = { regular: 0, advanced: 1, technical: 2 };
  const now = rank[document.documentElement.dataset.settingsLevel];
  const host = document.getElementById(`lx-page-${name}`);
  const rows = [...host.querySelectorAll("[data-sg-row]")].filter((piece) => piece.closest("[data-sg-bucket]")?.checkVisibility());
  const leveled = (card) => SETTINGS_INDEX.filter((row) => row[2] === card.id && ROW_LEVELS[row[0]]).map((row) => word[ROW_LEVELS[row[0]]]);
  const sections = [...host.querySelectorAll(".sg-head")].map((head) => {
    const cards = head.dataset.cards.split(" ").filter(Boolean).map((id) => document.getElementById(id)).filter((card) => card && !card.hidden);
    let expected = 0;
    for (const card of cards) {
      if (rank[card.dataset.level ?? "regular"] > now) expected += leveled(card).length;
      else expected += new Set([...card.querySelectorAll("[data-sg-row]")].filter((piece) => rank[piece.dataset.level] > now).map((piece) => piece.dataset.sgRow)).size;
    }
    const line = host.querySelector(`.sg-more-line[data-bucket="${head.dataset.bucket}"]`);
    return { bucket: head.dataset.bucket, head: head.checkVisibility(), line: line && !line.hidden ? Number(/\d+/.exec(line.textContent)?.[0]) : 0, expected };
  });
  /* A row is on show when any of its pieces is (a note under it may hide itself). */
  const byId = new Map();
  for (const piece of rows) {
    const row = byId.get(piece.dataset.sgRow) ?? { id: piece.dataset.sgRow, level: piece.dataset.level, shown: false };
    row.shown ||= piece.checkVisibility();
    byId.set(row.id, row);
  }
  return { rows: [...byId.values()], sections };
}, name);

test("DG-199 rows show at the sample's level, and each section counts what it keeps out of sight row by row", async (t) => {
  const { page, errors } = await settings(t);
  const rank = { regular: 0, advanced: 1, technical: 2 };
  /* A row can be out of sight for its own reasons too (a switch above it is off): what shows at Technical is the baseline. */
  const baseline = new Map();
  for (const now of ["technical", "advanced", "regular"]) {
    await level(page, now);
    for (const name of await pages(page)) {
      await open(page, name);
      /* Some cards draw themselves late: read again until every section's line agrees, or give the last reading. */
      let seen = await onPage(page, name);
      for (let tries = 0; tries < 10 && seen.sections.some((one) => !one.bucket.endsWith(":under") && one.line !== one.expected); tries++) {
        await page.waitForTimeout(300);
        seen = await onPage(page, name);
      }
      for (const row of seen.rows) {
        if (now === "technical") { baseline.set(row.id, row.shown); continue; }
        if (!baseline.has(row.id)) continue; // its card was on another sub-page when Technical was measured
        assert.equal(row.shown, baseline.get(row.id) && rank[row.level] <= rank[now], `${name} at ${now}: ${row.id} (${row.level})`);
      }
      for (const section of seen.sections.filter((one) => !one.bucket.endsWith(":under")))
        assert.equal(section.line, section.expected, `${name} at ${now}: ${section.bucket} says ${section.line} more`);
    }
  }
  assert.ok(baseline.size >= 30, `rows on show at Technical, compared at each level (${baseline.size})`);
  assert.deepEqual(errors, []);
});

test("DG-199 a card shows at the lowest level of its rows", async (t) => {
  const { page, errors } = await settings(t);
  await level(page, "technical");
  for (const name of await pages(page)) await open(page, name);
  const wrong = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const { ROW_LEVELS } = await import("/settings-row-levels.js");
    const word = { R: "regular", A: "advanced", T: "technical" }, rank = { regular: 0, advanced: 1, technical: 2 };
    const out = [];
    for (const card of document.querySelectorAll("[data-sg-bucket]")) {
      if (card.dataset.sgBucket.endsWith(":under")) continue;
      const own = SETTINGS_INDEX.filter((row) => row[2] === card.id);
      const levels = own.filter((row) => ROW_LEVELS[row[0]]).map((row) => word[ROW_LEVELS[row[0]]]);
      if (!levels.length) continue;
      let lowest = levels.reduce((low, one) => (rank[one] < rank[low] ? one : low), "technical");
      /* A card holding a setting the sample does not level is never raised by the others (the policy card's own control). */
      const section = levels.length < own.length ? card.dataset.sgSectionLevel : null;
      if (section && rank[lowest] > rank[section]) lowest = section;
      if (card.dataset.level !== lowest) out.push(`${card.id}: ${card.dataset.level} not ${lowest}`);
    }
    return out;
  });
  assert.deepEqual(wrong, []);
  assert.deepEqual(errors, []);
});

test("DG-199 Under the hood has no head and no line until something in it shows", async (t) => {
  const { page, errors } = await settings(t);
  await open(page, "data");
  for (const [now, shown] of [["regular", false], ["advanced", false], ["technical", true]]) {
    await level(page, now);
    await page.waitForTimeout(300);
    const under = (await onPage(page, "data")).sections.find((one) => one.bucket === "data:under");
    assert.deepEqual({ head: under.head, line: under.line }, { head: shown, line: 0 }, `at ${now}`);
  }
  const last = await page.evaluate(() => [...document.querySelectorAll("#lx-page-data .sg-head")].filter((head) => head.checkVisibility()).at(-1)?.dataset.bucket);
  assert.equal(last, "data:under", "and last");
  assert.deepEqual(errors, []);
});

test("DG-199 search and a link to one setting show a row whatever the level", async (t) => {
  const { page, errors } = await settings(t);
  await level(page, "technical");
  for (const name of await pages(page)) await open(page, name);
  const target = await page.evaluate(() => {
    const piece = [...document.querySelectorAll('[data-sg-row][data-level="advanced"]')].find((one) => one.matches("label, :has(label)") && one.textContent.trim().length > 6);
    return piece ? { id: piece.dataset.sgRow, words: (piece.matches("label") ? piece : piece.querySelector("label")).textContent.trim().slice(0, 40), page: piece.closest(".lx-page").id.replace("lx-page-", "") } : null;
  });
  assert.ok(target, "an Advanced row to look for");
  await level(page, "regular");
  await open(page, target.page);
  const shown = () => page.evaluate((id) => document.querySelector(`[data-sg-row="${id}"]`)?.checkVisibility() ?? false, target.id);
  assert.equal(await shown(), false, `${target.id} is out of sight at Regular`);
  await page.locator("#lx-settings-search").fill(target.words);
  await page.waitForFunction(() => document.body.classList.contains("lx-settings-searching"));
  assert.equal(await shown(), true, "search shows it");
  await page.locator("#lx-settings-search").fill("");
  await page.waitForFunction(() => !document.body.classList.contains("lx-settings-searching"));
  await page.evaluate((id) => globalThis.branchSettingsLevel.peek(document.querySelector(`[data-sg-row="${id}"]`)), target.id);
  assert.equal(await shown(), true, "a link to it shows it");
  assert.deepEqual(errors, []);
});

/* DG-061: Settings search results open under the approved sample's head (design/Branch-Grown-Up.html,
   `renderSettings`): "N results" as the page's heading, then "for “what was typed”", and "Nothing matches. Try a
   shorter word." when nothing does. In French the head, its plural and every indexed setting are French: a setting
   found before its control is drawn no longer falls back to the index's English. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { closeSettings, openSettings } from "./places.mjs";

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-search-head-"));
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
  await openSettings(page);
  return { page, errors };
}

const search = async (page, words) => {
  await page.locator("#lx-settings-search").fill(words);
  await page.waitForFunction((typed) => !typed || document.getElementById("sg-results"), words);
};

/** The head as drawn, and the results it counts: the cards on show plus everything "Also found" lists. */
const head = (page) => page.evaluate(() => {
  const box = document.getElementById("sg-results");
  const cards = [...document.querySelectorAll(".lx-page:not([hidden]) :is(.lx-subpanel > *, .lx-page > *)")]
    .filter((card) => !card.matches(".lx-page-title, .lx-page-intro, .lx-subtabs, .lx-subpanel, .lx-on-this-page, .sg-head, .lx-miss")
      && card.checkVisibility()).length;
  /* "Show all N" names the whole count when only the first few are listed. */
  const all = document.querySelector("#sg-found .sg-found-all");
  const also = all ? Number(all.textContent.match(/\d+/)[0]) : document.querySelectorAll("#sg-found .sg-found-item").length;
  return box && {
    first: box === document.getElementById("lx-settings-body").firstElementChild,
    role: box.getAttribute("role"),
    level: box.querySelector("h2") ? 2 : null,
    title: box.querySelector("h2")?.textContent, line: box.querySelector(".sg-results-for")?.textContent,
    lineShown: box.querySelector(".sg-results-for")?.checkVisibility(), counted: cards + also,
    empty: document.getElementById("lx-settings-empty")?.textContent ?? null,
  };
});

test("DG-061 search results open under the sample's head: the count, then what was searched for", async (t) => {
  const { page, errors } = await settings(t);
  await search(page, "voice");
  const seen = await head(page);
  assert.ok(seen, "a head is drawn over the results");
  assert.equal(seen.first, true, "at the top of the results");
  assert.equal(seen.level, 2, "as the page's heading");
  assert.equal(seen.role, "status", "and read out as it changes");
  assert.ok(seen.counted > 1, `the search found several (${seen.counted})`);
  assert.equal(seen.title, `${seen.counted} results`, "it counts every result shown");
  assert.equal(seen.line, "for “voice”");
  assert.equal(seen.lineShown, true);
  /* Nothing found: the head says so, with the sample's words under it. */
  await search(page, "zzqqxx");
  const none = await head(page);
  assert.equal(none.title, "0 results");
  assert.equal(none.line, "for “zzqqxx”");
  assert.equal(none.empty, "Nothing matches. Try a shorter word.");
  /* Cleared, the head goes with the search. */
  await page.locator("#lx-settings-search").fill("");
  await page.waitForFunction(() => !document.getElementById("sg-results"));
  assert.deepEqual(errors, []);
});

test("DG-061 in French the head, its plural and the empty line are French", async (t) => {
  const { page, errors } = await settings(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await search(page, "voix");
  const seen = await head(page);
  const plural = await page.evaluate((n) => new Intl.PluralRules("fr").select(n), seen.counted);
  assert.equal(seen.title, `${seen.counted} ${plural === "one" ? "résultat" : "résultats"}`, "French plural, 0 and 1 singular");
  assert.equal(seen.line, "pour « voix »");
  await search(page, "zzqqxx");
  const none = await head(page);
  assert.equal(none.title, "0 résultat", "French counts nothing in the singular");
  assert.equal(none.empty, "Rien ne correspond. Essayez un mot plus court.");
  assert.deepEqual(errors, []);
});

test("DG-061 every setting the search can find has French words, drawn or not", async (t) => {
  const { page, errors } = await settings(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const missing = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const { fromEnglish } = await import("/i18n.js");
    return SETTINGS_INDEX.flatMap((row) => [row[3], row[6]]).filter((words) => words && fromEnglish(words) === null);
  });
  assert.deepEqual(missing, [], "no indexed setting or card title is left without French");
  /* And through the window: a chat app whose control is not drawn yet is found by its French name. */
  await search(page, "twitch");
  const found = await page.locator("#sg-found .sg-found-words b").allTextContents();
  assert.ok(found.includes("Chat Twitch"), `found in French (${found.join(", ")})`);
  assert.ok(!found.includes("Twitch chat"), "not in the index's English");
  assert.deepEqual(errors, []);
});

/* Codex's review of e0d40067: the head followed typing only, so it outlived its search. */
test("DG-061 the head goes with its search when Settings opens again, and speaks the new language", async (t) => {
  const { page, errors } = await settings(t);
  await search(page, "zzqqxx");
  assert.equal((await head(page)).title, "0 results");
  /* Closed and opened again: the box is empty and General shows, with no head left over from the old search. */
  await closeSettings(page);
  await openSettings(page, "general");
  assert.equal(await page.locator("#lx-settings-search").inputValue(), "");
  assert.equal(await page.locator("#sg-results").count(), 0, "no stale results head over an ordinary page");
  assert.equal(await page.locator("#sg-found").count(), 0, "and no stale list either");
  /* A new language while results show: the head is drawn again in its words, for the same search. */
  await search(page, "voice");
  const english = await head(page);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => /résultat/.test(document.querySelector("#sg-results h2")?.textContent ?? ""));
  /* Cards draw themselves again in the new language; the count settles on what is then on show. */
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll(".lx-page:not([hidden]) :is(.lx-subpanel > *, .lx-page > *)")]
      .filter((card) => !card.matches(".lx-page-title, .lx-page-intro, .lx-subtabs, .lx-subpanel, .lx-on-this-page, .sg-head, .lx-miss")
        && card.checkVisibility()).length;
    const all = document.querySelector("#sg-found .sg-found-all");
    const also = all ? Number(all.textContent.match(/\d+/)[0]) : document.querySelectorAll("#sg-found .sg-found-item").length;
    return Number(document.querySelector("#sg-results h2")?.textContent.match(/\d+/)?.[0]) === cards + also;
  }, null, { timeout: 5000 }).catch(() => undefined);
  const french = await head(page);
  const plural = await page.evaluate((n) => new Intl.PluralRules("fr").select(n), french.counted);
  assert.equal(french.title, `${french.counted} ${plural === "one" ? "résultat" : "résultats"}`);
  assert.equal(french.line, "pour « voice »", `the same search (${english.line})`);
  assert.deepEqual(errors, []);
});

test("DG-061 a card drawn again during a search keeps the count true", async (t) => {
  const { page, errors } = await settings(t);
  await search(page, "voice");
  const before = await head(page);
  assert.equal(before.title, `${before.counted} results`);
  /* A module draws one of its cards again (as many do when their data arrives): one more card is on show. */
  await page.evaluate(() => {
    const shown = [...document.querySelectorAll(".lx-page:not([hidden]) > *:not(.lx-page-title):not(.lx-miss)")]
      .find((card) => card.matches("section, .card, [id$='-card']") && card.checkVisibility());
    const copy = shown.cloneNode(true);
    copy.id = "dg061-redrawn-card";
    shown.after(copy);
  });
  await page.waitForFunction((n) => document.querySelector("#sg-results h2")?.textContent === `${n} results`, before.counted + 1, { timeout: 5000 })
    .catch(() => undefined);
  const after = await head(page);
  assert.equal(after.counted, before.counted + 1, "one more card is on show");
  assert.equal(after.title, `${after.counted} results`, "and the head counts it");
  assert.deepEqual(errors, []);
});

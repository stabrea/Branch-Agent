/**
 * Wave mac2, quiet-jobs: the three cards in a real (headless) browser. Each says where it lives,
 * has one heading, one sentence and one filled button, and fits 400 px without sideways scrolling.
 * Screens are opened the way a person does, through tests/places.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor } from "./places.mjs";

const cards = { "quiet-checkin": "automations:scheduled", "quiet-health": "automations:scheduled", "quiet-interruptions": "settings:notifications" };

async function signIn(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

test.skip("the quiet-jobs cards name their homes, keep to the card anatomy and fit 400 px", async (t) => {
  // Redesign: replaced by the new window (the three cards and their anatomy are the old sample's; prototype.html has Automations › Check-ins, "Check in on its own", and Settings › Notifications without an interruptions gate card, and the new window has no data-t keys).
  const root = await mkdtemp(join(tmpdir(), "branch-quiet-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await openPlace(page, "schedules");
  await page.locator("#quiet-checkin h2").waitFor({ state: "visible" });
  for (const [id, home] of Object.entries(cards)) {
    const shape = await page.evaluate((cardId) => {
      const card = document.getElementById(cardId);
      const filled = [...card.querySelectorAll("button")].filter((b) => !b.classList.contains("quiet-button") && !b.classList.contains("text-button"));
      const unnamed = [...card.querySelectorAll("input, select, textarea")].filter((c) => !c.labels?.length);
      return { home: card.dataset.home, tag: card.tagName, headings: card.querySelectorAll("h2, h3").length,
        sentence: card.querySelector(":is(h2, h3) + p.subtle")?.textContent ?? "", filled: filled.length, unnamed: unnamed.length,
        keyless: [...card.querySelectorAll("h2, h3, label, button")].filter((n) => !n.dataset.t).length };
    }, id);
    assert.equal(shape.home, home, id);
    assert.equal(shape.tag, "SECTION");
    assert.equal(shape.headings, 1);
    assert.ok(shape.sentence.length > 10, `${id} says what it is for`);
    /* DG-184: the Settings card saves as you choose, as the sample does (DG-025); the Automations cards keep their button. */
    assert.equal(shape.filled, id === "quiet-interruptions" ? 0 : 1, `${id} has ${id === "quiet-interruptions" ? "no" : "one"} filled button`);
    assert.equal(shape.unnamed, 0, `${id}: every control can be named`);
    assert.equal(shape.keyless, 0, `${id}: every word goes through a key`);
  }
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `no sideways scrolling at 400 px (${wide} px over)`);
  await openSettingFor(page, "#quiet-interruptions");
  await page.locator("#quiet-interruptions select").selectOption("when-needed");
  await page.waitForTimeout(800);
  await page.waitForFunction(() => document.querySelector("#quiet-interruptions select")?.value === "when-needed");
  assert.equal((await app.scheduler.overview("local")).switches.notifyGate, "when-needed");
  assert.deepEqual(errors, []);
});

test.skip("HEARTBEAT.md has one switch: Legion's card, which the check-in card points to and reads back", async (t) => {
  // Redesign: replaced by the new window (prototype.html's Check-ins tab edits what HEARTBEAT.md checks in place, "It's HEARTBEAT.md, in plain words", with How often and Off; there is no separate file switch card to point to).
  const root = await mkdtemp(join(tmpdir(), "branch-quiet-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await signIn(page, server);
  await openPlace(page, "automations:scheduled");
  await page.locator("#quiet-checkin h2").waitFor({ state: "visible" });
  await page.locator("#context-heartbeat h2").waitFor({ state: "visible" });
  const found = await page.evaluate(() => ({
    switches: document.querySelectorAll("select[id*='heartbeat-file'], select#context-switch-heartbeat").length,
    inCheckIn: [...document.querySelectorAll("#quiet-checkin select")].map((s) => s.id),
    link: document.querySelector("#quiet-checkin a[href='#context-heartbeat']")?.dataset.t ?? null,
    sameHome: document.getElementById("context-heartbeat").dataset.home === document.getElementById("quiet-checkin").dataset.home,
  }));
  assert.equal(found.switches, 1, "exactly one control decides whether HEARTBEAT.md is read");
  assert.deepEqual(found.inCheckIn, ["heartbeat-mode"], "the check-in card only carries its own on/off/when-needed");
  assert.equal(found.link, "schedules.checkin.file-link");
  assert.ok(found.sameHome);
  await page.locator("#quiet-checkin a[href='#context-heartbeat']").click();
  await page.waitForFunction(() => document.activeElement?.id === "context-switch-heartbeat");
  await page.locator("#context-switch-heartbeat").selectOption("on");
  await page.locator("#context-heartbeat button").click();
  await page.waitForFunction(() => /HEARTBEAT\.md/.test(document.querySelector("#quiet-checkin p.subtle a")?.parentElement?.textContent ?? ""));
  const { switchFor, contextFileSettings } = await import("../dist/context-files.js");
  assert.equal(switchFor(contextFileSettings(app.store, "local"), "heartbeat"), "on", "the check-in reads what that card saved");
  assert.equal(await app.scheduler.heartbeat.checklist("local"), null, "switched on with no file yet: the file is the source, not the typed list");
});

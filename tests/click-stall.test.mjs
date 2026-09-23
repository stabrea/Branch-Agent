import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettingFor } from "./places.mjs";

/*
 * BUG-003: a press that sits in Playwright's "performing click action" and never lands.
 *
 * `tests/places.mjs` carries `pressUntil`, which clicks, checks whether the effect appeared, and falls
 * back to the keyboard. Its comment says the stall was seen on Windows build machines while the control
 * was "visible, enabled and stable". The question this file answers is which of three things owns it:
 * the product, the browser, or the runner.
 *
 * The mechanism worth testing first is Playwright's own actionability wait. Before dispatching, it
 * requires the target's box to be unchanged across two animation frames. An element that is still
 * animating never satisfies that, and the click waits — visible, enabled, and never stable. Neither
 * stalling test disables animation (`reducedMotion` appears in neither), so if the clicked controls
 * animate, that is the mechanism and it is ours, not the browser's.
 */
async function app(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-click-"));
  const made = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(made, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await made.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...options });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return page;
}

/** Every animation running anywhere between `selector` and the root, with how long each has left. */
const animationsOver = (page, selector) => page.evaluate((css) => {
  const target = document.querySelector(css);
  if (!target) return { found: false };
  const running = [];
  for (let node = target; node; node = node.parentElement)
    for (const animation of node.getAnimations?.() ?? [])
      running.push({ on: node.id || node.className || node.tagName, state: animation.playState,
        remaining: animation.effect?.getComputedTiming?.().activeDuration ?? null });
  return { found: true, running };
}, selector);

test("BUG-003: is the clicked control still animating when the click is dispatched?", async (t) => {
  const page = await app(t);                       // deliberately NOT reducedMotion, as the stalling tests are
  await openSettingFor(page, "#screen-switch-card");
  const target = "#screen-switch-card button";
  await page.locator(target).waitFor({ state: "visible", timeout: 30000 });
  const atRest = await animationsOver(page, target);
  console.log("STALL animations around the control, settled: " + JSON.stringify(atRest));
});

test("BUG-003: 100 plain clicks, no pressUntil and no inflated timeout", async (t) => {
  const page = await app(t);
  await openSettingFor(page, "#screen-switch-card");
  const button = page.locator("#screen-switch-card button");
  await button.waitFor({ state: "visible", timeout: 30000 });

  let slowest = 0, landed = 0;
  for (let press = 0; press < 100; press++) {
    const started = Date.now();
    await button.click();                          // default timeout, one attempt, no fallback
    const took = Date.now() - started;
    slowest = Math.max(slowest, took);
    landed += 1;
  }
  console.log(`STALL 100 clicks: ${landed} landed, slowest ${slowest}ms`);
  assert.equal(landed, 100, "a plain click must land every time");
  assert.ok(slowest < 5000, `the slowest click took ${slowest}ms, which is the stall this bug is about`);
});

/**
 * The mechanism, shown rather than argued: click *while the window is still opening*.
 *
 * `#lx-settings-win` animates for 220ms when a card is opened. Playwright will not dispatch until the
 * target's box has been unchanged for two animation frames, so a press issued inside that window waits
 * for the animation rather than for the product. On this Mac the wait is short because the animation is
 * short; on a loaded machine the same animation takes far longer in wall-clock frames, which is the
 * stall `pressUntil` was written to hide.
 */
async function clickWhileOpening(t, options) {
  const page = await app(t, options);
  const worst = [];
  for (let round = 0; round < 12; round++) {
    await page.evaluate(() => document.getElementById("lx-settings-win")?.close?.());
    const opening = openSettingFor(page, "#screen-switch-card");   // deliberately not awaited first
    const button = page.locator("#screen-switch-card button");
    const started = Date.now();
    await button.click({ timeout: 20000 });
    worst.push(Date.now() - started);
    await opening.catch(() => {});
  }
  return { slowest: Math.max(...worst), median: worst.sort((a, b) => a - b)[Math.floor(worst.length / 2)] };
}

test("BUG-003: pressing while the window is still opening is what waits", async (t) => {
  const moving = await clickWhileOpening(t, {});
  console.log("STALL clicking mid-animation      : " + JSON.stringify(moving));
});

test("BUG-003: the same presses with animation turned off", async (t) => {
  const still = await clickWhileOpening(t, { reducedMotion: "reduce" });
  console.log("STALL clicking with reduced motion: " + JSON.stringify(still));
});

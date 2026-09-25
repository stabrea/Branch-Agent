/**
 * Dogfood E1: after the model is picked, the first-run card asks two more short questions, how Branch should look and
 * how much it should ask, each one click with Skip, before it is done (public/onboarding.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readPolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function openFresh(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-onboarding-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#first-run").waitFor({ state: "visible", timeout: 30000 });
  return { app, page, errors };
}
const onboardingDone = (app) => app.store.get("settings", app.runtime.owner, "onboarding")?.data?.done === true;

test("after the model, the card asks how it should look and how much it should ask, then it is done", async (t) => {
  const { app, page, errors } = await openFresh(t);
  assert.equal(await page.locator("#first-run .onboarding-count").first().textContent(), "1 of 3");
  await page.locator("#first-run-done").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#first-run-done").click();
  const step = page.locator("#first-run .onboarding-step");
  await step.waitFor({ state: "visible" });
  assert.equal(await step.locator(".onboarding-count").textContent(), "2 of 3");
  assert.equal(await step.locator("h2").textContent(), "How should it look?");
  await step.locator('[data-choice="light"]').click();
  await page.waitForFunction(() => document.querySelector("#first-run .onboarding-step")?.dataset.step === "3");
  assert.equal(await page.locator("#first-run .onboarding-step h2").textContent(), "How much should it ask?");
  await page.locator('#first-run [data-choice="ask-before-changes"]').click();
  await page.locator("#first-run").waitFor({ state: "hidden", timeout: 30000 });
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "ask-before-changes", "the choice was saved");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.appearance ?? document.documentElement.dataset.theme ?? ""), "daylight");
  assert.equal(onboardingDone(app), true);
  assert.deepEqual(errors, []);
});

test("both questions can be skipped, and nothing is changed", async (t) => {
  const { app, page } = await openFresh(t);
  const before = readPolicy(app.store, app.runtime.owner).preset;
  await page.locator("#first-run-done").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#first-run-done").click();
  // Mac mini's E1 review: the three doors sit on one row at desktop width.
  await page.locator("#first-run .onboarding-step .door").first().waitFor({ state: "visible" });
  const rows = await page.locator("#first-run .onboarding-step .door").evaluateAll((doors) => doors.map((door) => door.getBoundingClientRect().top));
  assert.equal(new Set(rows).size, 1, `the look doors share one row (${rows.join(", ")})`);
  await page.locator("#first-run .onboarding-skip").click();
  await page.waitForFunction(() => document.querySelector("#first-run .onboarding-step")?.dataset.step === "3");
  // A fresh install is on No approvals, which is not a door, so Skip says it keeps it rather than keeping it silently.
  assert.equal(before, "off");
  assert.match(await page.locator("#first-run .onboarding-keeps").textContent(), /^Skip keeps No approvals/);
  assert.equal(await page.locator("#first-run .onboarding-step .door.selected").count(), 0);
  await page.locator("#first-run .onboarding-skip").click();
  await page.locator("#first-run").waitFor({ state: "hidden", timeout: 30000 });
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, before);
  assert.equal(onboardingDone(app), true);
});

test("the demo door skips the two questions, so its card does not count to three (Mac mini's E1 review)", async (t) => {
  const { page } = await openFresh(t);
  const count = page.locator("#first-run > .onboarding-count");
  assert.equal(await count.isVisible(), true);
  await page.locator("#door-demo").click();
  assert.equal(await count.isVisible(), false);
});

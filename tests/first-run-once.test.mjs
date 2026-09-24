/**
 * Dogfood B7: "How should Branch think?" came back on every new conversation and covered it, although ChatGPT was
 * connected and "Done, start chatting" had been pressed. Good looks like: shown once, never again once a model works.
 * The first answer from a real model ends setup; the offline demonstration does not.
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

const answering = { name: "answering", async complete() { return { content: "Hello there.", toolCalls: [], usage: { input: 20, output: 3 } }; } };

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-setup-once-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(presets ? { presets } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const onboarding = async () => (await (await fetch(server.url + "/api/state", { headers: { authorization: "Bearer " + server.token } })).json()).onboarding;
  return { app, server, onboarding };
}

test("the first answer from a real model ends setup, without the owner pressing Done", async (t) => {
  const { app, onboarding } = await fixture(t, [{ id: "good", name: "Good model", provider: answering, model: "g-1" }]);
  assert.deepEqual(await onboarding(), { done: false }, "control: a new Branch shows the card");
  await app.runtime.run({ prompt: "hello" });
  assert.deepEqual(await onboarding(), { done: true });
});

test("the offline demonstration answering does not end setup", async (t) => {
  const { app, onboarding } = await fixture(t);
  assert.equal(app.runtime.provider.name, "offline-demo-fixture", "control: this Branch has only the demonstration");
  await app.runtime.run({ prompt: "hello" });
  assert.deepEqual(await onboarding(), { done: false });
});

test("in the window, the card goes once a model has answered and a new conversation does not bring it back", async (t) => {
  const { server } = await fixture(t, [{ id: "good", name: "Good model", provider: answering, model: "g-1" }]);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#first-run").waitFor({ state: "visible" });
  // The owner writes straight away, without pressing Done.
  await page.locator("#prompt").fill("hello");
  await page.locator("#send").click();
  await page.locator(".message.assistant").first().waitFor({ timeout: 20000 });
  await page.locator("#first-run").waitFor({ state: "hidden", timeout: 10000 });
  // New conversation (pressed again until the finished task has let go of the window).
  await page.waitForFunction(() => { document.getElementById("new-session").click(); return document.querySelectorAll("#conversation .message").length === 0; }, null, { timeout: 10000, polling: 500 });
  assert.equal(await page.locator("#first-run").isVisible(), false, "a new conversation does not bring it back");
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await page.locator("#first-run").isVisible(), false, "a reloaded window does not show it either");
  assert.deepEqual(errors, []);
});

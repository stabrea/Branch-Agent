import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, viewport = { width: 1440, height: 950 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-composer-parity-"));
  const provider = { name: "sample-model", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    presets: [
      { id: "default", name: "Default connection", provider, model: "configured" },
      { id: "alternate", name: "Alternate connection", provider, model: "other-model" },
    ],
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
  t.after(async () => {
    await context.close();
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ done: true }),
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120_000 });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120_000 });
  return page;
}

async function shape(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node?.checkVisibility()) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      form: box("#chat-form"), plus: box("#lx-plus"), prompt: box("#prompt"), mode: box("#mode-chip"),
      model: box("#lx-model-chip"), voice: box("#voice-record"), send: box("#send"),
      modelWords: document.querySelector("#lx-model-chip")?.textContent.trim() ?? "",
      viewportWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertComposerContract(measured, { compact = false } = {}) {
  assert.ok(measured.form, "the message box is visible");
  assert.ok(Math.abs(measured.form.height - 48) <= 1, `the sample bar is 48px tall, got ${measured.form.height}px`);
  for (const key of ["plus", "prompt", "mode", "model", "send"]) assert.ok(measured[key], `${key} stays in the bar`);
  for (const key of ["plus", "prompt", "mode", "model", "send"])
    assert.ok(Math.abs(measured[key].height - 34) <= 1, `${key} is 34px tall, got ${measured[key].height}px`);
  const visible = [measured.plus, measured.prompt, measured.mode, measured.model, measured.send];
  assert.ok(Math.max(...visible.map((item) => item.top)) - Math.min(...visible.map((item) => item.top)) <= 1, "controls share one line");
  assert.ok(visible.every((item) => item.left >= measured.form.left && item.right <= measured.form.right), "controls stay inside the bar");
  assert.equal(measured.voice, null, "voice recording stays hidden until voice is switched on");
  assert.equal(measured.scrollWidth <= measured.viewportWidth, true, "the composer never widens the page");
  if (!compact) assert.equal(measured.modelWords, "configured", "the chip names the model, not the connection");
}

test("the calm composer matches the sample bar at desktop, compact and phone widths", async (t) => {
  const page = await fixture(t);
  for (const [width, height, compact] of [[1440, 950, false], [1024, 700, false], [390, 844, true]]) {
    await page.setViewportSize({ width, height });
    assertComposerContract(await shape(page), { compact });
  }
});

test("the model chip opens a real model picker without leaving the conversation", async (t) => {
  const page = await fixture(t);
  await page.locator("#lx-model-chip").click();
  const menu = page.locator("#lx-model-menu");
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await menu.locator('[role="menuitemradio"]').allInnerTexts(), [
    "Default connection · configured", "Alternate connection · other-model",
  ]);
  assert.equal(await menu.getByRole("menuitem", { name: "Manage models…" }).isVisible(), true);
  await menu.locator('[role="menuitemradio"]').first().click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#workspace").isVisible(), true);
  assert.equal(await page.locator("#lx-model-chip").innerText(), "configured");
  await page.locator("#prompt").fill("Start a conversation");
  await page.locator("#send").click();
  await page.locator(".message.assistant").waitFor({ timeout: 30_000 });
  await page.locator("#lx-model-chip").click();
  assert.deepEqual(await menu.locator('[role="menuitemradio"]').allInnerTexts(), [
    "Workspace default", "Default connection · configured", "Alternate connection · other-model",
  ]);
  await menu.locator('[role="menuitemradio"]').nth(2).click();
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("#lx-model-chip")?.textContent.trim() === "other-model");
  await page.waitForTimeout(4_000);
  assert.equal(await page.locator("#lx-model-chip").innerText(), "other-model", "refresh keeps this conversation's model");
  await page.locator("#lx-model-chip").click();
  await menu.locator('[role="menuitemradio"]').first().click();
  await menu.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("#lx-model-chip")?.textContent.trim() === "configured");
});

test("the plus menu changes the real conversation choices", async (t) => {
  const page = await fixture(t);
  for (const [name, target] of [
    ["Ask me questions first", "#ask-first-toggle"],
    ["Temporary: forget this conversation afterwards", "#temporary-toggle"],
  ]) {
    await page.locator("#lx-plus").click();
    await page.locator("#lx-plus-menu").getByRole("menuitem", { name, exact: true }).click();
    assert.equal(await page.locator(target).isChecked(), true, `${name} presses its existing control`);
    assert.equal(await page.locator("#lx-plus-menu").isHidden(), true);
  }
});

test("typing, focus and selection survive the three-second redraw", async (t) => {
  const page = await fixture(t);
  const prompt = page.locator("#prompt");
  const typed = "Compare the three supplier quotes and flag delivery";
  await prompt.fill(typed);
  await prompt.evaluate((node) => node.setSelectionRange(8, 16));
  await page.waitForTimeout(7_000);
  assert.equal(await prompt.inputValue(), typed);
  assert.deepEqual(
    await prompt.evaluate((node) => ({ start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node })),
    { start: 8, end: 16, focused: true },
  );
});

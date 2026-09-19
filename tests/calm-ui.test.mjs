/* 0.18.1: the calm window. One question and one box by default; every other control is still on the
   page with its id, behind More or shown only when it matters; "Show everything" brings them back and
   is remembered for the person. (public/layout.js "the calm window", public/layout.css, public/appearance.js) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { closeSettings, openSettingFor } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* What the calm window keeps out of sight until it is asked for. */
const HIDDEN_WHEN_CALM = [
  "#lx-pane-tabs", "#lx-clear", "#lx-shield", "#thread-labels", "#aside-toggle", "#connection",
  "#composer-media", "#composer-attach", "#voice-record", "#voice-talk", "#temporary-toggle",
  "#ask-first-toggle", "#composer-specialist", "#new-session", "#meter-row", "#session-label",
  "#saved-conversations", "#rail-find", "#cmd-open", "#owner-menu-button", "#context-panel",
  "#keepoak-acorn", ".lx-model-chip",
];
/* What the calm window always shows. */
const ALWAYS = ["#prompt", "#send", "#rail-new", "#lx-settings-row", "#lx-more"];

/** A model that answers at once, or waits for `release()` when asked to sort the Downloads folder. */
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (String(asked).includes("Downloads")) await gate;
      return { content: "Done. Nothing was deleted.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}

async function fixture(t, { provider, onboarded = false, width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-calm-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  if (onboarded) await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { page, server, call, errors };
}
const visible = (page, selector) => page.locator(selector).first().isVisible();
async function shown(page, selectors) {
  const out = {};
  for (const selector of selectors) out[selector] = await visible(page, selector);
  return out;
}

test("the calm window is the default: one box, Send, New conversation, Recents, Settings and More", async (t) => {
  const f = await fixture(t, { onboarded: true });
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.everything), "off");
  const hidden = await shown(f.page, HIDDEN_WHEN_CALM);
  assert.deepEqual(Object.entries(hidden).filter(([, on]) => on).map(([selector]) => selector), [], "these still show in the calm window");
  for (const selector of HIDDEN_WHEN_CALM.filter((s) => s.startsWith("#")))
    assert.equal(await f.page.locator(selector).count(), 1, `${selector} is hidden, not removed`);
  const always = await shown(f.page, ALWAYS);
  assert.deepEqual(Object.entries(always).filter(([, on]) => !on).map(([selector]) => selector), [], "these must always show");
  assert.equal(await f.page.locator('.rail-group[data-group="recents"]').isVisible(), true, "recent conversations stay in the rail");
  assert.equal(await f.page.locator("#greeting").innerText(), "What do you want done?");
  assert.deepEqual(f.errors, []);
});

test("More reaches what the calm window hides, by pressing the real control", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#lx-more").click();
  await f.page.locator("#lx-more-menu").waitFor({ state: "visible" });
  await f.page.getByRole("menuitemcheckbox", { name: "Ask me questions first" }).click();
  assert.equal(await f.page.locator("#ask-first-toggle").isChecked(), true, "the real tick box follows the menu");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-more-menu").waitFor({ state: "hidden" });
  /* The side panel opens from More and closes the same way. */
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitem", { name: "Plan", exact: true }).click();
  await f.page.locator("#context-panel").waitFor({ state: "visible" });
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitem", { name: "Plan", exact: true }).click();
  await f.page.locator("#context-panel").waitFor({ state: "hidden" });
  /* A place opens from More too. */
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitem", { name: "Library", exact: true }).click();
  await f.page.locator("#library.lx-place").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("Show everything brings the full window back, and is remembered for this person", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await openSettingFor(f.page, "#appearance-everything");
  await f.page.locator("#appearance-everything").check();
  await closeSettings(f.page);
  const back = await shown(f.page, ["#lx-pane-tabs", "#lx-shield", "#aside-toggle", "#composer-attach", "#temporary-toggle",
    "#ask-first-toggle", "#composer-specialist", "#new-session", "#context-panel", "#rail-find", "#owner-menu-button", ".lx-gear"]);
  assert.deepEqual(Object.entries(back).filter(([, on]) => !on).map(([selector]) => selector), [], "these did not come back");
  assert.equal(await visible(f.page, "#lx-more"), false, "the full window is the old one, without More");
  /* Kept with the person's own preferences, not only in this browser. */
  const saved = await f.call("/api/state");
  assert.equal(saved.preferences.showEverything, true);
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached" });
  await f.page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  assert.equal(await visible(f.page, "#lx-pane-tabs"), true);
  assert.deepEqual(f.errors, []);
});

test("the activity panel slides in while a task runs and away when it finishes", async (t) => {
  const model = slowModel();
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  assert.equal(await visible(f.page, "#context-panel"), false, "nothing running, no panel");
  await f.page.locator("#prompt").fill("Sort my Downloads folder. Delete nothing.");
  await f.page.locator("#send").click();
  await f.page.locator("#context-panel").waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator("#context-tasks").getByText("Sort my Downloads folder").waitFor({ timeout: 15000 });
  assert.equal(await visible(f.page, "#context-allowed"), false, "while working it says only what is running");
  model.release();
  await f.page.locator(".message.assistant").waitFor();
  await f.page.locator("#context-panel").waitFor({ state: "hidden", timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

test("first run is one screen of choices with no tick boxes, and trying it takes one click", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#first-run").waitFor({ state: "visible" });
  assert.equal(await f.page.locator('#first-run input[type="checkbox"]').count(), 0, "no tick boxes on first run");
  assert.equal(await f.page.locator("#first-run .eyebrow").count(), 0, "no code-comment eyebrow");
  assert.doesNotMatch(await f.page.locator("#first-run").innerText(), /\/\//);
  for (const name of ["Use my ChatGPT plan", "Paste a key", "Try it without an account"])
    assert.equal(await f.page.getByRole("button", { name: new RegExp(name) }).isVisible(), true, name);
  await f.page.getByRole("button", { name: /Try it without an account/ }).click();
  await f.page.locator("#first-run").waitFor({ state: "hidden" });
  await f.page.locator("#prompt").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("with no model, the window says so exactly once, and says nothing about its link to Branch", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: /Try it without an account/ }).click();
  await f.page.locator("#first-run").waitFor({ state: "hidden" });
  await f.page.locator("#demo-notice").waitFor({ state: "visible" });
  const sayings = await f.page.evaluate(() => {
    const words = /not connected|offline demonstration|practice mode|connect a model|no model/i;
    const seen = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const host = node.parentElement;
      if (!words.test(node.textContent) || !host) continue;
      const box = host.getBoundingClientRect();
      if (box.width && box.height && getComputedStyle(host).visibility !== "hidden" && host.checkVisibility()) seen.push(node.textContent.trim());
    }
    return seen;
  });
  assert.deepEqual(sayings, ["Practice mode"], "the missing model is said once");
  assert.equal(await visible(f.page, "#connection"), false, "\"Connected\" is not said while all is well");
  /* When the window can no longer reach Branch, it says so plainly and offers a restart. */
  await f.page.route("**/api/health", (route) => route.abort());
  await f.page.evaluate(async () => { await globalThis.branchLayout.checkServer(); await globalThis.branchLayout.checkServer(); });
  assert.equal(await f.page.locator("#connection").innerText(), "Branch stopped responding");
  assert.equal(await visible(f.page, "#lx-restart"), true);
  await f.page.unroute("**/api/health");
  await f.page.evaluate(() => globalThis.branchLayout.checkServer());
  assert.equal(await visible(f.page, "#connection"), false);
  assert.equal(await visible(f.page, "#lx-restart"), false);
  assert.deepEqual(f.errors, []);
});

test("the calm window fits a phone: no sideways scroll, More and Send in reach", async (t) => {
  const f = await fixture(t, { onboarded: true, width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const selector of ["#prompt", "#send", "#lx-more"]) assert.equal(await visible(f.page, selector), true, selector);
  const box = await f.page.locator("#lx-more").boundingBox();
  assert.ok(box.x + box.width <= 390, "More is inside the screen");
  assert.deepEqual(f.errors, []);
});

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
import { closeSettings, openSettingFor, showEverything } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

/* What the calm window keeps out of sight until it is asked for. */
const HIDDEN_WHEN_CALM = [
  "#lx-pane-tabs", "#lx-clear", "#lx-shield", "#thread-labels", "#connection",
  "#composer-media", "#composer-attach", "#voice-record", "#voice-talk", "#temporary-toggle",
  "#ask-first-toggle", "#composer-specialist", "#new-session", "#conversation-cost", "#session-label",
  "#rail-find", "#cmd-open", "#context-panel",
  "#keepoak-acorn",
];
/* What the calm window always shows. phase2/settings: the account row now shows too, with the Settings cog after it (#37).
   phase2/panels: the one side-panel switch shows in the calm window too (owner critique #16). */
const ALWAYS = ["#prompt", "#send", "#mode-chip", ".lx-model-chip", "#rail-new", "#lx-settings-row", "#lx-more", "#owner-menu-button", "#aside-toggle"];

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
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width, height } });
  t.after(async () => {
    await context.close();
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
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { page, server, call, errors, app };
}
const visible = (page, selector) => page.locator(selector).first().isVisible();
/**
 * Where things are, measured in one step inside the page once the layout has settled: the fonts are
 * in and two frames running draw every box in the same place. Reading boxes one call at a time, or
 * after a guessed pause, can catch the page between a font arriving and it being drawn again.
 */
async function settledBoxes(page, selectors) {
  // Not waitForFunction: it does not wait on a promise, so an async check "passes" at once with
  // whatever it resolves to, null included. Each try is one step inside the page; try until settled.
  const deadline = Date.now() + 15000;
  for (;;) {
    const boxes = await page.evaluate(async (names) => {
      await document.fonts.ready;
      const read = () => names.map((name) => {
        const box = [...document.querySelectorAll(name)].at(-1)?.getBoundingClientRect(); // the last one named
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      });
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      await frame();
      const first = read();
      await frame();
      const second = read();
      return second.every(Boolean) && JSON.stringify(first) === JSON.stringify(second) ? second : null;
    }, selectors);
    if (boxes) return boxes;
    if (Date.now() > deadline) throw new Error(`the layout never settled for ${selectors.join(", ")}`);
  }
}
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
  assert.equal(await f.page.locator("#saved-conversations").count(), 0, "conversation history is not built in the thread");
  for (const selector of HIDDEN_WHEN_CALM.filter((s) => s.startsWith("#")))
    assert.equal(await f.page.locator(selector).count(), 1, `${selector} is hidden, not removed`);
  const always = await shown(f.page, ALWAYS);
  assert.deepEqual(Object.entries(always).filter(([, on]) => !on).map(([selector]) => selector), [], "these must always show");
  assert.equal(await f.page.locator('.rail-group[data-group="recents"]').isVisible(), true, "recent conversations stay in the rail");
  assert.equal(await f.page.locator("#greeting").innerText(), "What do you want done?");
  assert.deepEqual(f.errors, []);
});

test("conversation history is built only when requested and closes with Escape", async (t) => {
  const f = await fixture(t, { onboarded: true, width: 390, height: 844 });
  assert.equal(await f.page.locator("#saved-conversations").count(), 0);
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#cmd-input").fill("Conversation history");
  await f.page.locator(".cmd-item").filter({ hasText: "Conversation history" }).click();
  const dialog = f.page.getByRole("dialog", { name: "Conversation history" });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#conversation #saved-conversations").count(), 0);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#cmd-input").fill("Conversation history");
  await f.page.locator(".cmd-item").filter({ hasText: "Conversation history" }).click();
  await dialog.waitFor({ state: "visible" });
  await f.page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-profile", { detail: { owner: false } })));
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await f.page.locator("#saved-list").evaluate((list) => list.childElementCount), 0,
    "a profile switch clears the prior person's history even if its search is still loading");
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
  const back = await shown(f.page, ["#lx-shield", "#aside-toggle", "#rail-find", "#owner-menu-button", ".lx-gear"]);
  assert.deepEqual(Object.entries(back).filter(([, on]) => !on).map(([selector]) => selector), [], "these did not come back");
  /* DG-175: the message box stays the sample's slim bar; what the full window used to lay out beside it is in "+". */
  const inline = await shown(f.page, ["#composer-attach", "#temporary-toggle", "#ask-first-toggle", "#composer-specialist", "#new-session"]);
  assert.deepEqual(Object.entries(inline).filter(([, on]) => on).map(([selector]) => selector), [], "nothing extra beside the box");
  await f.page.locator("#lx-plus").click();
  const plus = await f.page.locator("#lx-plus-menu").innerText();
  for (const words of ["Attach a document", "Add a picture or a sound", "Ask me questions first", "Temporary"]) assert.match(plus, new RegExp(words));
  await f.page.keyboard.press("Escape");
  /* DG-114: the side panel is a card over the conversation, closed until asked for, in the full window too. */
  assert.equal(await visible(f.page, "#context-panel"), false, "the side panel waits to be asked for");
  await f.page.locator("#aside-toggle").click();
  await f.page.locator("#context-panel").waitFor({ state: "visible" });
  assert.equal(await visible(f.page, "#lx-pane-tabs"), true, "and it brings its tabs");
  assert.equal(await visible(f.page, "#lx-more"), false, "the full window is the old one, without More");
  /* Kept with the person's own preferences, not only in this browser. */
  /* The window saves the change a moment after it shows it; on a loaded machine that moment is longer. */
  let saved = await f.call("/api/state");
  for (let tries = 0; !saved.preferences.showEverything && tries < 50; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    saved = await f.call("/api/state");
  }
  assert.equal(saved.preferences.showEverything, true);
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached" });
  await f.page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  await f.page.locator("#aside-toggle").click();
  await f.page.locator("#context-panel").waitFor({ state: "visible" });
  assert.equal(await visible(f.page, "#lx-pane-tabs"), true);
  assert.deepEqual(f.errors, []);
});

test("the activity panel slides in while a task runs and away when it finishes", async (t) => {
  const model = slowModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  assert.equal(await visible(f.page, "#context-panel"), false, "nothing running, no panel");
  await f.page.locator("#prompt").fill("Sort my Downloads folder. Delete nothing.");
  await f.page.locator("#send").click();
  await f.page.locator("#context-panel").waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator("#context-tasks").getByText("Sort my Downloads folder").waitFor({ timeout: 15000 });
  assert.equal(await visible(f.page, "#context-allowed"), false, "while working it says only what is running, and nothing is allowed yet");
  assert.equal(await visible(f.page, "#live-stop"), true, "the running task's Stop is in view");
  model.release();
  await f.page.locator(".message.assistant").waitFor({ timeout: 60000 });
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
  let healthAuthorization = "";
  await f.page.route("**/api/alive", (route) => {
    healthAuthorization = route.request().headers().authorization ?? "";
    return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' });
  });
  /* A ten-second background probe may already be in flight. The first call can join it, so make
     three calls to guarantee the product observes its required two consecutive misses. */
  await f.page.evaluate(async () => {
    await globalThis.branchLayout.checkServer();
    await globalThis.branchLayout.checkServer();
    await globalThis.branchLayout.checkServer();
  });
  /* On a slow machine a background probe started before the refusals can still land between them; keep asking,
     boundedly, until two misses in a row have been seen. A window that never says so still fails below. */
  for (let tries = 0; tries < 10 && (await f.page.locator("#connection").innerText()) !== "Branch stopped responding"; tries++)
    await f.page.evaluate(() => globalThis.branchLayout.checkServer());
  assert.equal(healthAuthorization, `Bearer ${f.server.token}`, "the liveness check uses the signed-in session");
  assert.equal(await f.page.locator("#connection").innerText(), "Branch stopped responding");
  assert.equal(await visible(f.page, "#lx-restart"), true);
  await f.page.unroute("**/api/alive");
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

/* ---------- what must never hide in the calm window ---------- */

/** A model that writes a file when asked for a note (an approval question under "ask before changes"), and waits on Downloads. */
function askingModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const last = request.messages[request.messages.length - 1];
      const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      if (last.role === "tool") return { content: "Written.", toolCalls: [] };
      if (asked.includes("Downloads")) { await gate; return { content: "Done.", toolCalls: [] }; }
      if (asked.includes("note")) return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
      return { content: "Hello.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}

test("calm: an approval question, its answers, the waiting banner and Inbox all show; a yes it carries shows while work runs", async (t) => {
  const model = askingModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  await f.call("/api/policy", { preset: "ask-before-changes" });
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  await f.page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  for (const name of ["Yes, just now", "Yes, for this conversation", "No"])
    assert.equal(await f.page.locator("#live-ask").getByRole("button", { name, exact: true }).isVisible(), true, name);
  await f.page.locator("#attention").waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator('.lx-place-link[data-place="inbox"]').waitFor({ state: "visible", timeout: 15000 });
  /* A yes for this conversation is something it carries: it shows beside the running work. */
  await f.page.locator("#live-ask").getByRole("button", { name: "Yes, for this conversation", exact: true }).click();
  await f.page.locator("#prompt").fill("Now sort my Downloads folder.");
  await f.page.locator("#send").click();
  await f.page.locator("#context-panel").waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator("#context-allowed .allowed-row").first().waitFor({ state: "visible", timeout: 15000 });
  model.release();
  await f.page.locator("#context-panel").waitFor({ state: "hidden", timeout: 15000 });
  /* ... and it is always one step away in More, with its way to take it back. */
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitem", { name: "What is allowed right now" }).click();
  await f.page.locator("#context-allowed .allowed-revoke").first().waitFor({ state: "visible", timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

test("calm: Lockdown says so while it is on, and turns off from the banner", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitemcheckbox", { name: "Lockdown: refuse commands" }).click();
  await f.page.locator("#lx-lockbanner").waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await f.call("/api/lockdown")).on, true);
  assert.equal(await visible(f.page, "#lx-shield"), true, "the shield stays in the title bar while Lockdown is on");
  assert.equal(await f.page.locator("#lx-shield").getAttribute("aria-pressed"), "true");
  await f.page.locator("#lx-more").click();
  assert.equal(await f.page.getByRole("menuitemcheckbox", { name: "Lockdown: refuse commands" }).getAttribute("aria-checked"), "true");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-lockbanner").getByRole("button", { name: "Turn it off" }).click();
  await f.page.locator("#lx-lockbanner").waitFor({ state: "hidden", timeout: 10000 });
  assert.equal((await f.call("/api/lockdown")).on, false);
  assert.equal(await visible(f.page, "#lx-shield"), false, "and goes back under More once it is off");
  assert.deepEqual(f.errors, []);
});

test("calm: a goal keeps its Resume and Stop in view", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  const sessionId = await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  f.app.store.save("settings", "local", `goal:${sessionId}`, {
    sessionId, objective: "Make the tests pass", status: "paused", round: 2, maxRounds: 6, score: 0.4, best: 0.4, flatRounds: 0,
    missing: [], reason: "Paused. Resume to carry on.", checks: null, startedAt: new Date().toISOString(), elapsedMs: 1000, activeSince: null, lastRunId: null,
  });
  const strip = f.page.locator("#goal-strip");
  await strip.waitFor({ state: "visible", timeout: 15000 });
  assert.deepEqual(await strip.locator("button").allTextContents(), ["Resume", "Stop"]);
  assert.deepEqual(f.errors, []);
});

test("calm: More works from the keyboard and names its groups", async (t) => {
  const f = await fixture(t, { onboarded: true });
  const focused = () => f.page.evaluate(() => document.activeElement?.textContent?.trim());
  await f.page.locator("#lx-more").focus();
  await f.page.keyboard.press("Enter");
  await f.page.locator("#lx-more-menu").waitFor({ state: "visible" });
  assert.equal(await focused(), "Ask me questions first", "opening More puts the keyboard on its first row");
  await f.page.keyboard.press("ArrowDown");
  assert.equal(await focused(), "Show me the plan first");
  await f.page.keyboard.press("ArrowUp");
  await f.page.keyboard.press("ArrowUp");
  assert.equal(await focused(), "Show everything", "the arrows go round");
  await f.page.keyboard.press("Home");
  assert.equal(await focused(), "Ask me questions first");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-more-menu").waitFor({ state: "hidden" });
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "lx-more", "Escape gives the keyboard back to More");
  await f.page.keyboard.press("ArrowDown");
  await f.page.locator("#lx-more-menu").waitFor({ state: "visible" });
  const groups = await f.page.locator('#lx-more-menu [role="group"]').evaluateAll((nodes) =>
    nodes.map((node) => document.getElementById(node.getAttribute("aria-labelledby"))?.textContent));
  assert.deepEqual(groups, ["This message", "Side panel", "Go to", "This window"]);
  assert.equal(await f.page.locator("#lx-more").getAttribute("aria-haspopup"), "menu");
  assert.deepEqual(f.errors, []);
});

test("calm: a finished conversation is in Recents at once, and the next steps are offered once", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("Tell me a joke");
  await f.page.locator("#send").dispatchEvent("click");
  await f.page.locator("#rail-list .rail-item").filter({ hasText: "Tell me a joke" }).waitFor({ timeout: 10000 });
  await f.page.locator(".message.assistant").first().waitFor({ state: "visible", timeout: 60000 });
  const tip = f.page.locator("#lx-tip");
  await tip.waitFor({ state: "visible", timeout: 30000 });
  assert.equal(await tip.getByRole("button", { name: "Use it from my phone" }).isVisible(), true);
  await tip.getByRole("button", { name: "Not now" }).click();
  await tip.waitFor({ state: "detached" });
  await f.page.locator("#prompt").fill("And another");
  await f.page.locator("#send").dispatchEvent("click");
  await f.page.locator(".message.user").filter({ hasText: "And another" }).waitFor();
  await f.page.waitForFunction(() => document.querySelectorAll(".message.assistant").length >= 2);
  await f.page.waitForTimeout(1000);
  assert.equal(await tip.count(), 0, "never offered again");
  assert.deepEqual(f.errors, []);
});

test("calm: the offer opens the real switch rather than flipping it", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("Tell me a joke");
  await f.page.locator("#send").click();
  await f.page.locator("#lx-tip").getByRole("button", { name: "Use it from my phone" }).click();
  await f.page.locator("#phone-switch").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#phone-switch").isChecked(), false);
  assert.equal((await f.call("/api/deployment")).remote.enabled, false);
  assert.deepEqual(f.errors, []);
});

test("calm: the empty screen is the question over the box in the middle, over the same oak and glass", async (t) => {
  const f = await fixture(t, { onboarded: true });
  const [main, heading, box] = await settledBoxes(f.page, ["main", "#greeting", "#chat-form"]);
  assert.equal(await visible(f.page, "#wall"), true, "the oak behind the glass stays (the approved KeepOak look)");
  const middle = (b) => b.x + b.width / 2;
  assert.ok(Math.abs(middle(heading) - middle(box)) < 4, "the question is centred over the box");
  assert.ok(box.y - (heading.y + heading.height) < 60, "the question sits just above the box");
  assert.ok(main.y + main.height - (box.y + box.height) > 150, "the box is not at the foot while the conversation is empty");
  const top = heading.y - main.y, bottom = main.y + main.height - (box.y + box.height);
  assert.ok(Math.abs(top - bottom) < 80, `the pair is in the middle (${top} above, ${bottom} below)`);
  assert.deepEqual(f.errors, []);
});

test("calm: Restart asks the desktop app to start Branch again, and a browser loads the page again", async (t) => {
  const f = await fixture(t, { onboarded: true });
  let refused = 0;
  await f.page.route("**/api/alive", (route) => route.abort());
  const lose = () => f.page.evaluate(async () => {
    const restart = document.getElementById("lx-restart");
    /* A ten-second background check may already be in flight. The first call can legitimately join
       that one, so drive fresh checks until two refused probes have actually made Restart visible. */
    for (let tries = 0; tries < 5 && restart.hidden; tries++) await globalThis.branchLayout.checkServer();
    return !restart.hidden;
  });
  f.page.on("requestfailed", (request) => { if (request.url().includes("/api/alive")) refused++; });
  assert.equal(await lose(), true, "two failed health probes reveal Restart");
  assert.ok(refused >= 2, `only ${refused} health probes were refused`);
  await f.page.evaluate(() => { globalThis.branchDesktop = { restartBranch: async () => { globalThis.restartAsked = true; return true; } }; });
  await f.page.locator("#lx-restart").click();
  assert.equal(await f.page.evaluate(() => globalThis.restartAsked), true, "the desktop app was asked");
  await f.page.evaluate(() => { delete globalThis.branchDesktop; document.getElementById("lx-restart").disabled = false; globalThis.stillHere = true; });
  await Promise.all([f.page.waitForEvent("load"), f.page.locator("#lx-restart").click()]);
  assert.equal(await f.page.evaluate(() => globalThis.stillHere), undefined, "the browser loaded the page again");
});

test("calm: a health request that never answers times out and reveals Restart", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.evaluate(async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.fetch = (input, init = {}) => {
      if (!String(input).includes("/api/alive")) return originalFetch(input, init);
      return new Promise((resolve, reject) => {
        const stop = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init.signal?.aborted) stop();
        else init.signal?.addEventListener("abort", stop, { once: true });
      });
    };
    globalThis.setTimeout = (run, milliseconds, ...args) =>
      originalSetTimeout(run, milliseconds === 8000 ? 0 : milliseconds, ...args);
    try {
      const checks = (async () => {
        await globalThis.branchLayout.checkServer();
        await globalThis.branchLayout.checkServer();
      })();
      await Promise.race([checks, new Promise((resolve) => originalSetTimeout(resolve, 50))]);
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
  assert.equal(await f.page.locator("#lx-restart").isVisible(), true, "two timed-out probes mark Branch as unavailable");
  assert.deepEqual(f.errors, []);
});

test("the desktop restart channel answers only its own window's page, and relaunches once", async () => {
  const { registerRestartIpc, restartChannel } = await import("../dist/desktop/restart-ipc.js");
  const handlers = new Map(), closed = [];
  const ipc = { handle: (channel, run) => handlers.set(channel, run), removeHandler: (channel) => handlers.delete(channel) };
  const mainFrame = { url: "http://127.0.0.1:4000/?desktop=1" };
  const webContents = { mainFrame };
  const window = { webContents, on: (name, run) => closed.push([name, run]) };
  let relaunched = 0;
  registerRestartIpc(ipc, window, "http://127.0.0.1:4000", () => { relaunched += 1; });
  const ask = handlers.get(restartChannel);
  assert.throws(() => ask({ sender: {}, senderFrame: mainFrame }), /denied/, "another page is refused");
  assert.throws(() => ask({ sender: webContents, senderFrame: { url: "http://127.0.0.1:4000/" } }), /denied/, "a frame inside it is refused");
  assert.throws(() => ask({ sender: webContents, senderFrame: { ...mainFrame, url: "http://evil.test/" } }), /denied/);
  webContents.mainFrame = { url: "http://evil.test/" };
  assert.throws(() => ask({ sender: webContents, senderFrame: webContents.mainFrame }), /denied/, "another address is refused");
  webContents.mainFrame = mainFrame;
  assert.equal(ask({ sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(ask({ sender: webContents, senderFrame: mainFrame }), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(relaunched, 1, "two presses, one relaunch");
  closed.find(([name]) => name === "closed")[1]();
  assert.equal(handlers.has(restartChannel), false, "the channel goes with its window");
});

test("the calm window leaves the moon out behind its panes, softens the oak in the gaps, and brings both back with the sky", async (t) => {
  const f = await fixture(t, { onboarded: true });
  /* The wall is told what to show once the calm window has drawn; wait for that, not for a pause. */
  await f.page.waitForFunction(() => document.getElementById("wall")?.dataset.moon === "hidden", null, { timeout: 15000 }).catch(() => undefined);
  const look = () => f.page.evaluate(() => ({ moon: document.getElementById("wall").dataset.moon, filter: getComputedStyle(document.getElementById("wall")).filter }));
  const calmLook = await look();
  assert.equal(calmLook.moon, "hidden", "no moon glowing through a pane");
  assert.match(calmLook.filter, /blur/, "no raw pixels in the gaps between panes");
  await f.page.evaluate(() => document.documentElement.setAttribute("data-quiet", "1"));
  await f.page.waitForFunction(() => document.getElementById("wall").dataset.moon === "shown");
  assert.equal((await look()).filter, "none", "Clear the view shows the oak and its moon as they are");
  assert.deepEqual(f.errors, []);
});

test("calm: a running task reads under its message, with a real Stop, and its conversation is in Recents at once", async (t) => {
  const model = slowModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  await f.page.locator("#prompt").fill("Sort my Downloads folder. Delete nothing.");
  await f.page.locator("#send").click();
  await f.page.locator("#live-stop").waitFor({ state: "visible", timeout: 15000 });
  const [mine, card] = await settledBoxes(f.page, [".message.user", "#live-row"]);
  assert.ok(card.y > mine.y + mine.height - 1, "the working card is under the person's message");
  assert.ok(card.y - (mine.y + mine.height) < 80, "and right under it");
  assert.ok(card.height < 110, `the card is as tall as what it says (${card.height}px)`);
  const stop = await f.page.locator("#live-stop").evaluate((node) => { const s = getComputedStyle(node); return { border: s.borderTopWidth, height: node.getBoundingClientRect().height }; });
  assert.ok(parseFloat(stop.border) >= 1 && stop.height >= 30, "Stop is a button, not a small link");
  const row = f.page.locator('#rail-list .rail-line[data-running="true"]');
  await row.waitFor({ timeout: 10000 });
  assert.match(await row.innerText(), /Sort my Downloads folder[\s\S]*Working/);
  model.release();
  await f.page.locator('#rail-list .rail-line[data-running="true"]').waitFor({ state: "detached", timeout: 15000 });
  assert.equal(await f.page.locator("#rail-list .rail-item").count(), 1, "still in Recents once finished");
  assert.deepEqual(f.errors, []);
});

test("calm: the sample-height message box has + on the left and one round button: quiet, then the accent, then Stop", async (t) => {
  const model = slowModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  const form = f.page.locator("#chat-form"), send = f.page.locator("#send");
  const height = () => form.evaluate((node) => node.getBoundingClientRect().height);
  /* Colours are read once the button's own transitions have finished, not after a guessed pause. */
  const settledColour = () => send.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    return getComputedStyle(node).backgroundColor;
  });
  assert.ok((await height()) <= 62, `the empty box is one line (${await height()}px)`);
  assert.equal(await f.page.locator("#prompt").getAttribute("placeholder"), "Ask Branch to do something…");
  assert.equal(await send.getAttribute("aria-label"), "Send");
  const shape = await send.evaluate((node) => { const b = node.getBoundingClientRect(); return { w: b.width, h: b.height, r: getComputedStyle(node).borderRadius }; });
  assert.ok(Math.abs(shape.w - 34) < 2 && Math.abs(shape.h - 34) < 2 && shape.r === "50%", "the sample's round 34px button");
  assert.equal(await send.evaluate((node) => node.classList.contains("lx-empty")), true, "quiet while the box is empty");
  const quiet = await settledColour();
  /* Pressing the quiet button sends nothing and puts you in the box. */
  await send.click();
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "prompt");
  await f.page.locator("#prompt").fill("one\ntwo\nthree\nfour");
  const typedShape = await f.page.locator("#prompt").evaluate((node) => ({
    form: document.getElementById("chat-form").getBoundingClientRect().height,
    input: node.getBoundingClientRect().height,
    scrolls: node.scrollHeight > node.clientHeight,
  }));
  assert.ok(Math.abs(typedShape.form - 48) <= 1 && Math.abs(typedShape.input - 34) <= 1,
    `the sample stays 48px with a 34px input (${typedShape.form}px / ${typedShape.input}px)`);
  assert.equal(typedShape.scrolls, true, "long messages scroll inside the fixed sample bar");
  await f.page.locator("#prompt").fill("Sort my Downloads folder.");
  assert.equal(await send.evaluate((node) => node.classList.contains("lx-empty")), false);
  assert.notEqual(await settledColour(), quiet, "the accent once there is something to send");
  /* The + matches the sample: attachments, message choices, then who should answer. */
  await f.page.locator("#lx-plus").click();
  await f.page.locator("#lx-plus-menu").waitFor({ state: "visible" });
  const plusItems = await f.page.locator("#lx-plus-menu").getByRole("menuitem").allInnerTexts();
  assert.deepEqual(plusItems.slice(0, 4), ["Attach a document…", "Add a picture or a sound…", "Ask me questions first", "Temporary: forget this conversation afterwards"]);
  assert.match(plusItems.at(-1), /Your assistant/);
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-plus-menu").waitFor({ state: "hidden" });
  await send.click();
  /* While the task works, the same place holds Stop, and Stop stops it. */
  const stop = f.page.getByRole("button", { name: "Stop", exact: true }).and(f.page.locator("#lx-stop"));
  await stop.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await send.isVisible(), false);
  await stop.click();
  /* The stop is asked for at once; this scripted model only notices when its answer comes back. */
  await f.page.locator("#live-status").getByText("Stopped.").waitFor({ timeout: 10000 });
  model.release();
  await f.page.locator("#lx-stop").waitFor({ state: "hidden", timeout: 15000 });
  assert.equal(await send.isVisible(), true, "Send is back once the task has stopped");
  assert.deepEqual(f.errors, []);
});

test("calm: the empty screen offers three starting points that fill the box without sending", async (t) => {
  const f = await fixture(t, { onboarded: true });
  const chips = f.page.locator("#lx-starters .lx-starter");
  assert.deepEqual(await chips.allInnerTexts(), ["Tidy a folder", "Research something", "Plan my week"]);
  await chips.first().click();
  assert.match(await f.page.locator("#prompt").inputValue(), /Downloads folder/);
  assert.equal(await f.page.locator(".message.user").count(), 0, "nothing was sent");
  assert.equal(await f.page.locator("#send").evaluate((node) => node.classList.contains("lx-empty")), false);
  assert.deepEqual(f.errors, []);
});

/** Opens a popover by its button, then checks every way it closes (public/popover.js). */
async function everyWayClosed(page, trigger, panel, label) {
  const shown = () => page.locator(panel).first().isVisible();
  const expanded = () => page.locator(trigger).getAttribute("aria-expanded");
  /* Some fill themselves from Branch first (the label picker), so opening waits for it to show. */
  const open = async () => { await page.locator(trigger).click(); await page.locator(panel).first().waitFor({ state: "visible", timeout: 5000 }); };
  await open();
  assert.equal(await expanded(), "true", `${label} says it is open`);
  await page.locator(trigger).click();
  assert.equal(await shown(), false, `${label} closes on its own button`);
  assert.equal(await expanded(), "false", `${label} says it is closed`);
  await open();
  await page.keyboard.press("Escape");
  assert.equal(await shown(), false, `${label} closes on Escape`);
  assert.equal(await page.evaluate((css) => document.activeElement === document.querySelector(css), trigger), true, `${label} gives the keyboard back to its button`);
  await open();
  await page.locator("#conversation").click({ position: { x: 5, y: 5 } });
  assert.equal(await shown(), false, `${label} closes on a click elsewhere`);
}

test("every menu and popover closes on its own button, on Escape and on a click elsewhere, and one at a time", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor({ timeout: 30000 });
  await everyWayClosed(f.page, "#lx-more", "#lx-more-menu", "More");
  await everyWayClosed(f.page, "#lx-plus", "#lx-plus-menu", "the + in the message box");
  /* Opening one closes the other. */
  await f.page.locator("#lx-more").click();
  await f.page.locator("#lx-plus").click();
  assert.equal(await f.page.locator("#lx-more-menu").isVisible(), false, "More closes when + opens");
  assert.equal(await f.page.locator("#lx-more").getAttribute("aria-expanded"), "false");
  await f.page.keyboard.press("Escape");
  /* Ctrl+K opens the box and Ctrl+K closes it, and the keyboard goes back where it was. */
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });
  assert.equal(await f.page.evaluate(() => document.activeElement.id), "prompt");
  /* The side panel asked for from More closes from the same row. */
  for (let round = 0; round < 2; round += 1) {
    await f.page.locator("#lx-more").click();
    await f.page.getByRole("menuitem", { name: "Plan", exact: true }).click();
    /* The panel opens and closes on the next frame, so wait for it rather than read it once. */
    await f.page.locator("#context-panel").waitFor({ state: round === 0 ? "visible" : "hidden", timeout: 10000 });
  }
  /* The full window's own: the workspace and project menus, the Lockdown shield, labels (DG-101: the room meter and its popover are gone). */
  await showEverything(f.page);
  await everyWayClosed(f.page, "#owner-menu-button", "#owner-menu", "the workspace menu");
  await everyWayClosed(f.page, "#app-switcher", "#app-menu", "the project menu");
  await everyWayClosed(f.page, "#lx-shield", "#lx-lock-pop", "the Lockdown shield");
  await everyWayClosed(f.page, "#thread-labels", ".label-picker", "the label picker");
  await f.page.locator("#owner-menu-button").click();
  await f.page.locator("#lx-shield").click();
  assert.equal(await f.page.locator("#owner-menu").isVisible(), false, "one popover at a time in the full window too");
  await f.page.keyboard.press("Escape");
  /* phase2/panels: the panel's one switch closes and opens it; a tab inside the panel never closes it. */
  const toggle = f.page.locator("#aside-toggle");
  const before = await toggle.getAttribute("aria-pressed");
  await toggle.click();
  assert.notEqual(await toggle.getAttribute("aria-pressed"), before);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-pressed"), before, "pressed again, it goes back");
  if (before !== "true") await toggle.click();
  const planTab = f.page.locator('.lx-pane-tab[data-pane="plan"]');
  await planTab.click();
  await planTab.click();
  assert.equal(await planTab.getAttribute("aria-pressed"), "true", "a tab pressed twice keeps its panel open");
  assert.deepEqual(f.errors, []);
});

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
  return { page, server, call, errors, app };
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
  assert.equal(await visible(f.page, "#context-allowed"), false, "while working it says only what is running, and nothing is allowed yet");
  assert.equal(await visible(f.page, "#live-stop"), true, "the running task's Stop is in view");
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
  await f.page.locator("#lx-more").click();
  assert.equal(await f.page.getByRole("menuitemcheckbox", { name: "Lockdown: refuse commands" }).getAttribute("aria-checked"), "true");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-lockbanner").getByRole("button", { name: "Turn it off" }).click();
  await f.page.locator("#lx-lockbanner").waitFor({ state: "hidden", timeout: 10000 });
  assert.equal((await f.call("/api/lockdown")).on, false);
  assert.deepEqual(f.errors, []);
});

test("calm: a goal keeps its Resume and Stop in view", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor();
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
  await f.page.locator("#send").click();
  await f.page.locator("#rail-list .rail-item").filter({ hasText: "Tell me a joke" }).waitFor({ timeout: 10000 });
  const tip = f.page.locator("#lx-tip");
  await tip.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await tip.getByRole("button", { name: "Use it from my phone" }).isVisible(), true);
  await tip.getByRole("button", { name: "Not now" }).click();
  await tip.waitFor({ state: "detached" });
  await f.page.locator("#prompt").fill("And another");
  await f.page.locator("#send").click();
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

test("calm: the empty screen is the question over the box in the middle, on plain ground; the grove is Show everything's", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.waitForTimeout(300);
  assert.equal(await visible(f.page, "#wall"), false, "no grove behind the calm window");
  const main = await f.page.locator("main").boundingBox();
  const heading = await f.page.locator("#greeting").boundingBox();
  const box = await f.page.locator("#chat-form").boundingBox();
  const middle = (b) => b.x + b.width / 2;
  assert.ok(Math.abs(middle(heading) - middle(box)) < 4, "the question is centred over the box");
  assert.ok(box.y - (heading.y + heading.height) < 60, "the question sits just above the box");
  assert.ok(main.y + main.height - (box.y + box.height) > 150, "the box is not at the foot while the conversation is empty");
  const top = heading.y - main.y, bottom = main.y + main.height - (box.y + box.height);
  assert.ok(Math.abs(top - bottom) < 80, `the pair is in the middle (${top} above, ${bottom} below)`);
  await f.page.evaluate(() => document.getElementById("lx-quiet-exit") && document.documentElement.setAttribute("data-quiet", "1"));
  assert.equal(await visible(f.page, "#wall"), true, "Clear the view still shows the grove");
  await f.page.evaluate(() => document.documentElement.removeAttribute("data-quiet"));
  await showEverything(f.page);
  assert.equal(await visible(f.page, "#wall"), true, "Show everything brings the grove back");
  assert.deepEqual(f.errors, []);
});

test("calm: Restart asks the desktop app to start Branch again, and a browser loads the page again", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.route("**/api/health", (route) => route.abort());
  const lose = () => f.page.evaluate(async () => { await globalThis.branchLayout.checkServer(); await globalThis.branchLayout.checkServer(); });
  await lose();
  await f.page.evaluate(() => { globalThis.branchDesktop = { restartBranch: async () => { globalThis.restartAsked = true; return true; } }; });
  await f.page.locator("#lx-restart").click();
  assert.equal(await f.page.evaluate(() => globalThis.restartAsked), true, "the desktop app was asked");
  await f.page.evaluate(() => { delete globalThis.branchDesktop; document.getElementById("lx-restart").disabled = false; globalThis.stillHere = true; });
  await Promise.all([f.page.waitForEvent("load"), f.page.locator("#lx-restart").click()]);
  assert.equal(await f.page.evaluate(() => globalThis.stillHere), undefined, "the browser loaded the page again");
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

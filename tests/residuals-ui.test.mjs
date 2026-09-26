/**
 * mac7/residuals: the window's side of the leftovers (docs/agents/STATUS-residuals.md), headless
 * against the local server. Each test fails with its fix taken out.
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
import { openSettings } from "./places.mjs";

async function fixture(t, { viewport = { width: 1440, height: 1000 }, before, provider, args = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true, args });
  let page = null;
  t.after(async () => {
    /* A route still answering when the test ends failed on the closed browser (ci-flakes-3). */
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page, app);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken (ci-flakes-3).
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, page, errors, browser };
}

// Redesign: replaced by the new window (the prototype's Models page has no fallback list).
test.skip("5. the fallback list warns when a Codex program is in it next to a ChatGPT sign-in", async (t) => {
  const presets = [
    { id: "chatgpt-main", name: "ChatGPT", provider: "chatgpt", model: "gpt-5", reasoning: null, thinking: [], local: false, coolingDownUntil: null },
    { id: "cli-codex", name: "Codex (installed on this computer)", provider: "cli-agent:codex", model: "codex", reasoning: null, thinking: [], local: false, coolingDownUntil: null },
  ];
  // The window reads the models from /api/state; two stand-in connections are added to what it says.
  const { page } = await fixture(t, { before: (page) => page.route(/\/api\/state$/, async (route) => {
    const response = await route.fetch();
    const real = await response.json().catch(() => null);
    if (!real?.models) return route.fulfill({ response });
    const models = { ...real.models, presets: [...real.models.presets, ...presets], fallbackOrder: ["cli-codex"] };
    await route.fulfill({ json: { ...real, models } });
  }) });
  await openSettings(page, "models");
  await page.locator("#lx-page-models .lx-subtab[data-sub=\"connection\"]").click();
  const note = page.locator("#models-fallback-codex");
  await page.locator("#models-fallback input[value=\"cli-codex\"]").waitFor({ state: "attached", timeout: 30000 });
  await note.waitFor({ state: "visible", timeout: 10000 });
  assert.match(await note.innerText(), /different ChatGPT plan of yours/);
  await page.locator("#models-fallback input[value=\"cli-codex\"]").uncheck();
  await note.waitFor({ state: "hidden", timeout: 10000 });
  await page.locator("#models-fallback input[value=\"cli-codex\"]").check();
  await note.waitFor({ state: "visible", timeout: 10000 });
});

/** A quarter of a second of silence as a WAV file: what a voice service sends back, without one. */
function silentWav() {
  const samples = 4000, data = Buffer.alloc(samples * 2), head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8); head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Redesign: replaced by the new window (the prototype's replies have no Read aloud).
test.skip("14. Read aloud on a reply really plays: a blob: sound, no content-rule refusal, played to the end", async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "The kettle is on.", toolCalls: [] }; } };
  const { page, errors } = await fixture(t, { provider, args: ["--autoplay-policy=no-user-gesture-required"], before: async (page) => {
    // The voice service is stood in for; everything after the answer is the window's own.
    await page.route(/\/api\/voice\/speak$/, (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: silentWav() }));
    await page.addInitScript(() => {
      globalThis.__heard = { played: [], ended: 0, refused: [] };
      document.addEventListener("securitypolicyviolation", (event) => globalThis.__heard.refused.push(`${event.violatedDirective} ${event.blockedURI}`));
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        globalThis.__heard.played.push(this.src);
        this.addEventListener("ended", () => { globalThis.__heard.ended += 1; }, { once: true });
        return play.call(this);
      };
    });
  } });
  if (!(await page.locator("#first-run").isHidden())) {
    await page.getByRole("button", { name: /Try it without an account/ }).click();
    await page.locator("#first-run").waitFor({ state: "hidden" });
  }
  await page.locator("#prompt").fill("Is the kettle on?");
  await page.locator("#send").click();
  const reply = page.locator(".message.assistant").filter({ hasText: "The kettle is on." }).first();
  await reply.waitFor();
  await reply.getByRole("button", { name: "Read aloud" }).click();
  // Only a refusal of the sound counts here: the settings kit's inline style is refused too, a known
  // leftover the settings work is fixing (docs/agents/STATUS-residuals.md), and nothing to do with sound.
  const aboutSound = (line) => /media-src|default-src|blob:/.test(line);
  await page.waitForFunction((pattern) => globalThis.__heard.ended > 0 || globalThis.__heard.refused.some((line) => new RegExp(pattern).test(line)),
    "media-src|default-src|blob:", { timeout: 15000 });
  const heard = await page.evaluate(() => globalThis.__heard);
  assert.deepEqual(heard.refused.filter(aboutSound), [], "the page's content rules let the sound through");
  assert.equal(heard.played.length, 1);
  assert.match(heard.played[0], /^blob:/, "the sound is the page's own blob:");
  assert.equal(heard.ended, 1, "it played to the end");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old window's glass-list, mode-menu and usage-pop classes are gone; the prototype's popovers are .pop).
test.skip("7. the mode menu and the usage list are as opaque as the glass dropdown", async (t) => {
  const { page } = await fixture(t);
  for (const theme of ["light", "dark"]) {
    const backgrounds = await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      return ["glass-list", "mode-menu", "usage-pop"].map((name) => {
        const node = document.createElement("div");
        node.className = name;
        document.body.append(node);
        const colour = getComputedStyle(node).backgroundColor;
        node.remove();
        return colour;
      });
    }, theme);
    const [dropdown, ...others] = backgrounds;
    assert.match(dropdown, /0\.98\)$/, `${theme}: the dropdown is the 98% one (${dropdown})`);
    assert.deepEqual(others, [dropdown, dropdown], `${theme}: the mode menu and the usage list match it`);
  }
});

// Redesign: replaced by the new window (the prototype has no floating ask box in its places).
test.skip("11. Overview and People keep room at their end as tall as the floating ask box", async (t) => {
  const { page } = await fixture(t, { viewport: { width: 390, height: 700 } });
  for (const view of ["overview:here", "household:people"]) {
    await page.evaluate((v) => globalThis.branchLayout.go(v), view);
    const shell = page.locator(".lx-place:not([hidden]) .lx-panel:not([hidden]) .shell-page");
    await shell.waitFor();
    const measure = () => page.evaluate(() => {
      const place = [...document.querySelectorAll(".lx-place")].find((node) => !node.hidden);
      const ask = place.querySelector(".lx-ask"), shellPage = place.querySelector(".lx-panel:not([hidden]) .shell-page");
      const scroller = document.getElementById("workspace");
      scroller.scrollTop = scroller.scrollHeight;
      const last = shellPage.lastElementChild.getBoundingClientRect().bottom;
      return { ask: ask.offsetHeight, room: parseFloat(getComputedStyle(shellPage).paddingBottom), clear: ask.getBoundingClientRect().top - last };
    });
    // The box grows (a larger text size, a phone's own settings): the room grows with it.
    await page.evaluate(() => { for (const box of document.querySelectorAll(".lx-ask")) box.style.setProperty("min-height", "180px"); });
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lx-ask-h")) >= 180);
    const grown = await measure();
    assert.ok(grown.room >= grown.ask, `${view}: the room at the end (${grown.room}px) is at least the box (${grown.ask}px)`);
    assert.ok(grown.clear >= 0, `${view}: at the end, the last line is above the box`);
  }
});

// Redesign: replaced by the new window (the prototype has no Trunks strip).
test.skip("12. with the strip switched off, a browser that knew so never gives the strip room, even before the first answer", async (t) => {
  const { page, server } = await fixture(t);
  const post = (path, body) => page.evaluate(async ([path, body, token]) => (await fetch(path, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body, server.token]);
  await post("/api/shell-look", { strip: "off" });
  await page.reload();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken (ci-flakes-3).
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => localStorage.getItem("branch-strip") === "off");
  // Next time the window opens, anything that gives the strip room is written down as it happens.
  await page.addInitScript(() => {
    globalThis.__stripSeen = [];
    new MutationObserver(() => {
      if (document.getElementById("trunk-strip") || document.body?.classList.contains("lx-strip")) globalThis.__stripSeen.push(performance.now());
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
  });
  await page.reload();
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken (ci-flakes-3).
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForTimeout(500);
  assert.deepEqual(await page.evaluate(() => globalThis.__stripSeen), [], "the strip's room was never taken");
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("8. switched to French, the window asks for the achievements in French and shows them so", async (t) => {
  const { page, server } = await fixture(t);
  await page.evaluate(async (token) => {
    await fetch("/api/delight/settings", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ achievements: { on: true } }) });
    await globalThis.branchDelight.reload();
  }, server.token);
  const asked = [];
  page.on("request", (request) => { if (request.url().includes("/api/delight/achievements")) asked.push(new URL(request.url()).search); });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.evaluate(async () => { const { openSheet } = await import("/delight-achievements.js"); await openSheet(); });
  const sheet = page.locator("#ach-sheet");
  await sheet.getByText("Pousse", { exact: true }).waitFor();
  assert.ok(asked.includes("?lang=fr"), asked.join(" "));
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("18. in French, Settings search names a setting whose control is not drawn yet in French too", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  const picked = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const { fromEnglish } = await import("/i18n.js");
    const row = SETTINGS_INDEX.find((r) => !document.getElementById(r[0]) && fromEnglish(r[3]) && fromEnglish(r[3]) !== r[3]
      && fromEnglish(r[3]).length > 12);
    return row ? { id: row[0], english: row[3], french: fromEnglish(row[3]) } : null;
  });
  assert.ok(picked, "a setting that is not drawn yet and has French words");
  await openSettings(page, "general");
  await page.locator("#lx-settings-search").fill(picked.french);
  const row = page.locator(`#sg-found [data-setting="${picked.id}"] b`);
  await row.waitFor();
  assert.equal(await row.textContent(), picked.french, `${picked.id} is named in French, not "${picked.english}"`);
  assert.deepEqual(errors, []);
});

/* Redesign: a Trunk's message waiting on the owner is a row of the prototype's Inbox › Needs you
   (public/app/places/inbox.js messageRow): the message, which Trunk to which, "Don’t" and "Allow" (data-act="tmsg"). */
test("2 (new window). a Trunk's message waiting on the owner is in Inbox › Needs you: which Trunks, the message, Allow and Don't", async (t) => {
  let ann, ben;
  const { app, page, errors } = await newWindow(t, (app) => {
    for (const part of ["trunks", "messages"]) app.trunks.setMode(part, { mode: "on" });
    ann = app.trunks.create({ name: "Ann" }); ben = app.trunks.create({ name: "Ben" });
    const now = new Date().toISOString();
    app.store.save("settings", app.runtime.owner, "trunk-receipts", { items: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", kind: "message",
      from: ann.id, to: ben.id, sessionId: ben.chatSessionId, prompt: "Message from Ann (@ann):\nCan you check the invoice?", status: "waiting",
      depth: 1, attempts: 1, runId: null, fromRunId: null, reply: null, error: null, at: now, updatedAt: now }] });
  });
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  const row = page.locator("#main .prow").filter({ has: page.locator('[data-act="tmsg"]') });
  await row.waitFor({ timeout: 30000 });
  assert.match(await row.innerText(), /Ann → Ben/, "which Trunk, whose message");
  assert.match(await row.innerText(), /Can you check the invoice\?/);
  await row.locator('[data-act="tmsg"][data-v="answer"]').click();
  for (let i = 0; i < 100 && !app.trunks.messages.waiting()[0]?.armed; i++) await page.waitForTimeout(100);
  assert.equal(app.trunks.messages.waiting()[0].armed, true, "the route was told");
  await page.locator("#main .prow").filter({ has: page.locator('[data-act="tmsg"]') }).locator('[data-act="tmsg"][data-v="decline"]').click();
  await page.locator('#main [data-act="tmsg"]').first().waitFor({ state: "detached", timeout: 10000 });
  assert.deepEqual(app.trunks.messages.waiting(), [], "ended; the sender is told (tests/residuals.test.mjs 2)");
  assert.equal(app.trunks.messages.receipts(ben.id).find((r) => r.kind === "message").status, "failed");
  assert.deepEqual(errors, []);
});
async function newWindow(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  before?.(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

// Redesign: replaced by the new window (Inbox › Needs you, checked above; the prototype's row has Allow and Don’t).
test.skip("2 (integration). a Trunk's message waiting on the owner has a card: which Trunk, whose message, Answer and Not now", async (t) => {
  let ann, ben;
  const { app, page } = await fixture(t, { before: async (_page, app) => {
    for (const part of ["trunks", "messages"]) app.trunks.setMode(part, { mode: "on" });
    ann = app.trunks.create({ name: "Ann" }); ben = app.trunks.create({ name: "Ben" });
    const now = new Date().toISOString();
    app.store.save("settings", app.runtime.owner, "trunk-receipts", { items: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", kind: "message",
      from: ann.id, to: ben.id, sessionId: ben.chatSessionId, prompt: "Message from Ann (@ann):\nCan you check the invoice?", status: "waiting",
      depth: 1, attempts: 1, runId: null, fromRunId: null, reply: null, error: null, at: now, updatedAt: now }] });
  } });
  const row = page.locator('#attention [data-waiting-message]');
  await row.waitFor({ timeout: 30000 });
  assert.match(await row.innerText(), /Ben is waiting for your answer/);
  assert.match(await row.innerText(), /About Ann's message: “Can you check the invoice\?”/);
  await row.getByRole("button", { name: "Answer", exact: true }).click();
  await row.getByText(/Your next message in that conversation answers Ann's message/).waitFor({ timeout: 10000 });
  assert.equal(app.trunks.messages.waiting()[0].armed, true, "the route was told");
  await page.locator('#attention [data-waiting-message]').getByRole("button", { name: "Not now" }).click();
  await row.waitFor({ state: "detached", timeout: 10000 });
  assert.deepEqual(app.trunks.messages.waiting(), [], "ended; the sender is told (tests/residuals.test.mjs 2)");
  assert.equal(app.trunks.messages.receipts(ben.id).find((r) => r.kind === "message").status, "failed");
});

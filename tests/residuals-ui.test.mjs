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
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page, app);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  return { app, server, page, errors, browser };
}

test("5. the fallback list warns when a Codex program is in it next to a ChatGPT sign-in", async (t) => {
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

test("14. Read aloud on a reply really plays: a blob: sound, no content-rule refusal, played to the end", async (t) => {
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

test("7. the mode menu and the usage list are as opaque as the glass dropdown", async (t) => {
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

test("11. Overview and People keep room at their end as tall as the floating ask box", async (t) => {
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

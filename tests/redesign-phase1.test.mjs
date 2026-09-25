/* Redesign phase 1: the pieces of the approved sample the owner loved most, built into the real window.
   Slate by default, the usage ring and its popover, the save-progress prompt, the suggestion bars and
   update cards, the permission-mode chip, and the glass dropdown with its tooltips. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { crossingsOf, shareLeft, tightestOf } from "../dist/usage-glance.js";

async function fixture(t, { provider, onboarded = true, width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-1-"));
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
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
    await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  };
  await open();
  return { page, server, call, errors, app, open, context };
}

/* ---------------------------------------------------------------- 3. Slate by default */

test("a new window wears Slate, and a picked Forest is remembered over the new default", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "slate");
  assert.equal((await f.call("/api/look")).theme, "slate", "the shared record starts on Slate too");
  await f.page.evaluate(() => document.querySelector('.lx-quick[aria-label="Forest theme"]')?.click()
    ?? document.querySelector('#lx-theme-gallery .lx-tile[data-family="forest"]')?.click());
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  assert.equal(await f.page.evaluate(() => localStorage.getItem("branch-palette")), "forest", "Forest is written down, not left as the default");
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "forest");
  assert.deepEqual(f.errors, []);
});

test("a Forest the workspace wrote down before Slate became the default is kept, not replaced", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => localStorage.getItem("branch-palette")), null, "nothing chosen, nothing written");
  // What an older copy left behind: the choice in the shared record, nothing in this browser.
  await f.call("/api/look", { theme: "forest", changedBy: "window" });
  await f.page.reload();
  await f.page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  assert.equal(await f.page.evaluate(() => localStorage.getItem("branch-palette")), "forest");
  assert.equal((await f.call("/api/look")).theme, "forest");
  assert.deepEqual(f.errors, []);
});

test("dark mode is its own setting and does not move with the new default palette", async () => {
  const { PreferencesSchema } = await import("../dist/preferences.js");
  assert.equal(PreferencesSchema.parse({}).appearance, "forest", "the stored light-or-dark choice still means dark");
});

/* ---------------------------------------------------------------- 1. the usage ring and the question at 95% */

const win = (over) => ({ id: "requests", title: "Requests", kind: "requests", limit: 100, remaining: 50, resetAt: null,
  measuredAt: "2026-09-19T10:00:00.000Z", state: "measured", from: "from the headers", ...over });
const row = (over) => ({ connection: "a", connectionName: "Alpha", account: null, accountLabel: null, inUse: true,
  state: "measured", windows: [win()], note: "", ...over });

test("the ring picks the connection with the least left, and never makes a share out of money or silence", () => {
  assert.equal(shareLeft(win({ kind: "money", limit: 40, remaining: 1 })), null, "money is never a share");
  assert.equal(shareLeft(win({ remaining: null })), null, "a remainder nobody gave is not a share");
  assert.equal(shareLeft(win({ limit: null })), null);
  const rows = [row(), row({ connection: "b", connectionName: "Beta", windows: [win({ remaining: 12, resetAt: "2026-09-19T18:00:00.000Z" })] }),
    row({ connection: "c", connectionName: "Cash", windows: [win({ kind: "money", limit: 40, remaining: 0 })] })];
  const tight = tightestOf(rows);
  assert.equal(tight.connectionName, "Beta");
  assert.equal(tight.percentLeft, 12);
  assert.equal(tight.resetAt, "2026-09-19T18:00:00.000Z");
  assert.equal(tightestOf([row({ windows: [], state: "not_published" })]), null, "nothing reported, nothing drawn");
  assert.equal(tightestOf([row({ windows: [win({ remaining: 46, limit: 1000 })] })]).percentLeft, 4, "4.6% left reads as 4, never 5");
});

test("the question at 95% is only for measured windows, and is keyed by the window so it asks once", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const at = (remaining, over = {}) => crossingsOf([row({ windows: [win({ remaining, ...over })] })], now);
  assert.equal(at(6).length, 0, "94% used does not ask");
  assert.equal(at(5).length, 1, "95% used asks");
  assert.equal(at(5)[0].percentUsed, 95);
  assert.equal(at(1, { state: "estimated" }).length, 0, "an estimate never asks");
  assert.equal(at(1, { kind: "money", limit: 40 }).length, 0, "money never asks");
  assert.notEqual(at(1, { resetAt: "2026-09-19T13:00:00.000Z" })[0].key, at(1, { resetAt: "2026-09-19T18:00:00.000Z" })[0].key,
    "a new window is a new question");
  assert.equal(at(1)[0].key, at(2)[0].key, "the same window stays one question as it fills");
});

/** Makes the first connection say, on a header, that it has `remaining` of 100 requests left. */
function reportLeft(app, remaining) {
  const preset = [...app.runtime.models.presets.keys()][0];
  app.runtime.models.health.recordSuccess(preset, 50, new Headers({
    "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": String(remaining), "x-ratelimit-reset-requests": "2h0m0s",
  }));
  return app.runtime.models.presets.get(preset).name;
}
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (String(asked).includes("Downloads")) await gate;
      return { content: "Done.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}
const refreshRing = (page) => page.evaluate(() => globalThis.branchUsageGlance.refresh());
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the ring shows the tightest connection, opens the glass list on click and closes on the same click", async (t) => {
  const f = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const name = reportLeft(f.app, 12);
  await refreshRing(f.page);
  const ring = f.page.locator("#usage-ring");
  await ring.waitFor({ state: "visible" });
  assert.match(await ring.innerText(), new RegExp(`${escape(name)}.*12% left`));
  assert.equal(await ring.getAttribute("data-low"), "true", "under 15% the ring warns");
  await ring.click();
  const pop = f.page.locator("#usage-pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /What each connection has left[\s\S]*Measured[\s\S]*12% left/);
  assert.equal(await f.page.locator("#usage-pop .glance-bar i").first().evaluate((node) => node.style.width), "12%");
  await ring.click();
  await pop.waitFor({ state: "hidden" });
  assert.equal(await ring.getAttribute("aria-expanded"), "false");
  await ring.click();
  await f.page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("dogfood B24: the computer chip's line fits whole, and a ring with nothing reported says what it is", async (t) => {
  for (const width of [1440, 1024]) {
    const f = await fixture(t, { width });
    const line = f.page.locator("#app-switcher .rail-target small");
    assert.match(await line.innerText(), /^You are here · Online$/);
    // Measured unrounded: the old words were 177.4px in a 177px box, enough for an ellipsis that whole pixels hide.
    const fit = await line.evaluate((node) => { const words = document.createRange(); words.selectNodeContents(node);
      return { words: words.getBoundingClientRect().width, room: node.getBoundingClientRect().width }; });
    assert.ok(fit.words <= fit.room + 0.01, `the line is not cut at ${width}px (${fit.words} in ${fit.room})`);
    await refreshRing(f.page);
    const ring = f.page.locator("#usage-ring");
    await ring.waitFor({ state: "visible" });
    assert.equal(await ring.innerText(), "Usage limits: none reported yet", "the words say what the ring is about");
    assert.deepEqual(f.errors, []);
  }
});

test("the ring can be hidden in Settings, and nobody but the owner ever sees it", async (t) => {
  const f = await fixture(t);
  await refreshRing(f.page);
  await f.page.locator("#usage-ring").waitFor({ state: "visible" });
  assert.equal((await f.call("/api/usage/glance/settings", { ring: "hidden" })).settings.ring, "hidden");
  await refreshRing(f.page);
  await f.page.locator("#status-bar").waitFor({ state: "hidden" });
  await f.call("/api/usage/glance/settings", { ring: "shown" });
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const seen = await fetch(new URL("/api/usage/glance", f.server.url), { headers: { authorization: `Bearer ${f.server.token}` } });
  assert.equal(seen.status, 200, "not an error");
  assert.deepEqual(await seen.json(), { available: false }, "and not a number");
  await refreshRing(f.page);
  await f.page.locator("#status-bar").waitFor({ state: "hidden" });
  f.app.store.profiles.switch({ profileId: null });
  assert.deepEqual(f.errors, []);
});

async function runningTask(f) {
  void f.call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  let run;
  for (let tries = 0; tries < 200 && !run; tries += 1) {
    run = (await f.call("/api/state")).runs.find((one) => one.status === "running");
    if (!run) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(run, "the task is running");
  return run;
}

test("at 95% used it asks once; Save progress steers every running task to write down where it is", async (t) => {
  const model = slowModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider });
  const name = reportLeft(f.app, 3);
  const run = await runningTask(f);
  await refreshRing(f.page);
  const box = f.page.locator("#save-progress");
  await box.waitFor({ state: "visible" });
  assert.match(await box.innerText(), new RegExp(`Almost out on ${escape(name)}\\. Ask running tasks to save their progress\\?`));
  assert.equal(await box.getAttribute("role"), "alertdialog");
  await box.getByRole("button", { name: "Save progress" }).click();
  await f.page.locator("#toast").filter({ hasText: "Asked the running task to write down where it is" }).waitFor();
  const events = (await f.call(`/api/runs/${run.id}`)).events;
  const steered = events.find((event) => event.kind === "run.steered");
  assert.ok(steered, "the task was steered through the ordinary channel");
  assert.match(steered.data.note, /checkpoint note/);
  assert.equal(events.some((event) => /cancel|paused/.test(event.kind)), false, "nothing was paused or stopped");
  await refreshRing(f.page);
  await f.page.waitForTimeout(300);
  assert.equal(await box.count(), 0, "the same window is never asked about twice");
  model.release();
  assert.deepEqual(f.errors, []);
});

test("with saving progress off, or nothing running, it never asks; Not now changes nothing", async (t) => {
  const model = slowModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider });
  reportLeft(f.app, 1);
  await refreshRing(f.page);
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator("#save-progress").count(), 0, "nothing running, nothing to ask");
  const run = await runningTask(f);
  await f.call("/api/usage/glance/settings", { saveProgress: "off" });
  await refreshRing(f.page);
  await f.page.waitForTimeout(300);
  assert.equal(await f.page.locator("#save-progress").count(), 0, "switched off, it never asks");
  await f.call("/api/usage/glance/settings", { saveProgress: "ask" });
  await refreshRing(f.page);
  await f.page.locator("#save-progress").getByRole("button", { name: "Not now" }).click();
  await f.page.locator("#save-progress").waitFor({ state: "detached" });
  assert.equal((await f.call(`/api/runs/${run.id}`)).events.some((event) => event.kind === "run.steered"), false, "Not now sends nothing");
  model.release();
  assert.deepEqual(f.errors, []);
});

test("saving progress and the ring's settings are the owner's alone", async (t) => {
  const f = await fixture(t);
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  for (const [path, body] of [["/api/usage/save-progress", {}], ["/api/usage/glance/settings", { ring: "hidden" }]]) {
    const response = await fetch(new URL(path, f.server.url), { method: "POST",
      headers: { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok([400, 403].includes(response.status), `${path} is refused (${response.status})`);
  }
  f.app.store.profiles.switch({ profileId: null });
  assert.equal((await f.call("/api/usage/glance/settings")).settings.ring, "shown");
});

/* ---------------------------------------------------------------- integration review */

test("integration review: the ring's list never covers the message box on a phone or a short laptop screen", async (t) => {
  for (const [width, height] of [[390, 844], [1024, 700]]) {
    const f = await fixture(t, { width, height, provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
    reportLeft(f.app, 12);
    await refreshRing(f.page);
    await f.page.locator("#usage-ring").click();
    await f.page.locator("#usage-pop").waitFor({ state: "visible" });
    const boxes = await f.page.evaluate(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      const pop = box("usage-pop"), field = box("prompt");
      return { overlaps: pop.left < field.right && pop.right > field.left && pop.top < field.bottom && pop.bottom > field.top,
        inside: pop.top >= 0 && pop.bottom <= innerHeight };
    });
    assert.equal(boxes.overlaps, false, `the list leaves the text field clear at ${width}x${height}`);
    assert.equal(boxes.inside, true, `and stays on screen at ${width}x${height}`);
    assert.deepEqual(f.errors, []);
  }
});

test("integration review: the summary under the list says one connection and several in plain words", async () => {
  const { limitsSummary } = await import("../dist/usage-limits.js");
  assert.equal(limitsSummary(1, 1), "Your one connection reports a limit.");
  assert.equal(limitsSummary(0, 1), "Your one connection does not publish a limit.");
  assert.equal(limitsSummary(1, 3), "1 of 3 connections reports a limit. The other 2 do not publish one.");
  assert.equal(limitsSummary(2, 3), "2 of 3 connections report a limit. The other one does not publish one.");
  assert.equal(limitsSummary(0, 0), "No model connection is set up yet.");
});

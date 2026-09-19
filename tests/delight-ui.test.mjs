/* phase2/delight in the window: the acorn's corner, the pet, achievements and your own background.
   Everything ships off; each is switched on here with a real click in Settings › Appearance. Headless
   only, against 127.0.0.1. */
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

/** A model that answers at once, or waits for `release()` when asked to sort the Downloads folder. */
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { release: () => release(), provider: { name: "scripted", async complete(request) {
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (String(asked).includes("Downloads")) await gate;
    return { content: "Done.", toolCalls: [] };
  } } };
}
async function fixture(t, { width = 1440, height = 950, reducedMotion = "no-preference" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-delight-ui-"));
  const model = slowModel();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { model.release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|Content Security Policy/.test(message.text())) errors.push(message.text()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { app, server, call, page, errors, model };
}
/** Turns a switch on the way a person does: Settings › Appearance, a real click, then back. */
async function switchOn(page, id) {
  await openSettingFor(page, `#${id}`);
  await page.locator(`#${id}`).check();
  await closeSettings(page);
}

test("off by default: no pet, no own background, the acorn hidden, and the three cards waiting in Appearance", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.locator("#pet").count(), 0);
  assert.equal(await f.page.locator("#delight-wall").count(), 0);
  assert.equal(await f.page.locator("#delight-corner").isVisible(), false, "the corner is empty and takes no room");
  await openSettingFor(f.page, "#delight-pet-on");
  for (const id of ["delight-pet-on", "delight-ach-on", "delight-bg-on"]) {
    assert.equal(await f.page.locator(`#${id}`).isVisible(), true, id);
    assert.equal(await f.page.locator(`#${id}`).isChecked(), false, `${id} ships off`);
  }
  assert.equal(await f.page.locator("#delight-pet-more").isVisible(), false, "the pet's own choices wait until it is on");
  assert.deepEqual(f.errors, []);
});

test("the acorn sits in the rail's corner without a caption, and its pause is an icon with a name", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "appearance-acorn");
  const corner = await f.page.locator("#delight-corner").boundingBox(), rail = await f.page.locator("#conversation-rail").boundingBox();
  const foot = await f.page.locator(".rail-foot").boundingBox();
  assert.ok(corner.y + corner.height <= foot.y + 1 && corner.x >= rail.x, "just above the rail's foot, inside the rail");
  assert.equal(await f.page.locator("#acorn-hint").count(), 0, "no DRAG THE ACORN caption");
  assert.equal(await f.page.locator("#keepoak-acorn").getAttribute("title"), "Drag to turn");
  assert.equal((await f.page.locator("#delight-corner").innerText()).trim(), "", "no words under the acorn");
  await f.page.getByRole("button", { name: "Pause rotation", exact: true }).click();
  await f.page.getByRole("button", { name: "Resume rotation", exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});

test("the pet lives in the corner, works while a task works, and says one thing at a time, inside the rail", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-pet-on");
  await f.page.locator("#pet").waitFor();
  assert.match(await f.page.locator("#pet").getAttribute("aria-label"), /Hazel the squirrel/);
  void f.call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  await f.page.locator("#pet-say:not([hidden])").waitFor({ timeout: 15000 });
  assert.equal(await f.page.locator("#pet-say").innerText(), "Working on it…");
  let most = 0;
  for (let i = 0; i < 8; i++) {
    most = Math.max(most, await f.page.locator(".pet-say:not([hidden])").count());
    await f.page.waitForTimeout(150);
  }
  assert.equal(most, 1, "never two bubbles");
  const bubble = await f.page.locator("#pet-say").boundingBox(), rail = await f.page.locator("#conversation-rail").boundingBox();
  assert.ok(bubble.x >= rail.x && bubble.x + bubble.width <= rail.x + rail.width + 0.5, "the bubble is never cut off by the rail's edge");
  const text = await f.page.locator("#pet-say").innerText();
  await f.page.waitForTimeout(1200);
  assert.equal(await f.page.locator("#pet-say").innerText(), text, "the words do not flicker while they are shown");
  f.model.release();
  await f.page.waitForFunction(() => document.getElementById("pet-say")?.textContent !== "Working on it…", null, { timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

test("the pet's own menu opens on right-click, never the browser's, and can hide it", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-pet-on");
  await f.page.locator("#pet").click({ button: "right" });
  await f.page.getByRole("menuitem", { name: "Hide the pet" }).click();
  await f.page.locator("#pet").waitFor({ state: "detached" });
  assert.equal((await f.call("/api/delight")).settings.pets.on, false);
  assert.deepEqual(f.errors, []);
});

test("achievements: what a real task earns arrives as a seven-second note, once; Gold and above get a card", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-ach-on");
  await f.app.runtime.run({ prompt: "one" });
  await f.page.evaluate(() => globalThis.branchAchievements.check());
  await f.page.locator("#ach-note").waitFor({ timeout: 10000 });
  assert.match(await f.page.locator("#ach-note").innerText(), /achievement/);
  let fresh = ["waiting"];
  for (let i = 0; i < 20 && fresh.length; i++) { fresh = (await f.call("/api/delight/achievements")).fresh; await f.page.waitForTimeout(100); }
  assert.deepEqual(fresh, [], "once shown, it is not shown again");
  const sprout = (await f.call("/api/delight/achievements")).list.find((a) => a.id === "tasks:1");
  assert.ok(sprout.got, "the finished task earned Sprout");
  await f.page.evaluate(() => globalThis.branchAchievements.preview("Diamond"));
  await f.page.locator(".ach-party .ach-card").waitFor();
  assert.ok(await f.page.locator(".ach-party .bit").count() >= 32, "the party grows with the rank");
  const card = await f.page.locator(".ach-card").boundingBox(), box = await f.page.locator("#prompt").boundingBox();
  assert.ok(card.y + card.height <= box.y || card.y >= box.y + box.height, "the card never covers the message box");
  await f.page.getByRole("button", { name: "Lovely" }).click();
  assert.equal(await f.page.locator(".ach-party").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("Keep things still shows the card without falling leaves", async (t) => {
  const f = await fixture(t, { reducedMotion: "reduce" });
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await f.page.evaluate(() => globalThis.branchAchievements.preview("Godly"));
  await f.page.locator(".ach-party.still .ach-card").waitFor();
  assert.equal(await f.page.locator(".ach-party .bit").count(), 0);
  assert.equal(await f.page.locator(".ach-party .rays").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("the achievements sheet lists all 505 and keeps the high ones secret", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await f.page.evaluate(() => globalThis.branchAchievements.openSheet());
  await f.page.locator("#ach-sheet").waitFor();
  assert.match(await f.page.locator("#ach-sheet-count").innerText(), /of 505/);
  await f.page.getByRole("button", { name: "Godly", exact: true }).click();
  assert.equal(await f.page.locator("#ach-sheet .ach").count(), 60, "the first sixty, then Show all");
  assert.equal(await f.page.locator("#ach-sheet .ach.blank").count(), 60, "Godly ones are blank until earned");
  await f.page.keyboard.press("Escape");
  assert.equal(await f.page.locator("#ach-sheet").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("your own background: kept in the window, behind a scrim, refused when too big, gone when off", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-bg-on");
  await openSettingFor(f.page, "#delight-bg-file");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMAAAAwGAQFm2g5eAAAAAElFTkSuQmCC", "base64");
  await f.page.locator("#delight-bg-file").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: png });
  await f.page.locator("#delight-wall img").waitFor({ state: "attached" });
  assert.equal(await f.page.locator("#delight-wall .delight-scrim").evaluate((n) => getComputedStyle(n).opacity), "0.6");
  assert.equal(await f.page.locator("#delight-bg-name").innerText(), "tiny.png");
  const big = Buffer.alloc(9 * 1024 * 1024);
  await f.page.locator("#delight-bg-file").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: big });
  await f.page.getByText(/Keep it under 8 MB for a picture/).waitFor();
  assert.equal(await f.page.locator("#delight-bg-name").innerText(), "tiny.png", "the big file was not kept");
  await f.page.locator("#delight-bg-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await f.page.getByText(/can't go behind the glass/).waitFor();
  await f.page.locator("#delight-bg-on").uncheck();
  await f.page.locator("#delight-wall").waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

test("at phone width the corner stays inside the folded rail and nothing scrolls sideways", async (t) => {
  const f = await fixture(t, { width: 390, height: 844 });
  await f.call("/api/delight/settings", { pets: { on: true } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await f.page.locator("#rail-toggle").click();
  await f.page.locator("#pet").waitFor();
  const pet = await f.page.locator("#pet").boundingBox(), rail = await f.page.locator("#conversation-rail").boundingBox();
  assert.ok(pet.x >= rail.x && pet.x + pet.width <= rail.x + rail.width + 0.5);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(f.errors, []);
});

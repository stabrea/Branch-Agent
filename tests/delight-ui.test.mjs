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
async function fixture(t, { width = 1440, height = 950, reducedMotion = "no-preference", init } = {}) {
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
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|Content Security Policy/.test(message.text())) errors.push(message.text()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { app, server, call, page, errors, model };
}
/** Turns a switch on the way a person does: Settings › Appearance, a real click, then back. */
async function switchOn(page, id) {
  await openSettingFor(page, `#${id}`);
  await page.locator(`#${id}`).check();
  await closeSettings(page);
}

/**
 * Notes every timer and animation frame asked for by a delight file, before the page's own scripts run,
 * and every request for the work (activity, achievements, noticed) a delight file makes: the window's own
 * panes ask for /api/activity too, every few seconds, so a request is delight's only when a delight file made it.
 */
function watchTimers() {
  const asked = (globalThis.__delightTimers = []);
  const fetched = (globalThis.__delightFetches = []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, ...rest) {
    const from = (new Error().stack ?? "").split(/\r?\n/).slice(2).find((line) => /delight/.test(line));
    const url = String(input?.url ?? input);
    // Its own switch (/api/delight) is read at start; what it must not ask for while off is the work.
    if (from && /\/api\/(activity|delight\/(achievements|noticed))/.test(url)) fetched.push(`${url} ${from.trim()}`);
    return realFetch.call(this, input, ...rest);
  };
  for (const name of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
    const real = globalThis[name];
    globalThis[name] = function (...args) {
      const from = (new Error().stack ?? "").split(/\r?\n/).slice(2).find((line) => /delight/.test(line));
      if (from) asked.push(`${name} ${from.trim()}`);
      return real.apply(this, args);
    };
  }
}
test("off by default: no pet, no own background, the acorn hidden, and the three cards waiting in Appearance", async (t) => {
  const f = await fixture(t, { init: watchTimers });
  const asked = [];
  f.page.on("request", (request) => { if (/\/api\/delight\/(achievements|noticed)/.test(request.url())) asked.push(request.url()); });
  await f.call("/api/run", { prompt: "one" });
  await f.page.waitForTimeout(2500);
  assert.deepEqual(await f.page.evaluate(() => globalThis.__delightTimers), [], "switched off, nothing of delight's ticks");
  assert.deepEqual(asked, [], "and nothing is asked of the server");
  assert.deepEqual(await f.page.evaluate(() => globalThis.__delightFetches), [], "not even what the window asks for anyway (activity)");
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
  // integration review: the owner's dithered acorn (#26, #57), drawn a pixel per screen pixel as in the sample.
  const art = await f.page.locator("#keepoak-acorn").evaluate((canvas) => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const drawn = (x, y) => data[(y * canvas.width + x) * 4 + 3] > 0;
    let holes = 0, ink = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 1; x < canvas.width - 1; x++) {
      if (drawn(x, y)) ink++;
      else if (drawn(x - 1, y) && drawn(x + 1, y)) holes++;
    }
    return { width: canvas.width, css: Math.round(canvas.getBoundingClientRect().width), pixelated: getComputedStyle(canvas).imageRendering, holes, ink };
  });
  assert.equal(art.width, art.css, "one pixel of the acorn per screen pixel, like the sample's corner tile");
  assert.equal(art.pixelated, "pixelated");
  assert.ok(art.ink > 150 && art.holes > 20, `the acorn is dithered, not a plain shape (${art.ink} lit, ${art.holes} dither holes)`);
  await f.page.getByRole("button", { name: "Pause rotation", exact: true }).click();
  await f.page.getByRole("button", { name: "Resume rotation", exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});

test("the pet lives in the corner, works while a task works, and says one thing at a time, inside the rail", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-pet-on");
  await f.page.locator("#pet").waitFor();
  assert.match(await f.page.locator("#pet").getAttribute("aria-label"), /Hazel the squirrel/);
  /* ci-flakes-4: the bubble is up only for the words' reading time (3 s for these), so the watching is
     set up in the page before the task starts and reads it every 100 ms from the moment the words
     appear. Measuring over Playwright round trips read a bubble that had already had its time on a busy
     Windows machine (boundingBox was null). Everything it proved is still proved, on every reading
     rather than on two. On a slow machine the page is over 20 s old by now, so a tip (one at a time,
     up to 8 s) may be showing when the task starts; the pet says it is working once the tip has had its time. */
  const watching = f.page.evaluate(() => new Promise((resolve) => {
    let began = 0, most = 0;
    const words = new Set(), cutOff = [];
    const read = () => {
      const bubble = document.getElementById("pet-say"), rail = document.getElementById("conversation-rail");
      most = Math.max(most, document.querySelectorAll(".pet-say:not([hidden])").length);
      if (bubble && !bubble.hidden && rail) {
        if (!began && bubble.textContent === "Working on it…") began = Date.now();
        if (began) {
          words.add(bubble.textContent);
          const box = bubble.getBoundingClientRect(), edge = rail.getBoundingClientRect();
          if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) cutOff.push([box.left - edge.left, box.right - edge.right]);
        }
      }
      if (began && Date.now() - began >= 1200) done();
    };
    const done = () => { clearInterval(timer); resolve({ began: began > 0, most, words: [...words], cutOff }); };
    const timer = setInterval(read, 100);
    setTimeout(done, 40000);
  }));
  void f.call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  const watched = await watching;
  assert.equal(watched.began, true, "the pet says 'Working on it…' while a task works");
  assert.equal(watched.most, 1, "never two bubbles");
  assert.deepEqual(watched.words, ["Working on it…"], "the words do not flicker while they are shown");
  assert.deepEqual(watched.cutOff, [], "the bubble is never cut off by the rail's edge");
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
  /* Its words, not how they are drawn: DG-014 sets the tier eyebrow in capitals. */
  assert.match(await f.page.locator("#ach-note").textContent(), /achievement/);
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

test("tips get scarcer as the rank rises: Bronze every few minutes, Silver hourly, Gold and up never", async (t) => {
  const f = await fixture(t);
  const gaps = await f.page.evaluate(async () => {
    const { state } = await import("/delight-kit.js");
    const { tipGap } = await import("/delight-pet.js");
    return ["Bronze", "Silver", "Gold", "Diamond", "Godly"].map((rank) => { state.rank = rank; return tipGap(); });
  });
  assert.deepEqual(gaps, [180000, 3600000, Infinity, Infinity, Infinity]);
  assert.deepEqual(f.errors, []);
});

/** The smallest .glb there is: one triangle, no normals, one base colour. */
function tinyGlb() {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [2, 2, 0] }],
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
  jsonHead.writeUInt32LE(padded.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return [...Buffer.concat([header, jsonHead, padded, binHead, bin])];
}

test("3D: the acorn and the pet turn in 3D when chosen, and a .glb of your own is read or refused in plain words", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { pets: { on: true }, look: { style: "3d" } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await switchOn(f.page, "appearance-acorn");
  await f.page.locator("#acorn-3d").waitFor();
  await f.page.locator("#pet .pet-3d").waitFor();
  assert.equal(await f.page.locator("#keepoak-acorn").isVisible(), false, "the pixel acorn steps aside");
  const drawn = await f.page.locator("#acorn-3d").evaluate((canvas) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d");
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, copy.width, copy.height).data.some((value, i) => i % 4 === 3 && value > 0);
  });
  assert.equal(drawn, true, "the 3D acorn is really drawn");
  const read = await f.page.evaluate(async (bytes) => {
    const { readGlb } = await import("/delight-3d.js");
    const parts = readGlb(new Uint8Array(bytes).buffer);
    let refused = "";
    try { readGlb(new Uint8Array(40).buffer); } catch (error) { refused = error.message; }
    return { count: parts.length, color: parts[0].color, x: Math.max(...parts[0].positions.filter((_, i) => i % 3 === 0)), refused };
  }, tinyGlb());
  assert.equal(read.count, 1);
  assert.deepEqual(read.color, [1, 0, 0]);
  assert.ok(Math.abs(read.x - 0.95) < 0.01, "moved to the middle and sized to fit, whatever its own units");
  assert.equal(read.refused, "That is not a .glb 3D model.");
  await f.call("/api/delight/settings", { look: { style: "pixel" } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await f.page.locator("#acorn-3d").waitFor({ state: "detached" });
  assert.equal(await f.page.locator("#keepoak-acorn").isVisible(), true, "pixel is back");
  assert.deepEqual(f.errors, []);
});

/* ---------- integration review: untrusted .glb files, storage, and what the window reports ---------- */

test(".glb files from anywhere: truncated, garbage, huge counts, loops and too much detail fail cleanly and fast", async (t) => {
  const f = await fixture(t);
  const result = await f.page.evaluate(async () => {
    const { readGlb, view3d, GlbError, GLB_LIMITS } = await import("/delight-3d.js");
    function glb(json, bin, version = 2) {
      const text = new TextEncoder().encode(JSON.stringify(json)), jl = (text.length + 3) & ~3, bl = (bin.byteLength + 3) & ~3;
      const out = new Uint8Array(28 + jl + bl), view = new DataView(out.buffer);
      view.setUint32(0, 0x46546c67, true); view.setUint32(4, version, true); view.setUint32(8, out.length, true);
      view.setUint32(12, jl, true); view.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(text, 20);
      view.setUint32(20 + jl, bl, true); view.setUint32(24 + jl, 0x004e4942, true); out.set(new Uint8Array(bin), 28 + jl);
      return out.buffer;
    }
    const model = (count, extra = {}) => ({
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: count * 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3" }], ...extra,
    });
    const corners = (count) => { const p = new Float32Array(count * 3); for (let i = 0; i < p.length; i++) p[i] = Math.sin(i * 12.9898) * 3; return p.buffer; };
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const outcome = (buffer) => {
      const began = performance.now();
      try { const parts = readGlb(buffer); return { ok: true, parts: parts.length, ms: performance.now() - began }; }
      catch (error) { return { ok: false, clean: error instanceof GlbError && error.key.startsWith("delight.glb."), key: error.key, what: String(error), ms: performance.now() - began }; }
    };
    const good = glb(model(3), corners(3));
    const cases = {};
    cases.truncated = Array.from({ length: good.byteLength }, (_, n) => outcome(good.slice(0, n)));
    cases.garbage = Array.from({ length: 150 }, () => {
      const bytes = new Uint8Array(20 + Math.floor(random() * 400)).map(() => Math.floor(random() * 256));
      new DataView(bytes.buffer).setUint32(0, 0x46546c67, true);
      if (random() < 0.5) new DataView(bytes.buffer).setUint32(4, 2, true);
      return outcome(bytes.buffer);
    });
    cases.flipped = Array.from({ length: 150 }, () => {
      const bytes = new Uint8Array(good.slice(0));
      bytes[Math.floor(random() * bytes.length)] ^= 1 << Math.floor(random() * 8);
      return outcome(bytes.buffer);
    });
    cases.hugeCount = outcome(glb(model(3, { accessors: [{ bufferView: 0, componentType: 5126, count: 2 ** 31, type: "VEC3" }] }), corners(3)));
    cases.hugeView = outcome(glb(model(3, { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 ** 32 }] }), corners(3)));
    const indexed = new ArrayBuffer(48);
    new Float32Array(indexed, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Uint32Array(indexed, 36, 3).set([0, 1, 99]);
    cases.badIndex = outcome(glb(model(3, {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" }],
    }), indexed));
    cases.loop = outcome(glb(model(3, { nodes: [{ mesh: 0, children: [1] }, { mesh: 0, children: [0, 1] }] }), corners(3)));
    const fan = Array.from({ length: 40 }, (_, i) => ({ mesh: 0, children: i < 39 ? Array(50).fill(i + 1) : [] }));
    cases.fan = outcome(glb(model(3, { nodes: fan }), corners(3)));
    const every = (n) => Array.from({ length: n }, (_, i) => i);
    cases.manyNodes = outcome(glb(model(3, { scenes: [{ nodes: every(5000) }], nodes: every(5000).map(() => ({ mesh: 0 })) }), corners(3)));
    cases.instances = outcome(glb(model(3000, { scenes: [{ nodes: every(200) }], nodes: every(200).map(() => ({ mesh: 0 })) }), corners(3000)));
    const notJson = new Uint8Array(glb(model(3), corners(3)));
    notJson[20] = 0x7b; notJson[21] = 0x7b;
    cases.notJson = outcome(notJson.buffer);
    cases.tooBig = outcome(new ArrayBuffer(GLB_LIMITS.bytes + 1));
    const big = readGlb(glb(model(150_000), corners(150_000)));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    let drawn = null;
    try { drawn = view3d(canvas, big, { still: () => true }) !== null; } catch (error) { drawn = String(error); }
    canvas.remove();
    return { cases, bigCorners: big.reduce((n, p) => n + p.positions.length / 3, 0), drawn };
  });
  const all = Object.values(result.cases).flat();
  for (const c of all) assert.ok(c.ok || c.clean, `refused in plain words, never a raw error: ${c.what}`);
  assert.ok(all.every((c) => c.ms < 1500), `each file is decided quickly (slowest ${Math.max(...all.map((c) => c.ms)).toFixed(0)} ms)`);
  assert.equal(result.cases.truncated.at(-1)?.ok, false, "a file one byte short is refused");
  assert.equal(result.cases.hugeCount.key, "delight.glb.broken");
  assert.equal(result.cases.hugeView.key, "delight.glb.broken");
  assert.equal(result.cases.badIndex.key, "delight.glb.broken");
  assert.equal(result.cases.loop.ok, true, "a node loop is walked once and ends");
  assert.equal(result.cases.loop.parts, 2);
  assert.equal(result.cases.fan.parts, 40, "a branch shared fifty times over is drawn once, not 50^40 times");
  assert.equal(result.cases.manyNodes.key, "delight.glb.tooDetailed");
  assert.equal(result.cases.instances.key, "delight.glb.tooDetailed", "one mesh placed 200 times counts 200 times toward the limit");
  assert.equal(result.cases.notJson.key, "delight.glb.broken");
  assert.equal(result.cases.tooBig.key, "delight.glb.tooBig");
  assert.equal(result.bigCorners, 150000);
  assert.equal(result.drawn, true, "a detailed model is drawn (its corners are copied, never spread into push)");
  assert.deepEqual(f.errors, []);
});

test("your own background: a full disk is said plainly; switching off keeps the file, Remove picture (after a yes) throws it away", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-bg-on");
  await openSettingFor(f.page, "#delight-bg-file");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMAAAAwGAQFm2g5eAAAAAElFTkSuQmCC", "base64");
  await f.page.evaluate(() => {
    const real = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    globalThis.__roomAgain = () => { IDBObjectStore.prototype.put = real; };
  });
  await f.page.locator("#delight-bg-file").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: png });
  await f.page.getByText("There is no room left in this window's storage for that file. Choose a smaller one.").waitFor();
  assert.equal(await f.page.locator("#delight-wall").count(), 0, "nothing half-kept is shown");
  await f.page.evaluate(() => globalThis.__roomAgain());
  await f.page.locator("#delight-bg-file").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: png });
  await f.page.locator("#delight-wall img").waitFor({ state: "attached" });
  const stored = () => f.page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === "branch-delight"));
  assert.equal(await stored(), true);
  // mac7/residuals: switched off it is taken down but kept; switched on again it is back.
  await f.page.locator("#delight-bg-on").uncheck();
  await f.page.locator("#delight-wall").waitFor({ state: "detached" });
  assert.equal(await stored(), true, "switching off keeps the file");
  assert.equal(await f.page.locator("#delight-bg-name").innerText(), "tiny.png");
  assert.equal(await f.page.locator("#delight-bg-remove").isVisible(), true, "Remove picture is there while switched off");
  await f.page.locator("#delight-bg-on").check();
  await f.page.locator("#delight-wall img").waitFor({ state: "attached" });
  // Remove picture asks first; No keeps it, Yes throws it away.
  f.page.once("dialog", (dialog) => void dialog.dismiss());
  await f.page.getByRole("button", { name: "Remove picture" }).click();
  await f.page.waitForTimeout(200);
  assert.equal(await stored(), true, "No keeps the file");
  f.page.once("dialog", (dialog) => { assert.match(dialog.message(), /cannot be brought back/); void dialog.accept(); });
  await f.page.getByRole("button", { name: "Remove picture" }).click();
  await f.page.locator("#delight-wall").waitFor({ state: "detached" });
  await f.page.waitForFunction(async () => !(await indexedDB.databases()).some((db) => db.name === "branch-delight"));
  await f.page.getByText("No file chosen yet.").waitFor();
  assert.deepEqual(f.errors, []);
});

test("following the computer's light or dark is noticed, and a flag is told once", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  const told = [];
  f.page.on("request", (request) => { if (request.url().endsWith("/api/delight/noticed")) told.push(request.postData() ?? ""); });
  await openSettingFor(f.page, "#lx-mode");
  const mode = (name) => f.page.locator("#lx-mode").getByRole("button", { name, exact: true }).click();
  await mode("Follow this computer");
  await mode("Moonlight");
  await mode("Follow this computer");
  await f.page.waitForTimeout(500);
  assert.equal(told.filter((body) => body.includes("follow-system")).length, 1);
  const view = await f.call("/api/delight/achievements");
  assert.ok(view.list.find((a) => a.id === "noticed:flag:follow-system:1").got, "Follow the sun can really be earned");
  assert.deepEqual(f.errors, []);
});

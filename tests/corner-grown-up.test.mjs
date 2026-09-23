/* DG-130: the rail's corner at the approved tile's size and spacing — a 58px acorn 18px in from the
   rail's edge with 12px above it and 8px below, and the pet 10px beside it at 60×54 — the same with
   Show everything on or off, dark or light, at 1440, 860 and 400 px, and in French. The pet's saved
   name is its tooltip and its name, never a caption squeezed into the corner. Headless, 127.0.0.1. */
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

const NAME = "Bartholomew Acornsby";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-corner-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/delight/settings", { pets: { on: true, name: NAME } });
  return { server, browser };
}
async function open(f, { width, scheme, everything }) {
  const page = await f.browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  await showEverything(page, { showEverything: everything, showAcorn: true });
  await page.waitForFunction(() => document.documentElement.dataset.acorn === "on");
  if (width < 700) await page.locator("#rail-toggle").click();
  await page.locator("#pet").waitFor();
  return { page, errors };
}
/** Every box the corner is measured by, relative to the rail's inner edge. */
const measure = (page) => page.evaluate(() => {
  const box = (selector) => document.querySelector(selector).getBoundingClientRect();
  const rail = box("#conversation-rail"), corner = box("#delight-corner"), acorn = box("#keepoak-acorn");
  const lane = box("#pet-lane"), pet = box("#pet"), foot = box(".rail-foot"), inner = corner.left;
  return {
    acorn: [acorn.width, acorn.height], backing: document.getElementById("keepoak-acorn").width,
    inset: acorn.left - inner, above: acorn.top - corner.top, below: corner.bottom - acorn.bottom,
    beside: lane.left - acorn.right, pet: [pet.width, pet.height], petBottom: pet.bottom - acorn.bottom,
    petInside: pet.left >= rail.left && pet.right <= rail.right + 0.5, onFoot: foot.top - corner.bottom,
    words: document.getElementById("delight-corner").innerText.trim(), sideways: document.documentElement.scrollWidth > innerWidth,
  };
});

test("the corner matches the approved tile at every width, in both lights, with Show everything on or off", { timeout: 360000 }, async (t) => {
  const f = await fixture(t);
  for (const width of [1440, 860, 400]) for (const [scheme, everything] of [["dark", false], ["light", true]]) {
    const { page, errors } = await open(f, { width, scheme, everything });
    const m = await measure(page), at = `${width}px ${scheme}${everything ? " everything" : ""}`;
    assert.deepEqual(m.acorn, [58, 58], `${at}: the acorn is 58px`);
    assert.equal(m.backing, 58, `${at}: drawn a pixel per screen pixel`);
    assert.deepEqual([m.inset, m.above, m.below, m.beside], [18, 12, 8, 10], `${at}: the tile's spacing`);
    assert.deepEqual(m.pet, [60, 54], `${at}: the pet is three times its pixels`);
    assert.ok(Math.abs(m.petBottom) <= 0.5, `${at}: the pet stands on the acorn's line`);
    assert.equal(m.petInside, true, `${at}: the pet is inside the rail`);
    assert.ok(Math.abs(m.onFoot) <= 0.5, `${at}: the corner sits on the rail's foot`);
    assert.equal(m.words, "", `${at}: no caption in the corner`);
    assert.equal(m.sideways, false, `${at}: nothing scrolls sideways`);
    assert.equal(await page.locator("#pet").getAttribute("title"), `${NAME} the squirrel. Press to pat.`, `${at}: the saved name, whole`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("in French the corner keeps its size and the pet keeps its saved name", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 400, scheme: "dark", everything: false });
  await openSettingFor(page, "#appearance-language");
  await page.locator("#appearance-language").selectOption("fr");
  await closeSettings(page);
  await page.waitForFunction((name) => document.getElementById("pet")?.title.startsWith(`${name}, `), NAME);
  if (!(await page.locator("#pet").isVisible())) await page.locator("#rail-toggle").click();
  const m = await measure(page);
  assert.deepEqual([m.acorn, m.inset, m.above, m.below, m.beside, m.pet], [[58, 58], 18, 12, 8, 10, [60, 54]]);
  assert.equal(m.words, "");
  assert.match(await page.locator("#pet").getAttribute("aria-label"), new RegExp(`^${NAME}, `));
  assert.deepEqual(errors, []);
});

/* DG-138: the 3D acorn and pets are the approved sample's shapes, drawn by the window's own WebGL. */
test("3D: the acorn and the pets are the sample's shapes, faceted where it is, in colours from the tokens", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 1440, scheme: "dark", everything: false });
  const shapes = await page.evaluate(async () => {
    const { acornModel, petModel } = await import("/delight-3d.js");
    const high = (part) => Math.max(...part.positions.filter((_, i) => i % 3 === 1));
    const acorn = acornModel(), squirrel = petModel("squirrel"), rabbit = petModel("rabbit"), snail = petModel("snail");
    document.documentElement.style.setProperty("--model-acorn-cap", "rgb(255, 0, 0)");
    const recoloured = acornModel()[1].color;
    document.documentElement.style.removeProperty("--model-acorn-cap");
    return {
      acorn: acorn.map((part) => [part.flat, part.indices.length]), capTop: high(acorn[1]), stemTop: high(acorn[2]),
      squirrel: squirrel.length, rabbitEar: high(rabbit[3]) - high(squirrel[3]), snail: snail.length, snailFlat: snail.at(-1).flat,
      owl: petModel("owl").length, unknown: petModel("dragon").length, recoloured,
    };
  });
  // the nut 14×10 and smooth; the cap the top half of 12×12, faceted; the stem a six-sided faceted cylinder
  assert.deepEqual(shapes.acorn, [[false, 14 * 10 * 6], [true, 12 * 6 * 6], [true, 6 * 6]]);
  assert.ok(Math.abs(shapes.capTop - (0.1 + 0.385)) < 1e-9 && Math.abs(shapes.stemTop - 0.77) < 1e-9, "sized and placed as in the sample");
  assert.equal(shapes.squirrel, 8, "body, head, belly, two ears, two eyes and a tail");
  assert.ok(Math.abs(shapes.rabbitEar - 0.36) < 1e-9, "the rabbit's ears stand taller");
  assert.deepEqual([shapes.snail, shapes.snailFlat, shapes.owl, shapes.unknown], [8, true, 7, 8]);
  assert.deepEqual(shapes.recoloured, [1, 0, 0], "the colours are the tokens'");
  await page.evaluate(() => fetch("/api/delight/settings", {
    method: "POST",
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
    body: JSON.stringify({ look: { style: "3d" } }),
  }).then(() => globalThis.branchDelight.reload()));
  await page.locator("#acorn-3d").waitFor();
  await page.locator("#pet .pet-3d").waitFor();
  const drawn = await page.locator("#acorn-3d").evaluate((canvas) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d");
    g.drawImage(canvas, 0, 0);
    const box = canvas.getBoundingClientRect();
    return { size: [box.width, box.height], ink: g.getImageData(0, 0, copy.width, copy.height).data.some((value, i) => i % 4 === 3 && value > 0) };
  });
  assert.deepEqual(drawn, { size: [58, 58], ink: true }, "the 3D acorn is drawn at the tile's 58px");
  assert.deepEqual(errors, []);
});

const turnOn = (page, body) => page.evaluate((wanted) => fetch("/api/delight/settings", {
  method: "POST",
  headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
  body: JSON.stringify(wanted),
}).then(() => globalThis.branchDelight.reload()), body);

/* DG-138: the 3D oak is the sample's, part for part, with its seasons and its shadow. */
test("3D: the oak is the sample's trunk, branches and crown, dressed for each season, with a shadow on the ground", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 1440, scheme: "light", everything: true });
  const oak = await page.evaluate(async () => {
    const { oakModel } = await import("/delight-3d.js");
    const root = document.documentElement, colour = (name) => getComputedStyle(root).getPropertyValue(name).trim();
    const each = Object.fromEntries(["spring", "summer", "autumn", "winter"].map((season) => [season, oakModel(season)]));
    const summer = each.summer, shadow = summer[0], trunk = summer[1], crown = summer[5];
    const ys = (part) => part.positions.filter((_, i) => i % 3 === 1), high = (part) => Math.max(...ys(part)), low = (part) => Math.min(...ys(part));
    const saved = root.dataset.season;
    root.dataset.season = "winter";
    const byAttribute = oakModel().length;
    root.dataset.season = saved;
    return {
      counts: Object.fromEntries(Object.entries(each).map(([season, parts]) => [season, parts.length])),
      shadow: { alpha: shadow.alpha, colour: shadow.color, y: shadow.positions[1] },
      trunk: [trunk.flat, low(trunk), high(trunk), trunk.indices.length], crown: [crown.flat, crown.indices.length],
      winterFlat: high(each.winter[5]) - low(each.winter[5]), autumnDeep: each.autumn[5].color, autumnLeaf: each.autumn[6].color,
      summerLeaf: crown.color, springPetal: each.spring.at(-1).color, byAttribute, seasonShown: saved,
      tokens: ["--model-oak-autumn-deep", "--model-oak-autumn", "--model-oak-summer", "--model-oak-petal"].map(colour),
    };
  });
  // shadow, trunk, three branches, six crowns (three in winter), and spring's eighteen petals
  assert.deepEqual(oak.counts, { spring: 29, summer: 11, autumn: 11, winter: 8 });
  assert.deepEqual(oak.shadow, { alpha: 0.12, colour: [0, 0, 0], y: 0.01 }, "a see-through black shadow just above the ground");
  assert.deepEqual(oak.trunk, [true, 0, 2.4, 7 * 6 + 2 * 7 * 3], "a closed, faceted seven-sided trunk from the ground to 2.4");
  assert.deepEqual(oak.crown, [true, 20 * 3], "each crown a faceted twenty-sided ball");
  assert.ok(Math.abs(oak.winterFlat - 2 * 1.3 * 0.35 * 0.8507) < 0.01, `winter's crowns lie flat under snow (${oak.winterFlat})`);
  const rgb = (value) => value.map((v) => Math.round(v * 255));
  assert.deepEqual([rgb(oak.autumnDeep), rgb(oak.autumnLeaf), rgb(oak.summerLeaf), rgb(oak.springPetal)],
    [[185, 74, 44], [217, 119, 43], [63, 127, 58], [243, 181, 200]], "the colours are the tokens'");
  assert.deepEqual(oak.tokens, ["#b94a2c", "#d9772b", "#3f7f3a", "#f3b5c8"]);
  assert.equal(oak.byAttribute, 8, "with no season named, the oak wears the window's season");
  assert.ok(["spring", "summer", "autumn", "winter"].includes(oak.seasonShown), "the window names its season");
  // Only the see-through shadow is drawn unlit: no speck of a solid part shows its raw, unlit colour.
  const raw = await page.evaluate(async () => {
    const { oakModel, view3d } = await import("/delight-3d.js");
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;left:0;top:0;width:300px;height:300px";
    document.body.append(canvas);
    const trunk = oakModel("summer")[1], view = view3d(canvas, [trunk], { distance: 4, spin: 0, place: () => [0, -1.2, 0] });
    view.stop();
    view.draw();
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d");
    g.drawImage(canvas, 0, 0);
    canvas.remove();
    const data = g.getImageData(0, 0, copy.width, copy.height).data, bark = trunk.color.map((v) => Math.round(v * 255));
    let solid = 0, unlit = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 255) continue;
      solid += 1;
      if ([0, 1, 2].every((k) => Math.abs(data[i + k] - bark[k]) <= 3)) unlit += 1;
    }
    return { solid, unlit };
  });
  assert.ok(raw.solid > 2000, "the trunk is drawn");
  assert.equal(raw.unlit, 0, "every solid pixel is lit");
  assert.deepEqual(errors, []);
});

/** How much of a canvas is inked, where its ink's middle is across it (0 to 1), and a fingerprint of it. */
const inkOf = (page, selector) => page.locator(selector).evaluate((canvas) => {
  const copy = document.createElement("canvas");
  copy.width = canvas.width; copy.height = canvas.height;
  const g = copy.getContext("2d");
  g.drawImage(canvas, 0, 0);
  const data = g.getImageData(0, 0, copy.width, copy.height).data;
  let inked = 0, across = 0, print = 0;
  for (let i = 3; i < data.length; i += 4) {
    print = (print * 31 + data[i - 3] + data[i - 2] * 7 + data[i - 1] * 13 + data[i]) % 1000000007;
    if (data[i] > 200) { inked += 1; across += ((i - 3) / 4) % copy.width; }
  }
  return { inked, middle: inked ? across / inked / copy.width : 0, print };
});
const WALL = "#delight-wall canvas.delight-3d";
for (const [width, scheme] of [[1440, "dark"], [860, "light"], [400, "light"]]) {
  test(`3D: the oak behind the glass is framed as in the sample and follows the season (${width}px, ${scheme})`, { timeout: 180000 }, async (t) => {
    const f = await fixture(t);
    const { page, errors } = await open(f, { width, scheme, everything: width !== 860 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await turnOn(page, { background: { on: true } });
    await page.evaluate(async () => { await (await import("/delight-background.js")).chooseBuiltIn("oak"); });
    await page.waitForFunction(async (selector) => Boolean((await import("/delight-3d.js")).views.get(document.querySelector(selector))), WALL);
    const before = await inkOf(page, WALL);
    assert.ok(before.inked > 1000, "the oak is drawn");
    if (width >= 860) assert.ok(before.middle > 0.55, `on a wide window the oak stands right of the middle (${before.middle})`);
    else assert.ok(Math.abs(before.middle - 0.5) < 0.08, `on a tall window it stands in the middle (${before.middle})`);
    const next = await page.evaluate(() => { const root = document.documentElement; root.dataset.season = root.dataset.season === "winter" ? "spring" : "winter"; return root.dataset.season; });
    await page.waitForTimeout(100);
    const after = await inkOf(page, WALL);
    assert.notEqual(after.print, before.print, `a new season (${next}) dresses the oak again, even held still`);
    assert.deepEqual(errors, []);
  });
}

/* DG-138: the corner acorn breathes as the sample's does, and the 3D pet takes a new theme's light. */
test("3D: the corner acorn breathes, and the pet is lit again when the theme changes", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const { page, errors } = await open(f, { width: 1440, scheme: "dark", everything: true });
  assert.deepEqual(await page.evaluate(async () => {
    const { breathing } = await import("/delight-3d.js");
    return [breathing(0), breathing(700 * Math.PI / 2).map((v) => Math.round(v * 10000) / 10000)];
  }), [[1, 1, 1], [1.025, 0.9756, 1.025]]);
  await turnOn(page, { look: { style: "3d" } });
  await page.locator("#acorn-3d").waitFor();
  await page.locator("#pet .pet-3d").waitFor();
  const sizes = [];
  for (let i = 0; i < 4; i++) {
    sizes.push(await page.evaluate(async () => (await import("/delight-3d.js")).views.get(document.getElementById("acorn-3d")).size));
    await page.waitForTimeout(500);
  }
  assert.ok(sizes.some(([x]) => Math.abs(x - 1) > 0.002), `the acorn grows and shrinks a little (${JSON.stringify(sizes)})`);
  assert.ok(sizes.every(([x, y, z]) => x === z && Math.abs(x * y - 1) < 1e-9 && Math.abs(x - 1) <= 0.025), "wider as it is shorter, never more than 2.5%");
  const sky = () => page.evaluate(async () => {
    const { views } = await import("/delight-3d.js");
    return { sky: views.get(document.querySelector("#pet .pet-3d")).light.sky.map((v) => Math.round(v * 255)), surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() };
  });
  const dark = await sky();
  await page.evaluate(() => {
    const follow = document.getElementById("appearance-follow"), select = document.getElementById("appearance");
    if (follow.checked) { follow.checked = false; follow.dispatchEvent(new Event("change", { bubbles: true })); }
    select.value = "daylight";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "daylight");
  await page.waitForTimeout(100);
  const light = await sky();
  assert.notEqual(light.surface, dark.surface, "the theme really changed");
  assert.notDeepEqual(light.sky, dark.sky, "the pet's sky light is the new theme's");
  assert.deepEqual(errors, []);
});

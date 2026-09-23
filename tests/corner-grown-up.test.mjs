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

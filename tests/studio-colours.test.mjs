/* DG-105: the studio's colours are the approved sample's (design/Branch-Grown-Up.html `swatches()`, drawn as `.swc`):
   its twenty fixed colours in its order, 30px circles 8px apart, then the rainbow "any colour" circle over the system's
   colour picker. A chosen colour is kept as #rrggbb and comes back chosen after a reload; a face drawn in it keeps its
   letters and features readable (4.5:1) in a light and a dark theme; the server refuses anything that is not a colour;
   and "Follow my theme" switched off again gives back the colour it had. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Measured from the rendered sample (its `swatches()`), not copied from its source: later definitions override earlier ones. */
const SAMPLE = ["#1F5139", "#133524", "#E07033", "#E4BA94", "#B0D0E0", "#D4A73A", "#FF6B8A", "#3AA7F5", "#B4A2FF", "#5FD3A0",
  "#FF8A5B", "#8DB082", "#F97316", "#BD93F9", "#88C0D0", "#FE8019", "#EBBCBA", "#7AA2F7", "#CBA6F7", "#A7C080"];

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-studio-colours-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(new URL(path, server.url), {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await call("POST", "/api/onboarding", { done: true });
  /* Trunks ship off; the studio shows its colours once they are on, as the Trunks switch in Settings does it. */
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  /* After a reload the tab still holds the key, so the window opens without asking for it again. */
  const connect = async () => {
    if (await page.getByLabel("Session token", { exact: true }).isVisible()) {
      await page.getByLabel("Session token", { exact: true }).fill(server.token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
    }
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
    await page.evaluate(async () => { await (await import("/strip.js")).refresh(); });
  };
  await page.goto(server.url);
  await connect();
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors, call, connect };
}
const openAdd = (page) => page.evaluate(async () => (await import("/studio.js")).openAdd("trunk")).then(() => page.locator("#studio-follow").waitFor());
const openEdit = (page, id) => page.evaluate(async (one) => (await import("/studio.js")).openEdit(one), id).then(() => page.locator("#studio-follow").waitFor());

/** The colour row as drawn: each swatch's colour and whether it is pressed, the circles' size and spacing, and the custom one. */
const swatches = (page) => page.evaluate(() => {
  const row = document.querySelector("#studio .studio-swatches");
  const fixed = [...row.querySelectorAll("button.studio-swatch")];
  const custom = row.querySelector(".studio-swatch-custom"), box = fixed[0].getBoundingClientRect(), style = getComputedStyle(fixed[0]);
  return {
    colours: fixed.map((one) => one.dataset.colour), pressed: fixed.filter((one) => one.getAttribute("aria-pressed") === "true").map((one) => one.dataset.colour),
    drawn: fixed.every((one) => getComputedStyle(one).backgroundColor !== "rgba(0, 0, 0, 0)"),
    size: `${box.width}×${box.height}`, round: style.borderRadius, gap: getComputedStyle(row).columnGap,
    custom: custom ? { last: row.lastElementChild === custom, picker: custom.querySelector("input[type=color]")?.getAttribute("aria-label"),
      plus: custom.querySelector("span")?.textContent, size: `${custom.getBoundingClientRect().width}×${custom.getBoundingClientRect().height}`,
      rainbow: getComputedStyle(custom).backgroundImage.startsWith("conic-gradient") } : null,
    follow: document.getElementById("studio-follow").checked,
  };
});
/** WCAG contrast between the big preview face's ink and its colour. */
const previewContrast = (page) => page.evaluate(() => {
  const fc = document.querySelector("#studio .studio-preview .face .fc, #studio .face .fc");
  const rgb = (text) => text.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(rgb(getComputedStyle(fc).color)), lum(rgb(getComputedStyle(fc).backgroundColor))];
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
});
const trunks = async (call) => (await (await call("GET", "/api/trunks")).json()).trunks;

test("DG-105 the studio offers the sample's twenty colours in its order, then any colour", async (t) => {
  const { page, errors } = await signedIn(t);
  await openAdd(page);
  const seen = await swatches(page);
  assert.deepEqual(seen.colours, SAMPLE);
  assert.deepEqual({ size: seen.size, round: seen.round, gap: seen.gap, drawn: seen.drawn }, { size: "30×30", round: "50%", gap: "8px", drawn: true });
  assert.deepEqual(seen.custom, { last: true, picker: "Any colour", plus: "+", size: "30×30", rainbow: true });
  assert.deepEqual(seen.pressed, ["#1F5139"], "a new Trunk starts in the sample's first green");
  assert.equal(await page.getByRole("button", { name: "Colour #E07033", exact: true }).count(), 1, "each swatch is named by its colour, as the sample's");
  assert.deepEqual(errors, []);
});

test("DG-105 a chosen colour is kept as #rrggbb and comes back chosen after a reload", async (t) => {
  const { page, errors, call, connect } = await signedIn(t);
  await openAdd(page);
  await page.locator("#studio-name").fill("Gardener");
  await page.getByRole("button", { name: "Colour #E4BA94", exact: true }).click();
  assert.deepEqual((await swatches(page)).pressed, ["#E4BA94"]);
  await page.getByRole("button", { name: "Create the Trunk", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#studio")?.checkVisibility());
  const [made] = await trunks(call);
  /* Kept beside the look, whose own colour stays empty so a build from before this can still read it. */
  assert.deepEqual([made.chosenColour, made.look.colour], ["#e4ba94", null]);
  await page.reload();
  await connect();
  await openEdit(page, made.id);
  assert.deepEqual((await swatches(page)).pressed, ["#E4BA94"]);
  /* Any colour: the picker's value is the colour, no swatch is pressed, and it is saved the same way. */
  await page.locator("#studio-custom").evaluate((picker) => { picker.value = "#123456"; picker.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.deepEqual((await swatches(page)).pressed, []);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#studio")?.checkVisibility());
  assert.equal((await trunks(call))[0].chosenColour, "#123456");
  await openEdit(page, made.id);
  assert.equal(await page.locator("#studio-custom").inputValue(), "#123456");
  assert.deepEqual(errors, []);
});

test("DG-105 a face in any of the colours stays readable, in a light and a dark theme", async (t) => {
  const { page, errors } = await signedIn(t);
  for (const theme of ["forest", "daylight"]) {
    await page.evaluate(async (wanted) => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), appearance: wanted, followSystem: false });
    }, theme);
    await openAdd(page);
    await page.locator("#studio-name").fill("Ledger");
    /* Letters: ink on the colour, which the pixel-art face (the default) never uses. */
    await page.getByRole("button", { name: "Letters", exact: true }).click();
    assert.equal(await page.locator("#studio .face .fc-letters").first().getAttribute("data-text"), "L");
    for (const colour of SAMPLE) {
      await page.getByRole("button", { name: `Colour ${colour}`, exact: true }).click();
      const ratio = await previewContrast(page);
      assert.ok(ratio >= 4.5, `${theme} ${colour}: ${ratio}:1`);
    }
    for (const colour of ["#ffffff", "#777777", "#000000", "#23535c"]) {
      await page.locator("#studio-custom").evaluate((picker, value) => { picker.value = value; picker.dispatchEvent(new Event("input", { bubbles: true })); }, colour);
      const ratio = await previewContrast(page);
      assert.ok(ratio >= 4.5, `${theme} any colour ${colour}: ${ratio}:1`);
    }
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  assert.deepEqual(errors, []);
});

test("DG-105 the server keeps only a real colour, and never inside the look", async (t) => {
  const { call } = await signedIn(t);
  const made = await (await call("POST", "/api/trunks", { name: "Scout", title: "", description: "" })).json();
  for (const colour of ["#12345g", "red", "#1234", "var(--x)"]) {
    const answer = await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: colour });
    assert.equal(answer.status, 400, `${colour} is refused`);
  }
  assert.equal((await call("POST", `/api/trunks/${made.trunk.id}`, { look: { colour: "#a7c080" } })).status, 400, "the look keeps tokens only");
  const kept = await (await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: "#A7C080" })).json();
  assert.equal(kept.trunk.chosenColour, "#a7c080");
  const cleared = await (await call("POST", `/api/trunks/${made.trunk.id}`, { chosenColour: null, look: { colour: "theme" } })).json();
  assert.deepEqual([cleared.trunk.chosenColour, cleared.trunk.look.colour], [null, "theme"]);
});

test("DG-105 Follow my theme switched off again gives back the colour it had", async (t) => {
  const { page, errors } = await signedIn(t);
  await openAdd(page);
  await page.getByRole("button", { name: "Colour #7AA2F7", exact: true }).click();
  await page.locator("#studio-follow").click();
  await page.waitForFunction(() => document.getElementById("studio-follow")?.checked);
  assert.deepEqual((await swatches(page)).pressed, []);
  await page.locator("#studio-follow").click();
  await page.waitForFunction(() => document.getElementById("studio-follow")?.checked === false);
  assert.deepEqual((await swatches(page)).pressed, ["#7AA2F7"]);
  assert.deepEqual(errors, []);
});

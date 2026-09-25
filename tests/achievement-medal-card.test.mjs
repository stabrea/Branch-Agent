/* DG-014: a Bronze or Silver achievement arrives as the approved sample's small medal card (design/Branch-Grown-Up.html,
   `.ach-pop.small`): top-right, a rounded glass card with its tier eyebrow, and never over the top bar's buttons at
   1440, 860 and 400 wide. Gold and above keep their party. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-medal-card-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  return { page, errors };
}

const celebrate = (page, tier) => page.evaluate(async (rank) => (await import("/delight-achievements.js")).preview(rank), tier);

const measure = (page) => page.evaluate(() => {
  const note = document.getElementById("ach-note"), box = note.getBoundingClientRect(), style = getComputedStyle(note);
  const eyebrow = note.querySelector(".ach-lines small"), name = note.querySelector(".ach-lines b");
  const copper = getComputedStyle(document.body).getPropertyValue("--copper-text").trim();
  const probe = document.createElement("i");
  probe.style.color = copper;
  document.body.append(probe);
  const copperRgb = getComputedStyle(probe).color;
  probe.remove();
  const overlaps = (r) => r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
  const bar = document.querySelector("main > header");
  const controls = [...bar.querySelectorAll("button, a, input, [role=status], .status-pill, h1")]
    .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
    .filter((el) => overlaps(el.getBoundingClientRect())).map((el) => el.id || el.className || el.tagName);
  return {
    top: box.top, left: box.left, rightGap: innerWidth - box.right, width: box.width, barBottom: bar.getBoundingClientRect().bottom,
    covered: controls, inWindow: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    radius: style.borderTopLeftRadius, glass: style.backdropFilter, round: style.borderRadius === "999px",
    eyebrow: { text: eyebrow.textContent, transform: getComputedStyle(eyebrow).textTransform, colour: getComputedStyle(eyebrow).color, copperRgb },
    nameCut: name.scrollWidth > name.clientWidth + 1, role: note.getAttribute("role"),
  };
});

for (const width of [1440, 860, 400]) {
  test(`DG-014 at ${width} px a Bronze achievement is the top-right medal card with its tier eyebrow, under the top bar`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await celebrate(page, "Bronze");
    await page.locator("#ach-note").waitFor();
    const seen = await measure(page);
    assert.deepEqual(seen.covered, [], "it covers none of the top bar's buttons");
    assert.ok(seen.top >= seen.barBottom, `it sits under the top bar (${seen.top} for a bar ending at ${seen.barBottom})`);
    assert.ok(seen.rightGap >= 8 && seen.rightGap <= 24, `it keeps to the right edge (${seen.rightGap}px from it)`);
    assert.ok(seen.left > width / 2 - 1 || width <= 400, `on the right, not centred (${seen.left})`);
    assert.equal(seen.inWindow, true, "inside the window");
    assert.equal(seen.radius, "14px", "the sample's rounded card, not a pill");
    assert.match(seen.glass, /blur\(12px\)/, "the sample's glass");
    assert.equal(seen.eyebrow.text, "Bronze achievement", "the tier eyebrow");
    assert.equal(seen.eyebrow.transform, "uppercase", "set in small capitals as the sample does");
    assert.equal(seen.eyebrow.colour, seen.eyebrow.copperRgb, "in copper");
    assert.equal(seen.nameCut, false, "the achievement's name is not cut short");
    assert.equal(seen.role, "status", "still read out when it arrives");
    /* A click puts it away. */
    await page.locator("#ach-note").click();
    await page.locator("#ach-note").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  });
}

test("DG-014 a Silver is the same card, and Gold still gets its party instead", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await celebrate(page, "Silver");
  await page.locator("#ach-note").waitFor();
  const seen = await measure(page);
  assert.equal(seen.eyebrow.text, "Silver achievement");
  assert.deepEqual(seen.covered, []);
  await celebrate(page, "Gold");
  await page.locator(".ach-party .ach-card").waitFor({ timeout: 5000 }).catch(() => assert.fail("Gold keeps its party card"));
  assert.deepEqual(errors, []);
});

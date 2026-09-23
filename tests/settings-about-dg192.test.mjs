/* DG-192: Settings › Updates & about has the approved sample's sections, in its order, at every width and level:
   Updates · Updating by itself · The keeper. Reporting a problem and removing Branch have no place in the sample yet,
   so they wait for Advanced and never add a head or an "N more" line at Regular. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, { width = 1440, height = 950, preferences } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-about-dg192-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  if (preferences) app.store.save("settings", app.runtime.owner, "preferences", preferences);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  return { page, errors, app };
}
async function openAbout(page) {
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="about"]').click();
  await page.locator("#about-keeper").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
}
/** The headings and "N more" lines a person sees on the page, in order. */
const seen = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-about :is(h2, h3, h4, h5, .sg-more)")]
  .filter((node) => node.checkVisibility() && node.getBoundingClientRect().width > 1).map((node) => node.textContent.trim()));

for (const [width, height] of [[1440, 950], [860, 900], [400, 844]]) {
  for (const everything of [false, true]) {
    test(`DG-192 at ${width} px, Show everything ${everything ? "on" : "off"}: the sample's sections in its order`, async (t) => {
      const preferences = everything ? { showEverything: true, settingsLevel: "advanced" } : undefined;
      const { page, errors } = await fixture(t, { width, height, preferences });
      await openAbout(page);
      const heads = await seen(page);
      const sample = ["Updates & about", "Updates", "Updating by itself", "The keeper"];
      if (!everything) assert.deepEqual(heads, sample);
      else {
        assert.deepEqual(heads.slice(0, 4), sample, "the sample's sections come first, in its order");
        assert.deepEqual(heads.slice(4), ["Help and problems", "Report a problem", "Send future problems automatically",
          "Removing Branch", "Remove Branch from this computer"], "nothing that worked is lost");
      }
      assert.equal(heads.some((words) => /more with/.test(words)), false, "no N more line");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no sideways scroll");
      assert.deepEqual(errors, []);
    });
  }
}

test("DG-192 Updates shows Branch Agent and its version in a browser; the desktop app also has Check for updates and the channel", async (t) => {
  const { page, errors } = await fixture(t);
  await openAbout(page);
  assert.equal(await page.locator("#updates-card").isVisible(), true);
  assert.match(await page.locator("#updates-version").textContent(), /^Branch Agent \d/);
  assert.equal(await page.locator(".updates-brand b").textContent(), "Branch Agent");
  assert.equal(await page.locator("#updates-check").isVisible(), false, "a browser cannot check");
  assert.equal(await page.locator("#updates-channel").isVisible(), false);
  /* The channel is the desktop app's, and keeps its two choices exactly (tests/comfort-ui.test.mjs drives it). */
  const labels = await page.locator("#updates-channel label").allTextContents();
  assert.deepEqual(labels.map((words) => words.trim()), ["Stable", "Beta"]);
  assert.deepEqual(errors, []);
});

test("DG-192 Updating by itself saves as it is picked, with no Save button, and the keeper's acorn turns", async (t) => {
  const { page, errors } = await fixture(t);
  await openAbout(page);
  const card = page.locator("#comfort-updates-card");
  assert.equal(await card.locator("button", { hasText: /^Save/ }).filter({ visible: true }).count(), 0, "no Save button");
  await card.locator('input[value="check"]').check({ force: true });
  await page.waitForFunction(() => document.querySelector("#comfort-updates-card [role=status]")?.textContent?.length > 0);
  assert.equal(await card.locator("[role=status]").getAttribute("data-t"), "comfort.saved", "saved the moment it was picked");
  const pixels = () => page.locator("#about-acorn").evaluate((canvas) => canvas.toDataURL());
  const before = await pixels();
  const blank = await page.evaluate(() => { const c = document.createElement("canvas"); const k = document.getElementById("about-acorn"); c.width = k.width; c.height = k.height; return c.toDataURL(); });
  assert.notEqual(before, blank, "the acorn is drawn");
  await page.locator("#about-acorn").focus();
  await page.keyboard.press("ArrowRight");
  assert.notEqual(await pixels(), before, "the arrow keys turn it");
  assert.deepEqual(errors, []);
});

test("DG-192 the page speaks French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await openAbout(page);
  const heads = await seen(page);
  assert.deepEqual(heads.slice(1), ["Mises à jour", "Se mettre à jour tout seul", "Le gardien"]);
  assert.equal(await page.locator("#about-acorn").getAttribute("aria-label"), "Le gland. Faites-le glisser ou utilisez les flèches pour le tourner.");
  assert.deepEqual(errors, []);
});

/* The sample's Branch mark is the oak leaf and acorn: the reversed one on Moonlight, the other on Daylight. */
const shownMarks = (page) => page.locator(".updates-brand img").evaluateAll((marks) => marks
  .filter((mark) => mark.checkVisibility() && mark.complete && mark.naturalWidth > 0)
  .map((mark) => ({ src: new URL(mark.src).pathname, width: Math.round(mark.getBoundingClientRect().width) })));

for (const width of [1440, 400]) {
  test(`DG-192 at ${width} px Updates wears the sample's Branch mark in both lights`, async (t) => {
    const { page, errors } = await fixture(t, { width });
    await openAbout(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = "forest"; });
    assert.deepEqual(await shownMarks(page), [{ src: "/assets/keepoak-mark-reversed.png", width: 56 }], "Moonlight");
    await page.evaluate(() => { document.documentElement.dataset.theme = "daylight"; });
    assert.deepEqual(await shownMarks(page), [{ src: "/assets/keepoak-mark.png", width: 56 }], "Daylight");
    assert.deepEqual(errors, []);
  });
}

test("DG-192 the up-to-date line leads with a check only when this is the newest", async (t) => {
  const { page, errors, app } = await fixture(t);
  await page.evaluate((version) => {
    globalThis.__release = { latestVersion: version, available: false };
    window.branchDesktop = {
      updateStatus: async () => ({ phase: "current", message: "", progress: null, release: globalThis.__release }),
      checkForUpdates: async () => ({ phase: "current", message: "", progress: null, release: globalThis.__release }),
    };
  }, app.version);
  await openAbout(page);
  const line = page.locator("#updates-newest");
  await page.locator("#updates-check").click();
  await page.waitForFunction(() => document.querySelector("#updates-newest svg"));
  assert.equal(await line.textContent(), `Running ${app.version}, which is the newest.`, "the words are unchanged");
  const look = await line.evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ok)";
    document.body.append(probe);
    const ok = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(node);
    return { display: style.display, size: style.fontSize, check: getComputedStyle(node.querySelector("path")).stroke === ok };
  });
  assert.deepEqual(look, { display: "flex", size: "13px", check: true });
  await page.evaluate(() => { globalThis.__release = { latestVersion: "999.0.0", available: true }; });
  await page.locator("#updates-check").click();
  await page.waitForFunction(() => /newest is 999/.test(document.querySelector("#updates-newest").textContent));
  assert.equal(await line.locator("svg").count(), 0, "no check while a newer one waits");
  assert.deepEqual(errors, []);
});

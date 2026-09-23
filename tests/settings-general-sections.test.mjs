/**
 * DG-180 (with DG-028/029/030/031): Settings › General has the approved sample's sections, in its order, with the
 * same "N more with …" lines, at every width and in both Show everything states; the owner's PIN is a section of
 * its own; the cross-links go to the section that sets each thing; the headings are French in French.
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

/* The sample's General at Regular (its KeepOak account card is not drawn: Branch has none to connect). */
const REGULAR = ["People on this computer", "A PIN for switching back to you", "How Branch starts and keeps running", "3 more with Advanced",
  "Your projects", "9 more with Advanced", "Keys and typed commands", "6 more with Advanced", "Signing in from other devices", "6 more with Advanced"];
const ADVANCED = ["People on this computer", "A PIN for switching back to you", "How Branch starts and keeps running",
  "Your projects", "2 more with Technical", "Keys and typed commands", "Signing in from other devices", "5 more with Technical"];

async function fixture(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-general-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", body: JSON.stringify({ done: true }),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  const page = await browser.newPage({ viewport: { width, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  const cog = page.locator(".sg-foot-line > .sg-gear:visible");
  if (!(await cog.count())) await page.locator("#rail-toggle").click();
  await cog.click();
  await page.locator('.lx-settings-link[data-page="general"]').click();
  await page.locator("#lx-collab-owner-pin .collab-owner-pin").waitFor({ state: "attached" });
  return { page, errors };
}
/** The section headings and "N more" lines on show, in page order. */
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-general .sg-head-title, #lx-page-general .sg-more")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
async function level(page, pick) {
  await page.evaluate((pick) => globalThis.branchSettingsLevel.set(pick), pick);
  await page.waitForFunction((pick) => document.documentElement.dataset.settingsLevel === pick, pick);
  await page.waitForTimeout(300);
}

for (const width of [1440, 400]) {
  test(`General has the sample's sections in order, Show everything off and on, at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await page.waitForFunction((want) => [...document.querySelectorAll("#lx-page-general .sg-head-title, #lx-page-general .sg-more")]
      .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()).join("|") === want, REGULAR.join("|"), { timeout: 10000 })
      .catch(() => {});
    assert.deepEqual(await outline(page), REGULAR);
    await level(page, "advanced");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.everything), "on");
    assert.deepEqual(await outline(page), ADVANCED);
    /* Nothing is dropped: labels, presets, putting settings back and shared copies wait for Technical. */
    await level(page, "technical");
    for (const id of ["lx-collab-labels", "settings-kit-presets", "settings-kit-reset", "lx-collab-shares"])
      assert.equal(await page.locator(`#${id}`).isVisible(), true, `${id} shows at Technical`);
    assert.deepEqual(errors, []);
  });
}

test("the PIN has a section of its own, and the cross-links take the keyboard there", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const pin = page.locator("#lx-collab-owner-pin");
  assert.equal(await pin.getAttribute("data-sg-bucket"), "general:pin");
  assert.equal(await page.locator("#lx-collab-people [data-part='owner-pin']").count(), 0, "the PIN is not inside the people card");
  /* As the sample draws it: the field, Set this PIN, then what the PIN does now. */
  const words = await pin.evaluate((node) => node.innerText);
  assert.match(words, /Set this PIN[\s\S]*Off\. Anybody at this computer can switch back to you without a PIN/);
  assert.equal(await pin.locator("input[aria-label='Your PIN, four to eight digits']").count(), 1);
  /* DG-030: each link is a real button that brings its section's first control under the keyboard. */
  const go = page.locator("#lx-general-links [data-to='lx-collab-owner-pin'] .lx-link-go");
  assert.equal(await go.textContent(), "Set in A PIN for switching back to you ›");
  await go.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.closest("#lx-collab-owner-pin"));
  await page.locator("#lx-general-links [data-to='lx-collab-people'] .lx-link-go").click();
  await page.waitForFunction(() => document.activeElement?.closest("#lx-collab-people"));
  assert.deepEqual(errors, []);
});

test("General's section headings and links are French in French", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-general-pin")?.textContent === "Un code PIN pour revenir à vous");
  const heads = await page.locator("#lx-page-general .sg-head-title").evaluateAll((nodes) => nodes.map((node) => node.textContent));
  for (const english of ["People on this computer", "A PIN for switching back to you", "Signing in from other devices"])
    assert.ok(!heads.includes(english), `${english} is still English`);
  assert.equal(await page.locator("#lx-general-links [data-to='lx-collab-people'] .lx-link-go").textContent(), "Réglé dans Personnes sur cet ordinateur ›");
  assert.deepEqual(errors, []);
});

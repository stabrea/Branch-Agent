/**
 * DG-180 (with DG-028/029/030/031): Settings › General has the approved sample's sections, in its order, with the
 * same "N more with …" lines, at every width and in both Show everything states; the owner's PIN is a section of
 * its own; the cross-links go to the section that sets each thing; the headings are French in French.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { BUCKETS } from "../public/settings-buckets.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* The sample's General at Regular (its KeepOak account card is not drawn: Branch has none to connect). Your projects
   says 9, as the sample does: it counts "AGENTS.md in the project folder", which the sample draws as a "Set in …" link
   at Advanced (public/settings-rows.js). */
const REGULAR = ["People on this computer", "A PIN for switching back to you", "How Branch starts and keeps running", "3 more with Advanced",
  "Your projects", "9 more with Advanced", "Keys and typed commands", "6 more with Advanced", "Signing in from other devices", "6 more with Advanced"];
const ADVANCED = ["People on this computer", "A PIN for switching back to you", "How Branch starts and keeps running",
  "Your projects", "2 more with Technical", "Keys and typed commands", "Signing in from other devices", "5 more with Technical"];

async function fixture(t, width, { ownerPin } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-general-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
  await post("/api/onboarding", { done: true });
  if (ownerPin) assert.equal((await post("/api/profiles/owner-pin", { pin: ownerPin })).status, 200);
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
  return { page, errors, app };
}
/** The section headings and "N more" lines on show, in page order. */
const outline = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-page-general .sg-head-title, #lx-page-general .sg-more")]
  .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
async function level(page, pick) {
  await page.evaluate((pick) => globalThis.branchSettingsLevel.set(pick), pick);
  await page.waitForFunction((pick) => document.documentElement.dataset.settingsLevel === pick, pick);
  await page.waitForTimeout(300);
}

for (const width of [1440, 860, 400]) {
  test(`General has the sample's sections in order, Show everything off and on, at ${width}px`, async (t) => {
    const { page, errors } = await fixture(t, width);
    await page.waitForFunction((want) => [...document.querySelectorAll("#lx-page-general .sg-head-title, #lx-page-general .sg-more")]
      .filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()).join("|") === want, REGULAR.join("|"), { timeout: 10000 })
      .catch(() => {});
    assert.deepEqual(await outline(page), REGULAR);
    /* Signing in from other devices says its title once, and shows its switch alone, as the sample does. */
    const signin = page.locator("#people-signin-admin");
    assert.equal(await signin.locator("h2").evaluate((node) => node.matches(".sr-only")), true, "the card's own title does not repeat the section's heading");
    assert.equal(await signin.locator("#people-admin-save").isVisible(), false, "no Save at Regular");
    assert.equal(await signin.getByText("Nobody else uses this computer yet.", { exact: false }).isVisible(), false, "no list of people at Regular");
    /* The On this page list names the sample's sections, and no empty "More on this page". */
    assert.deepEqual(await page.locator("#lx-page-general .lx-on-this-page-link").allTextContents(), REGULAR.filter((words) => !/ more with /.test(words)));
    await level(page, "advanced");
    assert.equal(await signin.locator("#people-admin-save").isVisible(), true, "Save shows with the hours at Advanced");
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
  /* As the sample draws it: the field's words, the field, Set this PIN alone, then what the PIN does now. */
  const words = await pin.evaluate((node) => node.innerText);
  assert.match(words, /^Your PIN, four to eight digits\s+Set this PIN\s+Off\. Anybody at this computer can switch back to you without a PIN/);
  assert.equal(await pin.getByLabel("Your PIN, four to eight digits", { exact: true }).getAttribute("placeholder"), "Not set");
  assert.equal(await pin.locator("button").count(), 1);
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
  assert.equal(await page.locator("#lx-general-links [data-to='lx-collab-people'] .lx-link-go").textContent(), "À régler dans Personnes sur cet ordinateur ›");
  assert.deepEqual(errors, []);
});

test("with a PIN set, the PIN section shows Switch the PIN off alone, and Change the PIN once new digits are typed", async (t) => {
  const { page, errors } = await fixture(t, 1440, { ownerPin: "2468" });
  const pin = page.locator("#lx-collab-owner-pin");
  const field = pin.getByLabel("Your PIN, four to eight digits", { exact: true });
  await page.waitForFunction(() => /^On\./.test(document.querySelector("#lx-collab-owner-pin .collab-meta")?.textContent ?? ""));
  assert.deepEqual(await pin.locator("button").allTextContents(), ["Switch the PIN off"], "never Set this PIN beside it");
  assert.equal(await field.getAttribute("placeholder"), "••••");
  /* A PIN half typed is still there after the panel is drawn again (every three seconds). */
  await field.fill("13");
  assert.deepEqual(await pin.locator("button").allTextContents(), ["Change the PIN"]);
  await page.waitForTimeout(3500);
  assert.equal(await field.inputValue(), "13");
  await field.fill("1357");
  const changed = page.waitForRequest((request) => request.url().endsWith("/api/profiles/owner-pin"));
  await pin.getByRole("button", { name: "Change the PIN" }).click();
  assert.deepEqual((await changed).postDataJSON(), { pin: "1357" });
  await page.waitForFunction(() => document.querySelector("#lx-collab-owner-pin button")?.textContent === "Switch the PIN off"
    && !document.querySelector("#lx-collab-owner-pin input").value);
  const off = page.waitForRequest((request) => request.url().endsWith("/api/profiles/owner-pin"));
  await pin.getByRole("button", { name: "Switch the PIN off" }).click();
  assert.deepEqual((await off).postDataJSON(), { pin: null });
  await page.waitForFunction(() => document.querySelector("#lx-collab-owner-pin button")?.textContent === "Set this PIN");
  assert.deepEqual(errors, []);
});

test("the section lines are the sample's words, with real French", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const SAMPLE = {
    people: "Profiles give somebody else a name and a PIN of four to eight digits. While their profile is on, the conversation list, saved conversations and Memory are theirs and not yours.",
    keys: "Shortcuts and the commands you can type with a slash.",
    signin: "Lets the people you added to this computer reach their own conversations from their own phone or laptop, and lets you share a conversation with them.",
  };
  for (const [id, words] of Object.entries(SAMPLE)) {
    assert.equal(BUCKETS.general.find((bucket) => bucket[0] === id)[3], words, `${id}: public/settings-buckets.js`);
    assert.equal(en[`settingsGrown.bucket.general.${id}.line`], words, `${id}: en.json`);
    assert.ok(fr[`settingsGrown.bucket.general.${id}.line`] && fr[`settingsGrown.bucket.general.${id}.line`] !== words, `${id}: real French`);
  }
  for (const key of ["people.owner-pin.change", "people.owner-pin.not-set"]) assert.ok(fr[key] && fr[key] !== en[key], `${key}: real French`);
});

/* The rendered sample draws no line under "A PIN for switching back to you" (General) or under "Its files"
   (Instructions & personality): Branch draws none either, in English or in French. */
const LINELESS = [["general", "pin"], ["instructions", "files"]];

test("the PIN section and Its files have no line under their heading, as the sample", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  for (const [page, id] of LINELESS) {
    assert.equal(BUCKETS[page].find((bucket) => bucket[0] === id)[3], "", `${page}:${id}: public/settings-buckets.js`);
    for (const [name, words] of [["en", en], ["fr", fr]])
      assert.equal(words[`settingsGrown.bucket.${page}.${id}.line`], undefined, `${page}:${id}: no line in ${name}.json`);
  }
});

test("on the page, neither section draws a line, in English or in French", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const lines = () => page.evaluate((list) => list.map(([name, id]) =>
    document.querySelectorAll(`.sg-head[data-bucket="${name}:${id}"] .sg-head-line`).length), LINELESS);
  assert.deepEqual(await lines(), [0, 0], "English");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("sg-bucket-general-pin")?.textContent === "Un code PIN pour revenir à vous");
  assert.deepEqual(await lines(), [0, 0], "French");
  assert.deepEqual(errors, []);
});

test("every \"Set in … ›\" link says \"À régler dans … ›\" in French, the same words everywhere", async () => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const links = Object.keys(en).filter((key) => en[key].startsWith("Set in "));
  assert.ok(links.length >= 4, `the links are found (${links.length})`);
  assert.deepEqual(links.filter((key) => !fr[key]?.startsWith("À régler dans ")), []);
  assert.deepEqual(Object.keys(fr).filter((key) => /^Réglée?s? dans /.test(fr[key])), []);
});

test("Signing in from other devices says its line once, and keeps its title for a screen reader only", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  const line = "Lets the people you added to this computer reach their own conversations from their own phone or laptop, and lets you share a conversation with them.";
  for (const pick of ["regular", "advanced"]) {
    await level(page, pick);
    const shown = await page.evaluate((words) => [...document.querySelectorAll("#lx-page-general p")]
      .filter((node) => node.checkVisibility() && node.textContent.trim() === words).length, line);
    assert.equal(shown, 1, `the section's line alone says it, at ${pick}`);
  }
  assert.equal(await page.locator("#people-signin-admin > h2.sr-only").textContent(), "Signing in from other devices");
  assert.deepEqual(errors, []);
});

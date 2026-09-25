/**
 * mac7/wake-pins: the two cards, reached the way a person reaches them — Settings, Voice for the
 * word that starts a turn, and Settings, Permissions for the settings you have pinned. Each starts
 * off or empty, says what this computer would really do, fits a 400-pixel window and reads in
 * French. Headless browser only; no window opens, no microphone, no sound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

const LOCALES = new URL("../public/locales/", import.meta.url);

async function fixture(t, viewport = { width: 1280, height: 900 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-pins-ui-"));
  const provider = { name: "wake-pins-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

test("U1 the wake word card is under Settings, Voice, starts off with no word, and says what this computer would do", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "settings:voice");
  const card = page.locator("#wake-word-form");
  await card.waitFor({ state: "visible" });
  assert.equal(app.store.get("settings", "local", "wake-word"), undefined, "a fresh install already saved something");
  assert.equal(await page.locator("#wake-word-mode").inputValue(), "off");
  assert.equal(await page.locator("#wake-word-word").inputValue(), "");
  // The card says plainly what this Mac or this Linux box would really do before anything is turned on.
  await page.locator("#wake-word-how").waitFor();

  await page.getByLabel("Your word", { exact: true }).fill("branch");
  await page.locator("#wake-word-mode").selectOption("when-needed");
  /* DG-025: kept as you go, with no Save button. */
  assert.equal(await card.getByRole("button", { name: "Save the wake word", exact: true }).count(), 0);
  await page.locator("#wake-word-state", { hasText: "Saved." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "wake-word").data,
    { mode: "when-needed", word: "branch", sureness: 80, windowSeconds: 2 });
  // Whatever this computer is, the card now says one true thing about spotting the word.
  assert.ok((await page.locator("#wake-word-how").innerText()).length > 20);
  assert.deepEqual(errors, []);
});

test("U2 the pins card is under Settings, Permissions, starts empty, and pins one setting", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "settings:permissions");
  const card = page.locator("#pins-form");
  await card.waitFor({ state: "visible" });
  await page.getByText("Nothing is pinned yet: every setting can be changed by anybody who uses this computer.").waitFor();

  // The list of settings is only asked for once the card is really on the screen.
  await page.locator("#pins-setting option").first().waitFor({ state: "attached" });
  await page.locator("#pins-setting").selectOption({ label: "A word that starts a turn \u2014 Switch" });
  await card.getByRole("button", { name: "Pin this setting", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Pinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins.map(({ key, field, value }) => ({ key, field, value })),
    [{ key: "wake-word", field: "mode", value: "off" }]);
  await page.getByRole("button", { name: "Unpin", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Unpinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins, []);
  assert.deepEqual(errors, []);
});

test("U3 both cards fit a 400-pixel window", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  for (const [place, id] of [["settings:voice", "#wake-word-form"], ["settings:permissions", "#pins-form"]]) {
    await openPlace(page, place);
    const card = page.locator(id);
    await card.waitFor({ state: "visible" });
    // Measured inside the page in one step: the card redraws itself, and a box asked for in two
    // steps (find the element, then measure it) can land on one that was just replaced (null).
    const fits = await page.waitForFunction((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box && box.width > 0 && box.x >= 0 && box.right <= 400;
    }, id, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(fits, `${id} fits inside 400 px`);
  }
  assert.deepEqual(errors, []);
});

test("U4 every word on both cards is in English and in real French", async () => {
  const en = JSON.parse(await readFile(new URL("en.json", LOCALES), "utf8"));
  const fr = JSON.parse(await readFile(new URL("fr.json", LOCALES), "utf8"));
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const cards = /id="wake-word-form"[\s\S]*?<\/form>[\s\S]*?id="pins-form"[\s\S]*?<\/form>/.exec(page);
  assert.ok(cards, "the two cards are no longer in the page");
  const keys = new Set([...cards[0].matchAll(/data-t="([^"]+)"/g)].map((hit) => hit[1]));
  for (const file of ["../public/wake-word.js", "../public/pins.js"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    for (const found of text.matchAll(/\bt\("([^"]+)"/g)) keys.add(found[1]);
  }
  // The two names the settings kit itself shows for the wake word, which are not in the page.
  for (const key of ["settings-kit.name.wake-word", "settings-kit.field.wake-sureness"]) keys.add(key);
  assert.ok(keys.size > 20, `only ${keys.size} keys found; the scan is looking in the wrong place`);
  assert.deepEqual([...keys].filter((key) => !(key in en)), [], "keys with no English words");
  assert.deepEqual([...keys].filter((key) => !(key in fr)), [], "keys with no French words");
  // "Saved." is the same word in neither language; every sentence here is really translated.
  assert.deepEqual([...keys].filter((key) => fr[key] === en[key]), [], "these words are still English when French is chosen");
});

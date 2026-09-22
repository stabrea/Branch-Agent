import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { closeSettings, openSettings } from "./places.mjs";

/*
 * The "i" beside every setting's name, as the sample has it (public/settings-describe.js).
 *
 * This walks every Settings page and every Models tab as a fresh install shows them, and checks each
 * visible control that has a label with words in it: the "i" must sit straight after that label, be
 * visible, and say what it is about. Controls with no label (six on Permissions, one on Data) are not
 * counted; there is no name to hang an "i" on. It then presses one "i" and checks what it opens, and
 * that the control kept its exact name -- an "i" inside the label would have joined the name.
 */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");
const MODEL_TABS = ["connection", "defaults", "local", "second", "media"];

async function fixture(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-info-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  // The app's service worker answers its own files, where a test's held response cannot reach.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#agent-files").waitFor({ state: "attached", timeout: 60000 });
  return { page, errors };
}

/** The "i" straight after the label wrapped round the control `selector` finds. */
const infoFor = (page, selector) => page.locator(selector)
  .locator("xpath=ancestor::label[1]/following-sibling::*[1][contains(@class, 'kit-info')]");

/** Named controls on the open page with no visible "i" after their label, and how many were checked. */
function auditOpenPage(where) {
  const shown = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const missing = [];
  let named = 0;
  for (const control of document.querySelectorAll(".lx-page:not([hidden]) .card :is(input:not([type=hidden]), select, textarea)")) {
    const segmented = control.closest(".segmented-control");
    if (!shown(control) && !(segmented && shown(segmented))) continue;
    const label = [...(control.labels ?? [])].find((node) => node.textContent.trim());
    if (!label) continue;
    named++;
    const info = label.nextElementSibling;
    if (!info?.classList.contains("kit-info") || !shown(info) || info.getAttribute("aria-label") !== "About this setting"
      || document.getElementById(info.getAttribute("aria-describedby")) !== label)
      missing.push(`${where}: ${control.id ? `#${control.id}` : control.name || control.type}`);
  }
  return { named, missing };
}

test("every named setting has an i after its name, on every Settings page", async (t) => {
  const { page, errors } = await fixture(t);
  const pages = await page.evaluate(() => [...document.querySelectorAll(".lx-page")].map((node) => node.dataset.page));
  assert.ok(pages.length >= 12, "the Settings pages moved; this test is looking in the wrong place");
  const missing = [];
  let named = 0;
  for (const name of pages) {
    await openSettings(page, name);
    for (const tab of name === "models" ? MODEL_TABS : [null]) {
      if (tab) await page.locator(`#lx-page-models .lx-subtab[data-sub="${tab}"]`).click();
      /* A tab that draws its controls from an answer draws them a moment later: wait for the page to
         settle (nothing missing), up to three seconds, and report whatever is still missing then. */
      let result;
      for (let tries = 0; tries < 20; tries++) {
        result = await page.evaluate(auditOpenPage, tab ? `models:${tab}` : name);
        if (!result.missing.length) break;
        await page.waitForTimeout(150);
      }
      named += result.named;
      missing.push(...result.missing);
    }
  }
  assert.ok(named > 250, `only ${named} named controls were found; the walk is not reaching the pages`);
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
});

test("the i opens the setting's name, what it does and when to change it, and leaves the control alone", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  /* The label names this computer's system once the page knows it, so read the words it shows now. */
  const name = await page.locator("#start-with-windows").evaluate((control) => control.labels[0].textContent.trim());
  assert.match(name, /^Start Branch when I sign in to /);
  assert.equal(await page.getByRole("switch", { name, exact: true }).count(), 1, "the switch keeps its exact name");
  /* A loose lookup by the setting's words finds the switch alone: the i's own name does not repeat them. */
  assert.equal(await page.getByLabel(name).count(), 1, "the i is not found by the setting's words");
  const info = infoFor(page, "#start-with-windows");
  assert.equal(await info.getAttribute("aria-label"), "About this setting");
  assert.equal(await info.evaluate((node) => document.getElementById(node.getAttribute("aria-describedby"))?.textContent.trim()), name,
    "and a screen reader hears which setting it is about");
  const before = await page.locator("#start-with-windows").isChecked();
  await info.click();
  // Codex review of 8b1ed7b5: the explanation is not a dialog, so it is not found by pretending it is.
  // What a screen reader is told about it is held by the accessibility-tree test further down.
  const pop = page.locator(".kit-info-pop");
  await pop.waitFor({ state: "visible" });
  const words = await pop.innerText();
  assert.match(words, new RegExp(`^${name}`));
  assert.match(words, /What this does\s+Branch opens by itself when you sign in/);
  assert.match(words, /When you'd change it\s+If the way it ships \(off\) doesn't suit you\. You can always change it back\./,
    "the sample's sentence, naming the fresh-install value");
  assert.equal(await info.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator("#start-with-windows").isChecked(), before, "pressing the i does not flip the switch");

  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });
  assert.equal(await info.evaluate((node) => document.activeElement === node), true, "Escape gives the keyboard back to the i");
  assert.equal(await page.locator("#settings-window").isVisible(), true, "one Escape closes one thing");

  await info.click();
  await pop.waitFor({ state: "visible" });
  await info.click();
  await pop.waitFor({ state: "hidden" });
  await info.click();
  await pop.waitFor({ state: "visible" });
  await page.mouse.click(5, 500);
  await pop.waitFor({ state: "hidden" });
});

test("a setting with its own reason to change says it", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  await infoFor(page, "#phone-switch").click();
  // Codex review of 8b1ed7b5: the explanation is not a dialog, so it is not found by pretending it is.
  // What a screen reader is told about it is held by the accessibility-tree test further down.
  const pop = page.locator(".kit-info-pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /Switch it on when you want to use Branch from your phone\./);
});

test("the i's words are in English and real French", async () => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  const source = await readFile(join(import.meta.dirname, "..", "public", "settings-describe.js"), "utf8");
  const keys = [...source.matchAll(/"(settings-kit\.info\.[\w.-]+)", "([^"]+)"/g)];
  assert.ok(keys.length >= 7, "the i's words moved out of settings-describe.js");
  for (const [, key, english] of keys) {
    assert.equal(en[key], english, `${key}: en.json should say what settings-describe.js says`);
    assert.ok(fr[key] && fr[key] !== english, `${key} needs real French`);
  }
});

const DEFAULTS = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "settings-defaults.json"), "utf8")).defaults;

test("the way it ships is named in words: a list's own option name, a switch's on or off", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  // Codex review of 8b1ed7b5: the explanation is not a dialog, so it is not found by pretending it is.
  // What a screen reader is told about it is held by the accessibility-tree test further down.
  const pop = page.locator(".kit-info-pop");
  for (const id of ["never-break-mode", "comfort-respectGitignore"]) {
    const shipped = await page.locator(`#${id}`).evaluate((control, raw) => {
      if (control.tagName === "SELECT") return [...control.options].find((option) => option.value === String(raw))?.textContent.trim();
      return raw === true || raw === "on" ? "on" : "off";
    }, DEFAULTS[id]);
    assert.ok(shipped, `${id} has a fresh-install value to name`);
    // The "i" after this control's own label, however the label is tied to it (wrapped or for=).
    await page.locator(`#${id}`).evaluate((control) => [...control.labels].find((label) => label.nextElementSibling?.classList.contains("kit-info")).nextElementSibling.click());
    await pop.waitFor({ state: "visible" });
    assert.ok((await pop.innerText()).includes(`If the way it ships (${shipped}) doesn't suit you.`), `${id}: ${await pop.innerText()}`);
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "hidden" });
  }
});

test("screen control and borrowing the signed-in browser have the sample's own reasons", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "computer");
  // Codex review of 8b1ed7b5: the explanation is not a dialog, so it is not found by pretending it is.
  // What a screen reader is told about it is held by the accessibility-tree test further down.
  const pop = page.locator(".kit-info-pop");
  for (const [id, words] of [["desktop-enabled", /Only when you want Branch to work other programs on this computer for you\./],
    ["browser-attach-enabled", /Only for one task that needs a site you are already signed in to\./]]) {
    const info = infoFor(page, `#${id}`);
    await info.scrollIntoViewIfNeeded();
    await info.click();
    await pop.waitFor({ state: "visible" });
    assert.match(await pop.innerText(), words, id);
    await page.keyboard.press("Escape");
    await pop.waitFor({ state: "hidden" });
  }
});

test("an open explanation follows a language change where it stands", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  await infoFor(page, "#keep-running").click();
  const pop = page.locator(".kit-info-pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /What this does[\s\S]*If the way it ships \(off\)/);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  t.after(() => page.evaluate(async () => (await import("/i18n.js")).setLanguage("en")).catch(() => {}));
  const shipped = fr["settings-kit.info.when.shipped"].replace("{shipped}", fr["settings-kit.info.shipped.off"]);
  await page.waitForFunction((words) => document.querySelector(".kit-info-pop")?.innerText.includes(words), shipped, { timeout: 10000 });
  const words = await pop.innerText();
  assert.ok(words.includes(fr["settings-kit.info.what"]) && words.includes(fr["settings-kit.info.when"]), words);
  assert.ok(!/What this does|When you'd change it/.test(words), "no English left in the open explanation");
  assert.equal(await pop.isVisible(), true, "it stayed open, where it was");
});

test("going straight from one i to another shows the second, with no Escape between", async (t) => {
  const { page } = await fixture(t);
  await openSettings(page, "general");
  const pop = page.locator(".kit-info-pop");
  const first = infoFor(page, "#keep-running"), second = infoFor(page, "#start-minimised");
  await first.click();
  await pop.waitFor({ state: "visible" });
  await second.click();
  await page.waitForFunction(() => /Start quietly/.test(document.querySelector(".kit-info-pop")?.innerText ?? ""));
  assert.equal(await pop.isVisible(), true, "the second explanation is showing");
  assert.equal(await second.getAttribute("aria-expanded"), "true");
  assert.equal(await first.getAttribute("aria-expanded"), "false");
  await page.waitForTimeout(300);
  assert.equal(await pop.isVisible(), true, "and nothing hides it a moment later");
});

test("two presses while the explanation is still loading open nothing, and leave the i closed", async (t) => {
  const { page } = await fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/settings-defaults.json", async (route) => { await held; await route.continue(); });
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await info.click();
  release();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".kit-info-pop").isVisible().catch(() => false), false);
  assert.equal(await info.getAttribute("aria-expanded"), "false");
  await info.click();
  await page.locator(".kit-info-pop").waitFor({ state: "visible" });
});

/** Presses an "i" while its explanation is held back, does `meanwhile`, then lets the answer through. */
async function whileLoading(t, meanwhile) {
  const { page } = await fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let served;
  const answered = new Promise((resolve) => { served = resolve; });
  await page.route("**/settings-defaults.json", async (route) => { await held; await route.continue().finally(served); });
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await meanwhile(page, info);
  // Whether it was ever shown, not only whether it is showing: something may hide it again at once.
  await page.evaluate(() => {
    globalThis.popEverShown = false;
    const plain = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
    Object.defineProperty(HTMLElement.prototype, "hidden", { ...plain, set(value) {
      if (!value && this.classList.contains("kit-info-pop")) globalThis.popEverShown = true;
      plain.set.call(this, value);
    } });
  });
  release();
  // The answer, then a moment for anything waiting on it; bounded, since a cancelled fetch may never answer.
  await Promise.race([answered, page.waitForTimeout(5000)]);
  await page.waitForTimeout(500);
  const visible = await page.evaluate(() => globalThis.popEverShown) || await page.locator(".kit-info-pop").isVisible().catch(() => false);
  return { page, info, visible };
}

test("Escape while the explanation is loading cancels it, even where Escape closes nothing else", async (t) => {
  // Escape also closes Settings, which on its own would leave nothing to open against; here Settings
  // keeps its Escape, so only the cancel itself can stop the popup.
  const { visible, info, page } = await whileLoading(t, async (page, info) => {
    await page.evaluate(() => document.querySelector("#settings-window").addEventListener("keydown", (event) => event.stopPropagation()));
    await info.focus();
    await page.keyboard.press("Escape");
  });
  assert.equal(await page.locator("#settings-window").isVisible(), true, "Settings stayed open");
  assert.equal(visible, false, "Escape while loading must cancel the delayed popup");
  assert.equal(await info.getAttribute("aria-expanded"), "false");
});

test("a press elsewhere, closing Settings, or the i going away while loading opens nothing", async (t) => {
  // A press inside Settings that closes nothing: only the cancel can stop the popup.
  const inside = await whileLoading(t, (page) => page.locator("#settings-window .lx-page:not([hidden]) p").filter({ visible: true }).last().click());
  assert.equal(await inside.page.locator("#settings-window").isVisible(), true, "Settings stayed open");
  assert.equal(inside.visible, false, "a press elsewhere");
  assert.equal((await whileLoading(t, (page) => closeSettings(page))).visible, false, "Settings closed");
  // Gone without a press: nothing to point the popup at.
  assert.equal((await whileLoading(t, (_page, info) => info.evaluate((node) => node.remove()))).visible, false, "the i removed");
  assert.equal((await whileLoading(t, (page) => page.evaluate(() => { document.querySelector("#settings-window").hidden = true; }))).visible, false,
    "Settings hidden without a press");
});

test("a card that draws itself again while the explanation loads still opens it, against the i it has now", async (t) => {
  /* The flake behind #154 on a busy machine: Settings redraws a card (the label is replaced, so infoAll
     drops that label's "i" and gives the new label its own), and the press made just before was dropped
     with nothing on screen. The press belongs to the setting, not to that one button. */
  const { page, info, visible } = await whileLoading(t, async (page) => {
    await page.evaluate(() => {
      // A card drawing its controls again, as renderModels and the Permissions page do: new label, new
      // control with the same name, and the "i" that was pressed is gone with the old ones.
      const card = document.getElementById("keep-running").closest(".card");
      card.replaceChildren(...card.cloneNode(true).childNodes);
    });
    // Settings gives the new label its own "i" before the explanation arrives.
    await page.waitForFunction(() => {
      const control = document.getElementById("keep-running");
      return control?.closest("label")?.nextElementSibling?.classList.contains("kit-info");
    });
  });
  assert.equal(visible, true, "the explanation the owner asked for is shown");
  assert.match(await page.locator(".kit-info-pop").innerText(), /^Keep Branch working when the window is closed/,
    "and it is that setting's own explanation");
  const expandedNow = await page.evaluate(() => [...document.querySelectorAll(".kit-info")].filter((node) => node.getAttribute("aria-expanded") === "true").length);
  assert.equal(expandedNow, 1, "exactly one i says it is open");
  const expanded = await page.evaluate(() => [...document.querySelectorAll(".kit-info")].filter((node) => node.getAttribute("aria-expanded") === "true").length);
  assert.equal(expanded, 1, "exactly one i says it is open");
});

test("a redrawn card whose label names its control by id still opens the explanation", async (t) => {
  /* The harder half of the same race: a `for=` label finds its control by searching the page, so a label
     already taken off the page can name nothing. The "i" carries its own setting from the moment it was
     made, which is what makes this one work. */
  const { page } = await fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let served;
  const answered = new Promise((resolve) => { served = resolve; });
  await page.route("**/settings-defaults.json", async (route) => { await held; await route.continue().finally(served); });
  await openSettings(page, "general");
  await page.locator("#project-folder").waitFor({ state: "visible" });
  await page.evaluate(() => {
    const card = document.getElementById("project-folder").closest(".card");
    document.querySelector('label[for="project-folder"]').nextElementSibling.click(); // its "i", while held
    card.replaceChildren(...card.cloneNode(true).childNodes); // the card draws itself again
  });
  await page.waitForFunction(() => document.querySelector('label[for="project-folder"]')?.nextElementSibling?.classList.contains("kit-info"));
  release();
  await Promise.race([answered, page.waitForTimeout(5000)]);
  await page.locator(".kit-info-pop").waitFor({ state: "visible", timeout: 10000 });
  assert.match(await page.locator(".kit-info-pop").innerText(), /folder/i, "the explanation is that setting's own");
});

test("an open explanation follows its i wherever the page goes, and goes only when the i goes", async (t) => {
  /*
   * The title used to say scrolling the "i" out of sight took the explanation away. It does not, and
   * it must not: the flake behind #154 was the Settings body scrolling a moment after a press, all on
   * its own while the page settled, which shut the explanation that press had just opened. The page
   * moving under you is not you changing your mind. Below: it follows a small scroll, it follows one
   * that carries the "i" clean off the screen, it goes when the "i" is taken off the page, and it goes
   * when the "i" is hidden where it stands.
   */
  const { page } = await fixture(t);
  await openSettings(page, "general");
  const pop = page.locator(".kit-info-pop");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await pop.waitFor({ state: "visible" });
  const before = await pop.boundingBox();
  await page.evaluate(() => { document.getElementById("lx-settings-body").scrollBy(0, 40); });
  await page.waitForTimeout(150);
  assert.equal(await pop.isVisible(), true, "the page moving under it is not a reason to take it away");
  const after = await pop.boundingBox();
  assert.ok(Math.abs((before.y - after.y) - 40) <= 4, `it follows its i (moved ${Math.round(before.y - after.y)} of 40)`);
  assert.equal(await info.getAttribute("aria-expanded"), "true");

  // Scrolled right past, it keeps following its "i" off the screen rather than being taken away mid-read.
  // This is the line the old title contradicted, so it is asserted, not assumed.
  await page.evaluate(() => { document.getElementById("lx-settings-body").scrollBy(0, 4000); });
  await page.waitForTimeout(150);
  const far = await pop.boundingBox();
  const button = await info.boundingBox();
  assert.ok(Math.abs(far.y - (button.y + button.height + 6)) <= 4, "it is still beside its i");
  assert.equal(await info.getAttribute("aria-expanded"), "true");

  // It goes when its "i" goes: the card is drawn again without it.
  await page.evaluate(() => { document.getElementById("keep-running").closest("label").nextElementSibling.remove(); });
  await pop.waitFor({ state: "hidden" });
});

/*
 * The other half of the same rule, which nothing held: "gone" is not only "taken off the page". An
 * "i" hidden where it stands -- a card folded away, a page swapped behind it -- is gone too, and the
 * explanation must not be left standing over a control nobody can see.
 */
test("an explanation goes when its i is hidden where it stands, not only when it is removed", async (t) => {
  const { page, errors } = await fixture(t);
  await openSettings(page, "general");
  const pop = page.locator(".kit-info-pop");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await pop.waitFor({ state: "visible" });
  await page.evaluate(() => { document.getElementById("keep-running").closest(".card").style.display = "none"; });
  await page.evaluate(() => { document.getElementById("lx-settings-body").scrollBy(0, 1); });
  await pop.waitFor({ state: "hidden" });
  assert.equal(await info.getAttribute("aria-expanded"), "false", "the i no longer says it has something open");
  assert.deepEqual(errors, []);
});

/*
 * Codex review of `8b1ed7b5`, blocker 3. The half of "hidden where it stands" that was claimed and
 * not held: checkVisibility answers `display` on its own and has to be asked about `visibility`, so
 * an "i" made invisible where it stands kept its explanation open over it.
 */
test("an explanation goes when its i is made invisible, not only when it is un-displayed", async (t) => {
  const { page, errors } = await fixture(t);
  await openSettings(page, "general");
  const pop = page.locator(".kit-info-pop");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await pop.waitFor({ state: "visible" });
  // The card keeps its place and its size; only its words stop being drawn.
  assert.deepEqual(await page.evaluate(() => {
    const card = document.getElementById("keep-running").closest(".card");
    card.style.visibility = "hidden";
    const button = document.getElementById("keep-running").closest("label").nextElementSibling;
    return [button.getClientRects().length > 0, button.checkVisibility()];
  }), [true, true], "this is the case a plain checkVisibility calls visible; that is the point of the test");
  await page.evaluate(() => { document.getElementById("lx-settings-body").scrollBy(0, 1); });
  await pop.waitFor({ state: "hidden" });
  assert.equal(await info.getAttribute("aria-expanded"), "false");
  assert.deepEqual(errors, []);
});

test("a cancel removes its listeners at once, even when the explanation never arrives", async (t) => {
  const { page } = await fixture(t);
  await page.route("**/settings-defaults.json", () => new Promise(() => {})); // never answered
  // Counts the capture listeners the popup puts on the page for keydown and pointerdown.
  await page.evaluate(() => {
    globalThis.popListeners = 0;
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, fn, options) => { if ((type === "keydown" || type === "pointerdown") && options === true) globalThis.popListeners++; return add(type, fn, options); };
    document.removeEventListener = (type, fn, options) => { if ((type === "keydown" || type === "pointerdown") && options === true) globalThis.popListeners--; return remove(type, fn, options); };
  });
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  const listening = () => page.evaluate(() => globalThis.popListeners);
  await info.click();
  assert.equal(await listening(), 2, "listening while it loads");
  // Settings keeps its Escape here, so only the cancel itself is at work.
  await page.evaluate(() => document.querySelector("#settings-window").addEventListener("keydown", (event) => event.stopPropagation()));
  await info.focus();
  await page.keyboard.press("Escape");
  assert.equal(await listening(), 0, "Escape removed both at once");
  await info.click();
  assert.equal(await listening(), 2);
  await page.locator("#keep-running").locator("xpath=ancestor::section[1]").locator("h2").first().click();
  assert.equal(await listening(), 0, "a press elsewhere removed both at once");
  // Press after press with no answer never piles them up.
  for (let i = 0; i < 3; i++) { await info.click(); await info.focus(); await page.keyboard.press("Escape"); }
  assert.equal(await listening(), 0);
});

/*
 * Codex review of `5eeebba4`, blocker 1. A second press on the same "i" before it opens means
 * "never mind" -- but that press's own cancel listeners watch for a press *outside* its button, so
 * they never fire for it, and the answer they were waiting for may never arrive. Every other press
 * therefore left a keydown and a pointerdown on the document for ever, and the next press added two
 * more: six presses on a dead network left six behind, growing without end.
 */
test("a second press on the same i, while the words never arrive, leaves nothing on the document", async (t) => {
  const { page, errors } = await fixture(t, async (page) => {
    await page.addInitScript(() => {
      globalThis.__docWatch = { added: 0, removed: 0 };
      const add = Document.prototype.addEventListener, drop = Document.prototype.removeEventListener;
      const ours = (node, type) => node === document && (type === "keydown" || type === "pointerdown");
      Document.prototype.addEventListener = function (type, fn, options) {
        if (ours(this, type)) globalThis.__docWatch.added += 1;
        return add.call(this, type, fn, options);
      };
      Document.prototype.removeEventListener = function (type, fn, options) {
        if (ours(this, type)) globalThis.__docWatch.removed += 1;
        return drop.call(this, type, fn, options);
      };
    });
    // The words never arrive: a dead or very slow network, which is the case under review.
    await page.route("**/settings-defaults.json", () => {});
  });
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  await info.waitFor({ state: "visible", timeout: 30000 });
  const start = await page.evaluate(() => ({ ...globalThis.__docWatch }));
  for (let press = 0; press < 6; press++) { await info.click(); await page.waitForTimeout(120); }
  const end = await page.evaluate(() => globalThis.__docWatch);
  const left = (end.added - start.added) - (end.removed - start.removed);
  assert.ok(end.added > start.added, "the presses are meant to install the cancel listeners");
  assert.equal(left, 0, `six presses left ${left} listeners on the document`);
  assert.equal(await page.locator(".kit-info-pop").count() === 0 || await page.locator(".kit-info-pop").isHidden(), true,
    "nothing opened, because the words never came");
  assert.deepEqual(errors, []);
});

/**
 * What a screen reader is actually told, read from the accessibility tree rather than from the
 * attributes. An `aria-describedby` that points at nothing passes an attribute check and says
 * nothing to a person, so the tree is the only honest witness.
 */
async function announced(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
  const node = nodes[0];
  return { role: node?.role?.value, name: node?.name?.value, description: node?.description?.value ?? "" };
}

/*
 * Codex review of `8b1ed7b5`, blocker 2. The explanation holds words about a setting and nothing to
 * do in them, so calling it a dialog told a screen reader to expect something to act on, gave it
 * none, and left the words themselves reachable only by going to look for them.
 */
test("the explanation is the i's own description, and does not pretend to be a dialog", async (t) => {
  const { page, errors } = await fixture(t);
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  await info.click();
  await page.locator(".kit-info-pop").waitFor({ state: "visible" });

  const open = await announced(page, ".lx-page .card .kit-info[aria-expanded=true]");
  assert.equal(open.role, "button", "the i is a button and stays one");
  for (const words of ["What this does", "When you'd change it"])
    assert.ok(open.description.includes(words), `the open explanation is not in what the i says: ${JSON.stringify(open.description)}`);
  assert.ok(await page.evaluate(() => document.querySelector(".kit-info-pop").textContent.trim().length > 40));
  // Compared without spaces: the tree puts one between each block, the DOM's textContent does not.
  const bare = (words) => words.replace(/\s+/g, "");
  const paneWords = await page.locator(".kit-info-pop").evaluate((pane) => pane.textContent);
  assert.equal(bare(open.description), bare(paneWords), "the whole explanation, not a part of it");

  assert.notEqual(await page.locator(".kit-info-pop").getAttribute("role"), "dialog", "it is not a dialog");
  assert.equal(await info.getAttribute("aria-haspopup"), null, "it does not promise a dialog or a menu either");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("kit-info")), true,
    "the keyboard stays on the i; nothing nonmodal may take it");

  // Closed again, the "i" says what it said before -- the explanation is not left in its description.
  await info.click();
  await page.locator(".kit-info-pop").waitFor({ state: "hidden" });
  const shut = await announced(page, ".lx-page .card .kit-info[aria-expanded=false]");
  assert.ok(!shut.description.includes("When you'd change it"), "the explanation outstayed its welcome in the description");
  assert.deepEqual(errors, []);
});

/*
 * Codex review of `8b1ed7b5`, blocker 1. Escape while the words are still loading means "never
 * mind" about the explanation -- and nothing else. Without consuming the key it went on to
 * public/layout.js, which shut Settings: asking for an explanation and changing your mind closed the
 * whole window and left the keyboard nowhere.
 */
test("Escape while the words are loading undoes the press and nothing else", async (t) => {
  const { page, errors } = await fixture(t, async (page) => {
    // The words never arrive, so Escape lands in exactly the window this is about.
    await page.route("**/settings-defaults.json", () => {});
  });
  await openSettings(page, "general");
  const info = infoFor(page, "#keep-running");
  await info.waitFor({ state: "visible", timeout: 30000 });
  await info.click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);

  assert.equal(await page.locator("#settings-window").isHidden(), false, "Escape shut Settings instead of the press");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("kit-info")), true,
    "the keyboard was left nowhere instead of on the i it came from");
  assert.equal(await page.locator(".kit-info-pop").count() === 0 || await page.locator(".kit-info-pop").isHidden(), true,
    "nothing opened: the press was cancelled, not completed");
  assert.equal(await info.getAttribute("aria-expanded"), "false");

  // And a second Escape, with nothing pending, reaches Settings as it always did.
  await page.keyboard.press("Escape");
  await page.locator("#settings-window").waitFor({ state: "hidden", timeout: 10000 });
  assert.deepEqual(errors, []);
});

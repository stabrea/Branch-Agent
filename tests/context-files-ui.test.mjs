/**
 * The switches for the owner's own files, each on the screen that already owns its subject.
 *
 * The tempting build was one screen called "Context files" holding all eight switches. `docs/places.md`
 * says no: a screen named after the implementation is a screen nobody finds. So the test that matters
 * is not "the card exists" but "the card is where a person would look for it", and it gets there the
 * way a person does — clicking through the sidebar and the Settings window, never by asking the layout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettings } from "./places.mjs";

async function fixture(t, seed) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-context-ui-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  /* Files the workspace should already hold are written before the window opens. Writing them
     afterwards would mean reloading the page, and a reload has to sign in again from the session
     store -- which is slower on a loaded build machine than any wait is worth betting on. */
  if (seed) await seed(workspace);
  const provider = { name: "context-ui-fixture", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, workspace, app, server };
}

/* Card id -> the home docs/places.md gives it. The test asks the question a person would ask —
   "is it on that screen when I go there?" — rather than repeating how layout.js names its slots. */
const homes = [
  /* DG-181: the Assistant page says where the three files about the assistant are set; their switches are the
     files' own rows on Instructions & personality (DG-182, tests/settings-instructions-page.test.mjs). */
  ["context-assistant", "settings:assistant"],
  ["context-project", "settings:general"],
  ["context-memory-file", "library:memory"],
  ["context-heartbeat", "automations:scheduled"],
  ["context-sop", "automations:procedures"],
  ["context-tools-file", "customize:skills"],
];

test("each switch is on the screen that already owns its subject, not on a screen of its own", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#context-assistant").waitFor({ state: "attached", timeout: 15000 });

  for (const [id, home] of homes) {
    const card = page.locator("#" + id);
    await openPlace(page, home);
    await card.waitFor({ state: "visible", timeout: 10000 });
    /* DG-181: a card inside a section has its title read aloud only (a screen-reader-only h2). */
    assert.ok((await card.locator("h2").first().textContent()).trim().length > 0, `${id} has a title on ${home}`);
    /* And it is genuinely on that screen rather than everywhere: leaving takes it away again. */
    await openPlace(page, "chat");
    assert.equal(await card.isVisible(), false, `${id} shows only on ${home}`);
  }
  assert.deepEqual(errors, []);
});

test("every switch starts off, and the one you change is the one that is saved", async (t) => {
  const { page, errors, app } = await fixture(t,
    (workspace) => writeFile(join(workspace, "AGENTS.md"), "Ask before you rename anything.", "utf8"));
  await openSettings(page, "general");
  const card = page.locator("#context-project");
  await card.waitFor();

  const chooser = card.locator("#context-switch-agents");
  assert.equal(await chooser.inputValue(), "off", "nothing is on out of the box");
  assert.match(await card.innerText(), /AGENTS\.md/, "the file it found is named");

  await chooser.selectOption("when-needed");
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await card.locator("[role=status]").filter({ hasText: "Saved" }).waitFor();

  const settings = app.store.get("settings", "local", "context-files")?.data;
  assert.deepEqual(settings.files, { agents: "when-needed" }, "only the switch that moved was written");
  assert.deepEqual(errors, []);
});

test("the cards hold their shape at 400 px, and nothing scrolls sideways", async (t) => {
  const { page, errors } = await fixture(t);
  await page.setViewportSize({ width: 400, height: 900 });
  await openSettings(page, "general");
  await page.locator("#context-project").waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false, "the page does not scroll sideways at 400 px");
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two steps
  // (find the element, then measure it) can land on one that was just replaced (null on a busy runner).
  for (const key of ["agents"]) {
    const fits = await page.waitForFunction((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box && box.width > 0 && box.width <= 400;
    }, `#context-switch-${key}`, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(fits, `the ${key} switch fits the window`);
  }
  assert.deepEqual(errors, []);
});

test("every word on these cards can be said in French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#context-assistant").waitFor({ state: "attached", timeout: 15000 });
  const missing = await page.evaluate((ids) => {
    const out = [];
    for (const id of ids) {
      const card = document.getElementById(id);
      if (!card) { out.push(`${id} missing`); continue; }
      /* A status note is assembled from a file's own name and size, so it has no static key; it is
         still translated, through t(), and the card is drawn again when the language changes. */
      for (const node of card.querySelectorAll("h2, p:not(.field-note), label, option, button"))
        if (!node.dataset.t && node.textContent.trim()) out.push(`${id}: "${node.textContent.trim().slice(0, 40)}"`);
    }
    return out;
  }, homes.map(([id]) => id));
  assert.deepEqual(missing, [], "every word on a card carries a data-t key");

  const keys = await page.evaluate((ids) => ids.flatMap((id) =>
    [...(document.getElementById(id)?.querySelectorAll("[data-t]") ?? [])].map((node) => node.dataset.t)),
  homes.map(([id]) => id));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const notes = ["settings.file.off", "settings.file.missing", "settings.file.carried",
    "settings.file.announced", "settings.file.no-room", "settings.file.permission-shaped"];
  const untranslated = [...new Set([...keys, ...notes])].filter((key) => !french[key]);
  assert.deepEqual(untranslated, [], "and every one of those keys has real French");

  /* The note under a switch says something, and never the word "null" where a file name should be. */
  const note = await page.locator("#context-project .field-note").first().innerText();
  assert.ok(note.trim().length > 0 && !note.includes("null"), `the note reads as a sentence (${note})`);
  assert.deepEqual(errors, []);
});

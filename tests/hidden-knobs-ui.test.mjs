/**
 * R17-S-B: the knob cards open where docs/places.md says, every control is described by its own
 * sentence, a change saved on the screen reaches the server, and "Put back as shipped" undoes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readKnobs } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { startServer } from "../dist/server.js";
import { openPlace, openSettingFor, pressUntil } from "./places.mjs";

const homes = {
  "knobs-compaction-card": "#lx-models-defaults",
  "knobs-subtasks-card": "#lx-models-defaults",
  "knobs-reasoning-card": "#lx-models-defaults",
  "knobs-limits-card": "#lx-page-permissions",
  "knobs-leak-guard-card": "#lx-page-permissions",
  "knobs-retries-card": "#lx-page-advanced",
  "knobs-tools-card": "#lx-page-advanced",
  "knobs-commands-card": "#lx-page-computer",
  "knobs-launch-file-card": "#lx-page-computer",
  "knobs-show-reasoning-card": "#lx-page-appearance",
};

async function openApp(t, width = 1280) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-knobs-ui-"));
  const launchFile = join(root, "integrations.json");
  await writeFile(launchFile, JSON.stringify({ browser: { allowedOrigins: ["https://example.com"] } }));
  const before = process.env.BRANCH_INTEGRATIONS;
  process.env.BRANCH_INTEGRATIONS = launchFile;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
    if (before === undefined) delete process.env.BRANCH_INTEGRATIONS; else process.env.BRANCH_INTEGRATIONS = before;
  });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  const token = page.getByLabel("Session token", { exact: true });
  await token.waitFor({ state: "visible", timeout: 120000 });
  await token.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#knobs-launch-file-card").waitFor({ state: "attached" });
  return { app, page, launchFile };
}

/** Every visible control in the card, and whether the sentence it points at has words. */
const undescribed = (page, id) => page.evaluate((cardId) => {
  const card = document.getElementById(cardId);
  return [...card.querySelectorAll("input, select, textarea")].filter((control) => {
    const note = document.getElementById(control.getAttribute("aria-describedby") ?? "");
    return !note || !note.textContent.trim();
  }).map((control) => control.id);
}, id);

for (const width of [1440, 860, 400]) {
  test(`DG-008 knob Settings headings preserve hierarchy and descriptions at ${width}px`, async (t) => {
    const { page } = await openApp(t, width);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const language of ["en", "fr"]) {
      await page.evaluate(async (lang) => (await import("/i18n.js")).setLanguage(lang), language);
      await page.evaluate(() => globalThis.branchKnobs.refresh());
      for (const id of Object.keys(homes)) {
        await openSettingFor(page, `#${id}`);
        const card = page.locator(`#${id}`), heading = card.locator(":scope > [data-t]").first();
        assert.equal(await heading.evaluate((node) => node.tagName), "H3", id);
        const name = (await heading.textContent()).trim();
        assert.ok(name && !name.startsWith("knobs."), `${id} has translated copy`);
        assert.equal(await card.getByRole("heading", { level: 3, name, exact: true }).count(), 1);
        assert.equal(await card.evaluate((node) => node.closest(".lx-page").querySelectorAll(":scope > h2.lx-page-title").length), 1);
        assert.equal(await card.locator(":scope > h3.settings-card-title + p.subtle + .kit-scope.sr-only").count(), 1);
        assert.deepEqual(await undescribed(page, id), []);
        assert.deepEqual(await heading.evaluate((node) => {
          const css = getComputedStyle(node);
          return [css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing, css.margin];
        }), ["16px", "640", "20.8px", "normal", "0px 0px 6px"]);
      }
      await openSettingFor(page, "#knobs-reasoning-card");
      const subsection = page.locator('#knobs-reasoning-card > [data-t="knobs.field.effortByModel"]');
      assert.equal(await subsection.evaluate((node) => node.tagName), "H4");
      assert.equal(await page.locator("#knobs-reasoning-card").getByRole("heading", {
        level: 4, name: (await subsection.textContent()).trim(), exact: true,
      }).count(), 1);
      assert.equal(await page.locator("#knobs-memory-card > h2").count(), 1, "Library heading is unchanged");
    }
    assert.deepEqual(errors, []);
  });
}

test("each knob card is in its home, every control has its own sentence, and saving reaches the server", async (t) => {
  const { app, page, launchFile } = await openApp(t);
  for (const [id, host] of Object.entries(homes)) {
    await page.waitForFunction(([card, slot]) => document.getElementById(card)?.closest(slot), [id, host]);
    await openSettingFor(page, `#${id}`);
    assert.ok(await page.locator(`#${id}`).isVisible(), `${id} can be seen on its page`);
    assert.equal(await page.locator(`#${id} > h3.settings-card-title + p.subtle`).count(), 1, `${id} says what it is for`);
    assert.deepEqual(await undescribed(page, id), [], `${id} has a control without a sentence`);
  }
  await openPlace(page, "memory");
  await page.waitForFunction(() => document.getElementById("knobs-memory-card")?.closest("#memory"));
  assert.ok(await page.locator("#knobs-memory-card").isVisible(), "the memory card is in Library, Memory");
  assert.deepEqual(await undescribed(page, "knobs-memory-card"), []);

  await openSettingFor(page, "#knobs-limits-card");
  await page.locator("#knobs-maxSteps").fill("25");

  // Wait for the save response before checking status
  let saveResp = page.waitForResponse((response) => response.url().endsWith("/api/knobs")
    && response.request().method() === "POST", { timeout: 20000 });
  await page.locator("#knobs-limits-card").getByRole("button", { name: "Save", exact: true }).click();
  await saveResp;
  await page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Saved" })
    .waitFor({ state: "visible", timeout: 10000 });

  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 25);

  // Wait for the reset response before checking status
  saveResp = page.waitForResponse((response) => response.url().endsWith("/api/knobs")
    && response.request().method() === "POST", { timeout: 20000 });
  await page.locator("#knobs-limits-card").getByRole("button", { name: "Put back as shipped", exact: true }).click();
  await saveResp;
  await page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Put back" })
    .waitFor({ state: "visible", timeout: 10000 });

  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 60);
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "60");

  await openSettingFor(page, "#knobs-commands-card");
  await page.locator("#knobs-passEnvironment").fill("OPENAI_API_KEY");

  // Wait for the save to attempt and fail validation
  const saveResponse = page.waitForResponse((response) => response.url().endsWith("/api/knobs")
    && response.request().method() === "POST", { timeout: 20000 });
  await page.locator("#knobs-commands-card").getByRole("button", { name: "Save", exact: true }).click();
  const response = await saveResponse;
  assert.equal(response.status(), 400, "Save should be rejected with validation error");

  // Verify the status message appears on the live card
  await page.locator("#knobs-commands-card [role=status]").filter({ hasText: "never handed to commands" })
    .waitFor({ state: "visible", timeout: 10000 });
  assert.deepEqual(readKnobs(app.store, "local", "commands").passEnvironment, []);

  await openSettingFor(page, "#knobs-launch-file-card");
  await page.locator("#knobs-launch-browserSites").fill("https://example.com\nhttps://docs.example.org");

  // Wait for the save response before checking status
  const launchResp = page.waitForResponse((response) => response.url().endsWith("/api/knobs/launch-file")
    && response.request().method() === "POST", { timeout: 20000 });
  await page.locator("#knobs-launch-file-card").getByRole("button", { name: "Save for the next start", exact: true }).click();
  await launchResp;
  await page.locator("#knobs-launch-file-card [role=status]").filter({ hasText: "next time it starts" })
    .waitFor({ state: "visible", timeout: 10000 });

  assert.deepEqual(JSON.parse(await readFile(launchFile, "utf8")).browser.allowedOrigins, ["https://example.com", "https://docs.example.org"]);
});

test("an unchanged refresh cannot replace a knob value while it is being typed", async (t) => {
  const { page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  let captured, release;
  const responseCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/api/knobs", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    captured();
    await released;
    await route.fulfill({ response });
  });
  const refreshing = page.evaluate(() => globalThis.branchKnobs.refresh());
  await responseCaptured;
  await page.locator("#knobs-maxSteps").fill("25");
  await page.evaluate(() => document.activeElement?.blur());
  release();
  await refreshing;
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "25");
});

test("a language redraw cannot replace an unsaved launch-file list", async (t) => {
  const { page } = await openApp(t);
  await openSettingFor(page, "#knobs-launch-file-card");
  const sites = page.locator("#knobs-launch-browserSites");
  const draft = "https://example.com\nhttps://docs.example.org";
  await sites.evaluate((control, value) => {
    control.value = value;
    control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    document.dispatchEvent(new CustomEvent("branch-language"));
  }, draft);
  assert.equal(await sites.inputValue(), draft);
  assert.equal(await sites.getAttribute("data-knob-dirty"), "true", "the redraw preserves the draft marker too");
});

test("a stale Save button submits the visible launch-file draft after a redraw", async (t) => {
  const { page, launchFile } = await openApp(t);
  await openSettingFor(page, "#knobs-launch-file-card");
  const staleSave = await page.locator("#knobs-launch-file-card")
    .getByRole("button", { name: "Save for the next start", exact: true }).elementHandle();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-language")));
  const draft = "https://example.com\nhttps://docs.example.org";
  await page.locator("#knobs-launch-browserSites").fill(draft);
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/knobs/launch-file")
    && response.request().method() === "POST", { timeout: 20000 });
  await staleSave.evaluate((button) => button.click());
  const response = await saved;
  assert.equal(response.ok(), true, "the stale button's save request completed");
  assert.deepEqual(response.request().postDataJSON().browserSites,
    ["https://example.com", "https://docs.example.org"], "the request contains the visible draft");
  assert.deepEqual(JSON.parse(await readFile(launchFile, "utf8")).browser.allowedOrigins,
    ["https://example.com", "https://docs.example.org"]);
});

test("a stale Save button submits the visible knob draft after a redraw", async (t) => {
  const { app, page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  const staleSave = await page.locator("#knobs-limits-card")
    .getByRole("button", { name: "Save", exact: true }).elementHandle();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-language")));
  await page.locator("#knobs-maxSteps").fill("25");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/knobs")
    && response.request().method() === "POST", { timeout: 20000 });
  await staleSave.evaluate((button) => button.click());
  const response = await saved;
  assert.equal(response.ok(), true, "the stale button's save request completed");
  assert.equal(response.request().postDataJSON().values.maxSteps, 25, "the request contains the visible draft");
  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 25);
});

test("a focused clean control stays clean across redraws and accepts the next server value", async (t) => {
  const { app, page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  const steps = page.locator("#knobs-maxSteps");
  await steps.focus();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-language")));
  assert.equal(await steps.getAttribute("data-knob-dirty"), null);
  assert.equal(await steps.inputValue(), "60");
  await steps.evaluate((control) => control.blur());
  saveKnobs(app.store, "local", "limits", { maxSteps: 25 });
  await page.evaluate(() => globalThis.branchKnobs.refresh());
  await page.waitForFunction(() => document.getElementById("knobs-maxSteps")?.value === "25");
  assert.equal(await steps.inputValue(), "25");
});

test("a refresh that started before Save cannot redraw over the saved value or receipt", async (t) => {
  const { app, page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  let captured, release, capturedPost;
  const responseCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const postCaptured = new Promise((resolve) => { capturedPost = resolve; });
  let posted;
  let held = false;
  await page.route("**/api/knobs", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      capturedPost();
      return route.continue();
    }
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    captured();
    await released;
    await route.fulfill({ response });
  });
  const refreshing = page.evaluate(() => globalThis.branchKnobs.refresh());
  await responseCaptured;
  await page.evaluate(() => {
    const input = document.getElementById("knobs-maxSteps");
    input.value = "25";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "25" }));
    [...document.querySelectorAll("#knobs-limits-card button")]
      .find((button) => button.textContent.trim() === "Save").click();
  });
  await postCaptured;
  assert.equal(posted.values.maxSteps, 25, "the save request contains the value under test");
  const receipt = page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Saved" });
  await receipt.waitFor({ state: "visible", timeout: 20000 });
  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 25, "the value is saved before the old response is released");
  release();
  await refreshing;
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "25");
  assert.equal(await receipt.isVisible(), true, "the stale response did not erase the save receipt");
});

test("a refresh completed while Save is in flight cannot redraw an older value", async (t) => {
  const { page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  let captured, release;
  const saveCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/knobs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    captured();
    await released;
    await route.continue();
  });
  await page.evaluate(() => {
    const input = document.getElementById("knobs-maxSteps");
    input.value = "25";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "25" }));
    document.querySelector("#knobs-limits-card button").click();
  });
  await saveCaptured;
  await page.evaluate(() => globalThis.branchKnobs.refresh());
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "25");
  release();
  await page.locator("#knobs-limits-card [role=status]").filter({ hasText: "Saved" })
    .waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "25");
});

test("an edit on a language-redrawn control made after Save stays dirty and survives the saved response", async (t) => {
  const { app, page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  let captured, release;
  const responseCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/knobs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    captured();
    await released;
    await route.fulfill({ response });
  });
  const steps = page.locator("#knobs-maxSteps");
  await steps.fill("25");
  await page.locator("#knobs-limits-card").getByRole("button", { name: "Save", exact: true }).evaluate((button) => button.click());
  await responseCaptured;
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("branch-language")));
  await steps.fill("30");
  await steps.evaluate((control) => control.blur());
  release();
  for (let attempt = 0; attempt < 400 && readKnobs(app.store, "local", "limits").maxSteps !== 25; attempt++)
    await page.waitForTimeout(25);
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "30");
  assert.equal(await page.locator("#knobs-maxSteps").getAttribute("data-knob-dirty"), "true");
});

test("overlapping saves on different cards keep both values and clear both drafts", async (t) => {
  const { app, page } = await openApp(t);
  await openSettingFor(page, "#knobs-limits-card");
  let captured, release;
  const firstCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let held = false, posted, responseStatus;
  await page.route("**/api/knobs", async (route) => {
    const body = route.request().postDataJSON?.();
    if (route.request().method() !== "POST" || body?.card !== "limits" || held) return route.continue();
    held = true;
    posted = body;
    const response = await route.fetch();
    responseStatus = response.status();
    captured();
    await released;
    await route.fulfill({ response });
  });
  await page.locator("#knobs-limits-card").evaluate((card) => {
    const control = card.querySelector("#knobs-maxSteps");
    control.value = "25";
    control.dispatchEvent(new Event("input", { bubbles: true }));
    [...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "Save").click();
  });
  await firstCaptured;
  assert.equal(posted.values.maxSteps, 25, "the held request contains the edit under test");
  assert.equal(responseStatus, 200, "the held request reached the server successfully");
  await page.locator("#knobs-sensitivity").evaluate((control) => {
    control.value = "strict";
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#knobs-leak-guard-card").getByRole("button", { name: "Save", exact: true }).evaluate((button) => button.click());
  await page.locator("#knobs-leak-guard-card [role=status]").filter({ hasText: "Saved" }).waitFor({ timeout: 20000 });
  release();
  for (let attempt = 0; attempt < 400; attempt++) {
    if (readKnobs(app.store, "local", "limits").maxSteps === 25
      && readKnobs(app.store, "local", "leakGuard").sensitivity === "strict") break;
    await page.waitForTimeout(25);
  }
  assert.equal(readKnobs(app.store, "local", "limits").maxSteps, 25);
  assert.equal(readKnobs(app.store, "local", "leakGuard").sensitivity, "strict");
  await page.evaluate(() => globalThis.branchKnobs.refresh());
  await page.waitForFunction(() => document.querySelectorAll(
    "#knobs-limits-card [data-knob-dirty], #knobs-leak-guard-card [data-knob-dirty]",
  ).length === 0);
  assert.equal(await page.locator("#knobs-maxSteps").inputValue(), "25");
  assert.equal(await page.locator("#knobs-sensitivity").inputValue(), "strict");
  assert.equal(await page.locator("#knobs-limits-card [data-knob-dirty], #knobs-leak-guard-card [data-knob-dirty]").count(), 0);
});

test("at 400 px the knob cards fit without sideways scrolling", async (t) => {
  const { page } = await openApp(t, 400);
  for (const id of ["knobs-leak-guard-card", "knobs-commands-card", "knobs-reasoning-card"]) {
    await openSettingFor(page, `#${id}`);
    const box = await page.locator(`#${id}`).evaluate((card) => ({ scroll: card.scrollWidth, client: card.clientWidth }));
    assert.ok(box.scroll <= box.client + 1, `${id} is wider than its card (${box.scroll} > ${box.client})`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${id} scrolls the page sideways`);
  }
});

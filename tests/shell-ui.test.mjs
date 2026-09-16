import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const SECTIONS = [
  "Conversation",
  "Activity",
  "Usage",
  "Memory",
  "Skills",
  "Specialists",
  "Procedures",
  "Schedules",
  "Settings",
];

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-shell-ui-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  return { page, server, errors };
}
const look = (page) => page.evaluate(() => ({ ...document.documentElement.dataset }));

test("every section opens from the icon column in one click, with no drop-down", async (t) => {
  const f = await fixture(t);
  assert.equal(
    await f.page.locator("select").filter({ hasText: "Memory" }).count(),
    0,
    "sections must not live in a drop-down",
  );
  for (const name of SECTIONS) {
    await f.page.getByRole("button", { name, exact: true }).click();
    await f.page.locator("#page-title").filter({ hasText: name }).waitFor();
  }
  assert.deepEqual(f.errors, []);
});

test("the command palette jumps to a section and closes on Escape", async (t) => {
  const f = await fixture(t);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.locator("#cmd-input").fill("Schedu");
  await f.page.locator(".cmd-item").first().click();
  assert.match(await f.page.locator("#page-title").innerText(), /Schedules/);
  await f.page.keyboard.press("Control+k");
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#cmd-input").waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("all seven appearance controls apply at once and survive a reload", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: "Settings", exact: true }).click();
  await f.page.getByLabel("Appearance", { exact: true }).selectOption("daylight");
  await f.page.getByRole("button", { name: "Slate", exact: true }).click();
  await f.page.getByRole("button", { name: "Large", exact: true }).click();
  await f.page.getByRole("button", { name: "Compact", exact: true }).click();
  await f.page.getByRole("button", { name: "This computer's lettering", exact: true }).click();
  await f.page.locator("#appearance-motion").check();
  await f.page.locator("#appearance-acorn").uncheck();
  const chosen = {
    theme: "daylight",
    accent: "slate",
    textSize: "large",
    density: "compact",
    font: "system",
    motion: "reduced",
    acorn: "off",
  };
  assert.deepEqual(await look(f.page), chosen, "every choice shows straight away");
  assert.equal(await f.page.locator(".acorn-art").isVisible(), false);
  await f.page.getByRole("button", { name: "Save appearance", exact: true }).click();
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  await f.page.waitForFunction(() => document.documentElement.dataset.accent === "slate");
  assert.deepEqual(await look(f.page), chosen, "the same look comes back after a reload");
  assert.deepEqual(f.errors, []);
});

test("an unknown appearance value is refused and the saved look is unchanged", async (t) => {
  const f = await fixture(t);
  const send = (body) =>
    fetch(new URL("/api/preferences", f.server.url), {
      method: "POST",
      headers: {
        authorization: "Bearer " + f.server.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await send({ appearance: "midnight" })).ok, false);
  assert.equal((await send({ accent: "purple" })).ok, false);
  const kept = await (await send({ appearance: "daylight" })).json();
  assert.equal(kept.accent, "copper", "fields left out keep their defaults");
  assert.equal(kept.showAcorn, true);
});

test("the shell fits a 400 pixel window without sideways scrolling", async (t) => {
  const f = await fixture(t);
  await f.page.setViewportSize({ width: 400, height: 800 });
  assert.equal(
    await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  /* On a narrow window the rail slides over the page, so it is opened first. */
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  await f.page.getByRole("button", { name: "Memory", exact: true }).click();
  assert.match(await f.page.locator("#page-title").innerText(), /Memory/);
  assert.equal(
    await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.deepEqual(f.errors, []);
});

test("a rail folded away on a wide window still opens on a narrow one", async (t) => {
  const f = await fixture(t);
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  assert.equal(await f.page.locator("#conversation-rail").isVisible(), false);
  await f.page.reload();
  await f.page.locator("#workspace").waitFor({ state: "visible" });
  await f.page.setViewportSize({ width: 400, height: 800 });
  assert.equal(await f.page.locator("#conversation-rail").isVisible(), false);
  await f.page.getByRole("button", { name: "Conversations", exact: true }).click();
  await f.page.locator("#conversation-rail").waitFor({ state: "visible" });
  await f.page.getByRole("button", { name: "Find anything Ctrl K" }).click();
  await f.page.locator("#cmd-input").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

test("this computer's reduce-motion setting is honoured before anyone opens Appearance", async (t) => {
  const f = await fixture(t);
  const speed = () =>
    f.page
      .locator("#update-bar")
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).transitionDuration));
  assert.equal(
    await f.page.evaluate(() => "motion" in document.documentElement.dataset),
    false,
    "nothing is written until the owner asks for stillness",
  );
  assert.equal(await speed(), 0.3, "normally things move");
  await f.page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await speed()) < 0.01, true, "this computer's setting switches it off");
  await f.page.emulateMedia({ reducedMotion: "no-preference" });
  await f.page.locator("#appearance-shortcut").click();
  await f.page.locator("#appearance-motion").check();
  assert.equal((await speed()) < 0.01, true, "so does the Appearance choice");
  assert.deepEqual(f.errors, []);
});

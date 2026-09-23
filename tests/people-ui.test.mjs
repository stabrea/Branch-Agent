/**
 * Bucket 19: the owner's "Signing in from other devices" card (public/people-admin.js) and the page
 * a person signs in on (public/people.html), opened the way a person opens them. Headless browser
 * only; a scripted provider stands in for every model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "claude-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-people-ui-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello from Branch.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  app.store.profiles.create({ name: "Ada", pin: "1234" });
  return { app, server, browser, page, errors, width };
}

async function connect({ page, server }) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#people-signin-admin").waitFor({ state: "attached", timeout: 15000 });
}

test("P1 the card is in Settings → General, starts off, has one filled button, and saves the switch as it changes", async (t) => {
  const f = await fixture(t);
  await connect(f);
  const card = f.page.locator("#people-signin-admin");
  await openPlace(f.page, "settings:general");
  await card.waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await card.locator("h2").innerText(), "Signing in from other devices");
  assert.equal(await card.locator("#people-admin-mode").inputValue(), "off");
  assert.equal(await card.locator("button:not(.quiet-button):not(.sg-more)").count(), 1, "one filled button"); // "N more" can end the card (DG-199)
  assert.equal(await card.locator("[data-person] strong").innerText(), "Ada");
  /* DG-180: the switch saves as it changes (Save is for the hours and the checks), and the keyboard stays on it. */
  const before = await card.elementHandle();
  await card.locator("#people-admin-mode").selectOption("on");
  /* Saved, and drawn again from what was saved, with the keyboard back on the switch. */
  await f.page.waitForFunction((old) => { const now = document.querySelector("#people-signin-admin");
    return now && now !== old && now.querySelector("#people-admin-mode").value === "on" && document.activeElement?.id === "people-admin-mode"; }, before);
  assert.equal(f.app.people.settings().mode, "on");
  await openPlace(f.page, "chat");
  assert.equal(await card.isVisible(), false);
  assert.deepEqual(f.errors, []);
});

test("P2 at 400 px the card fits and every word has a key with real French", async (t) => {
  const f = await fixture(t, 400);
  await connect(f);
  await openPlace(f.page, "settings:general");
  await f.page.locator("#people-signin-admin").waitFor({ state: "visible" });
  const wide = await f.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  // Measured inside the page in one step: the card redraws itself, and a box asked for in two
  // steps (find the element, then measure it) can land on one that was just replaced (null).
  const fits = await f.page.waitForFunction(() => {
    const box = document.querySelector("#people-admin-mode")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the people admin switch fits inside 400 px");
  const unkeyed = await f.page.evaluate(() => [...document.querySelectorAll("#people-signin-admin h2, #people-signin-admin p, #people-signin-admin label, #people-signin-admin button, #people-signin-admin span")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t && !node.dataset.tDrawn && !("given" in node.dataset) && !node.closest("[data-person]") && !node.closest(".sg-more-line") && node.getAttribute("aria-live") !== "polite")
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, []);
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const ours = Object.keys(english).filter((key) => key.startsWith("people."));
  assert.ok(ours.length >= 90);
  for (const key of ours) {
    assert.ok(french[key], `${key} has French`);
    assert.notEqual(french[key], english[key], `${key} is really translated`);
  }
  assert.deepEqual(f.errors, []);
});

test("P3 a person signs in on the page with their PIN, talks, and sees only their own", async (t) => {
  const f = await fixture(t, 400);
  await f.app.people.parts.store.save("settings", f.app.runtime.owner, "people-signin", { mode: "on" });
  const owners = await f.app.runtime.run({ prompt: "the owner's own words" });
  const phone = await f.browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  phone.on("pageerror", (error) => errors.push(error.message));
  await phone.goto(`${f.server.url}/people`);
  await phone.getByLabel("Your name").first().fill("Ada");
  await phone.getByRole("button", { name: "Next" }).click();
  await phone.getByLabel("Your PIN").fill("1234");
  await phone.getByRole("button", { name: "Check my PIN" }).click();
  await phone.getByText("Hello, Ada").waitFor();
  // mac7/linux-fixes: isVisible() asks whether it is on the page this instant and never waits,
  // so on a slow machine this read the list before it had drawn. waitFor() asks the same
  // question and gives the page time to answer.
  await phone.getByText("Nothing yet. Start a conversation below.").waitFor();
  await phone.getByRole("button", { name: "New conversation" }).click();
  await phone.getByLabel("Your message").fill("what is on today?");
  await phone.getByRole("button", { name: "Send" }).click();
  await phone.getByText("Hello from Branch.").waitFor();
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  assert.equal(await phone.getByText("the owner's own words").count(), 0);
  // The key stays in the tab, never in the address.
  assert.doesNotMatch(phone.url(), /branch_person_/);
  assert.ok(f.app.store.recentSessions(`profile:${f.app.store.profiles.list()[0].id}`).sessions.length === 1);
  assert.ok(owners.sessionId);
  assert.deepEqual(errors, []);
});

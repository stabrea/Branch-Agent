/* household-followups: while the window is on somebody else's profile, the title bar says whose, in
   the calm window and the full one, with a way back that asks the owner's PIN when it is set. Nothing
   shows while the window is the owner's. (public/collab.js showProfileBadge, public/index.html) */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { closeSettings, openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const shots = process.env.BRANCH_TEST_SHOTS; // headless screenshots, only when a folder is named

async function fixture(t, everything) {
  const root = await mkdtemp(join(tmpdir(), "branch-profile-badge-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  await call("/api/onboarding", { done: true });
  if (everything) await call("/api/preferences", { showEverything: true });
  const sam = (await call("/api/profiles", { name: "Sam", pin: "2468" })).body;
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction((on) => document.documentElement.dataset.everything === (on ? "on" : "off"), everything);
  return { app, call, page, errors, sam };
}

for (const everything of [false, true]) {
  const layout = everything ? "full" : "calm";
  test(`${layout} window: the title bar says whose profile it is, and switches back`, async (t) => {
    const f = await fixture(t, everything);
    const badge = f.page.locator("#profile-badge");
    assert.equal(await badge.isVisible(), false, "nothing shows while the window is the owner's");
    assert.equal((await f.call("/api/profiles/switch", { profileId: f.sam.id, pin: "2468" })).status, 200);
    await badge.waitFor({ state: "visible", timeout: 15000 });
    assert.match(await badge.innerText(), /Sam/);
    assert.equal(await badge.locator(".profile-avatar").innerText(), "S");
    if (shots) await f.page.screenshot({ path: join(shots, `profile-badge-${layout}.png`) });
    await badge.getByRole("button", { name: "Switch back" }).click();
    await badge.waitFor({ state: "hidden", timeout: 15000 });
    assert.equal(f.app.store.profiles.isOwner(), true);
    assert.deepEqual(f.errors, []);
  });
}

test("with the owner's PIN set, the title bar's way back asks for it", async (t) => {
  const f = await fixture(t, false);
  await f.call("/api/profiles/owner-pin", { pin: "9753" });
  await f.call("/api/profiles/switch", { profileId: f.sam.id, pin: "2468" });
  const badge = f.page.locator("#profile-badge");
  await badge.waitFor({ state: "visible", timeout: 15000 });
  const pin = badge.getByLabel("The owner's PIN");
  await pin.fill("0000");
  await badge.getByRole("button", { name: "Switch back" }).click();
  await f.page.getByText("That PIN is not right").first().waitFor({ state: "visible" });
  assert.equal(f.app.store.profiles.isOwner(), false, "a wrong PIN let the window back to the owner");
  if (shots) await f.page.screenshot({ path: join(shots, "profile-badge-pin.png") });
  await pin.fill("9753");
  await badge.getByRole("button", { name: "Switch back" }).click();
  await badge.waitFor({ state: "hidden", timeout: 15000 });
  assert.equal(f.app.store.profiles.isOwner(), true);
});

test("on somebody else's profile the window stops asking for the owner's chat apps, and asks again once back", async (t) => {
  const f = await fixture(t, false);
  const asked = [];
  f.page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(channels|channel-setup|secrets)(\/|$)/.test(path)) asked.push(path);
  });
  const said = [];
  f.page.on("console", (message) => { if (message.type() === "error") said.push(message.text()); });
  /* The owner opens the chat apps, so their cards and the Telegram panel are on the page. */
  await openPlace(f.page, "customize:channels");
  await f.page.locator("#channel-setup-card h2").waitFor({ state: "visible", timeout: 15000 });
  await closeSettings(f.page);

  await f.call("/api/profiles/switch", { profileId: f.sam.id, pin: "2468" });
  await f.page.locator("#profile-badge").waitFor({ state: "visible", timeout: 15000 });
  asked.length = 0;
  /* Settings opened again, and two of the window's own three-second refreshes. */
  await openPlace(f.page, "customize:channels");
  await f.page.waitForTimeout(7000);
  assert.deepEqual(asked, [], "the window kept asking for the owner's chat apps and locker");
  assert.equal(await f.page.locator("#channel-setup-card h2").count(), 0, "the owner's chat-app setup stayed on the page");
  await closeSettings(f.page);

  await f.page.locator("#profile-badge").getByRole("button", { name: "Switch back" }).click();
  await f.page.locator("#profile-badge").waitFor({ state: "hidden", timeout: 15000 });
  await f.page.waitForFunction(() => document.querySelector("#channel-setup-card h2"), null, { timeout: 15000 });
  assert.ok(asked.some((path) => path.startsWith("/api/channel-setup")), "the chat-app setup was not loaded again");
  assert.deepEqual(f.errors, [], "an expected refusal surfaced as a page error");
  assert.deepEqual(said.filter((line) => /belongs to the owner/.test(line)), []);
});

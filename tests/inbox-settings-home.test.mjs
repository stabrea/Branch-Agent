/* DG-139: the Inbox keeps to what waits for you and what happened; each of its settings lives on
   Settings › Automations & inbox, as the approved sample has it. Headless only, 127.0.0.1, a temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace, pressUntil, showEverything } from "./places.mjs";

const { SETTINGS_INDEX } = await import("../public/settings-index.js");
const MOVED = { "flows-switch-install-requests": "flows-installs-settings-card", "recordings-mode": "recordings-settings-card", "recordings-pictures": "recordings-settings-card" };
const quiet = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-inbox-settings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false), "the window to connect");
  return { app, page, errors };
}
/** Every setting control drawn inside the Inbox's tabs, by id. */
const inboxControls = (page) => page.evaluate((ids) => ids.filter((id) => document.getElementById(id)?.closest('.lx-panel[data-place="inbox"]')),
  SETTINGS_INDEX.map((row) => row[0]));
const settingsPageOf = (page, id) => page.evaluate((id) => document.getElementById(id)?.closest(".lx-page")?.dataset.page ?? null, id);

test("no setting lives in the Inbox: search sends each one to Settings › Automations & inbox", () => {
  assert.deepEqual(SETTINGS_INDEX.filter((row) => row[1].startsWith("inbox:")).map((row) => row[0]), []);
  for (const [id, card] of Object.entries(MOVED)) {
    const row = SETTINGS_INDEX.find((entry) => entry[0] === id);
    assert.deepEqual([row[1], row[2]], ["settings:automations", card], id);
  }
});

for (const everything of [false, true]) {
  test(`the Inbox shows only the work, and its switches sit in Settings, with Show everything ${everything ? "on" : "off"}`, async (t) => {
    const { app, page, errors } = await fixture(t);
    if (everything) await showEverything(page);
    await page.locator("#flows-switch-install-requests").waitFor({ state: "attached" });
    await page.locator("#recordings-mode").waitFor({ state: "attached" });
    for (const id of Object.keys(MOVED)) assert.equal(await settingsPageOf(page, id), "automations", id);
    await openPlace(page, "inbox:needs");
    assert.deepEqual(await inboxControls(page), [], "no setting inside the Inbox");
    assert.equal(await page.locator("#flows-installs-card").count(), 0, "no requests card while requests are off");

    await openPlace(page, "settings:automations");
    await page.locator("#flows-switch-install-requests").selectOption("on");
    await page.locator("#flows-installs-card").waitFor({ state: "attached" });
    await app.flowsBoards.installs.request({ kind: "mcp", name: "notes", server: { transport: "http", url: "https://mcp.example.com/mcp" }, why: "keep notes" }, "chat", "a chat app");
    await openPlace(page, "inbox:needs");
    const needs = page.locator("#flows-installs-card");
    await needs.getByRole("button", { name: "Check again" }).click();
    await needs.getByText("keep notes", { exact: false }).waitFor();
    assert.equal(await needs.locator("select").count(), 0, "the requests, without their switch");
    assert.deepEqual(await inboxControls(page), []);
    assert.deepEqual(errors, []);
  });
}

test("the moved settings read in French on a phone", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await openPlace(page, "settings:automations");
  const installs = page.locator("#flows-installs-settings-card");
  await installs.waitFor({ state: "visible" });
  assert.match(await installs.locator("h2 + p").innerText(), /Boîte de réception › Vous attend/);
  assert.match(await page.locator("#recordings-settings-card h2 + p").innerText(), /Boîte de réception › Historique/);
  assert.equal(await page.locator('.sg-head[data-bucket="automations:inbox"] h3').innerText(), "Ce que garde la boîte de réception");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errors, []);
});

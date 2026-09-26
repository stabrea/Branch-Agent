/* The Trunks rail after the approved Grown-Up sample: the drawn face retired (DG-108), the studio
   preview's three states in one line and its conversation-header row (DG-109, DG-110), one Trunk
   menu from the strip and the sidebar list (DG-112), the sidebar's Trunks here list (DG-102), and
   the pet tiles eight in a row (DG-167). Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-rail-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = [];
  for (const name of ["Scout", "Ledger"]) {
    const { trunk } = await call("/api/trunks", { name, title: "Watches prices", description: "" });
    await call(`/api/trunks/${trunk.id}`, { look: { face: "drawn" } });
    trunks.push(trunk);
  }
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#trunk-strip .strip-brand").waitFor({ state: "visible", timeout: 120000 });
  return { call, page, errors, trunks };
}

/* Redesign: prototype.html has no Trunk strip, no "Trunks here" list and no pet tiles. A Trunk's conversation is a row in
   the sidebar's list with its face (core/ui.js av()), and its menu is that row's own (right-click, or Shift+F10 from the
   keyboard). The engine's retirement of the drawn face is still checked. */
async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-rail-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = [];
  for (const name of ["Scout", "Ledger"]) {
    const { trunk } = await call("/api/trunks", { name, title: "Watches prices", description: "" });
    await call(`/api/trunks/${trunk.id}`, { look: { face: "drawn" } });
    trunks.push(trunk);
  }
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { call, page, errors, trunks };
}

test("the drawn face is retired, and every Trunk's row opens one menu by right-click and Shift+F10", { timeout: 300000 }, async (t) => {
  const f = await signedIn(t);
  const { page } = f;
  // DG-108: a stored or sent drawn face comes back as the pixel pattern.
  const roster = await f.call("/api/trunks");
  assert.deepEqual(roster.trunks.map((trunk) => trunk.look.face), ["pattern", "pattern"]);
  const [scout, ledger] = f.trunks;
  const row = (trunk) => page.locator(`#side .row[data-id="${trunk.chatSessionId}"]`);
  await row(scout).waitFor();
  await row(ledger).waitFor();
  // DG-112: right-click and Shift+F10 open the same menu for the same Trunk.
  await row(scout).click({ button: "right" });
  const menu = page.locator(".pop[role=menu]");
  await menu.waitFor();
  const byMouse = await menu.getByRole("menuitem").allInnerTexts();
  assert.ok(byMouse.some((words) => words.includes("New conversation with Scout")), "the menu is Scout's");
  assert.ok(byMouse.some((words) => words.includes("Edit Trunk…")));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await row(scout).focus();
  await page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), byMouse, "the keyboard opens the same menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await row(ledger).click({ button: "right" });
  await menu.waitFor();
  assert.ok((await menu.getByRole("menuitem").allInnerTexts()).some((words) => words.includes("New conversation with Ledger")), "each Trunk's row, its own menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  /* The menu says whose it is, and the arrow keys move between the rows (as the old Trunks list did). */
  const order = await page.locator("#side .row[data-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  await page.locator(`#side .row[data-id="${order[0]}"]`).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), order[1], "arrow keys move between rows");
  await row(scout).click({ button: "right" });
  await menu.waitFor();
  assert.equal(await menu.getAttribute("aria-label"), "Scout", "the menu is named for its Trunk");
  await page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (no Trunk strip, studio preview rows or "Trunks here" list in prototype.html;
// the drawn face and the one menu are checked live above).
test.skip("the drawn face is retired, the preview matches the sample, and every Trunk opens one menu", { timeout: 300000 }, async (t) => {
  const f = await fixture(t);
  const { page } = f;

  // DG-108: a stored or sent drawn face comes back as the pixel pattern, and is drawn as one.
  const roster = await f.call("/api/trunks");
  assert.deepEqual(roster.trunks.map((trunk) => trunk.look.face), ["pattern", "pattern"]);
  const scout = f.trunks[0];
  await page.locator(`#trunk-strip [data-strip-id="trunk:${scout.id}"] canvas.fc-pattern`).waitFor({ state: "attached" });
  assert.equal(await page.locator("#trunk-strip .fc-drawn").count(), 0);

  // DG-109, DG-110: three faces each naming its state, the states said once in one line, and the header row.
  await page.evaluate(async () => (await import("/studio.js")).openAdd("trunk"));
  const preview = page.locator("#studio-preview");
  await preview.locator(".studio-strip-row").waitFor();
  assert.deepEqual(await preview.locator('.studio-strip-row [role="img"]').evaluateAll((faces) => faces.map((node) => node.getAttribute("aria-label"))),
    ["Online", "Needs you", "Off"]);
  assert.equal(await preview.locator(".studio-state-line").innerText(), "online · needs you · off");
  assert.deepEqual(await preview.locator(".studio-h").allInnerTexts(), ["In the strip", "In the conversation header", "On its replies"]);
  assert.equal(await preview.locator(".studio-header").textContent(), "This computer / New Trunk");
  assert.equal(await page.locator("#studio").getByRole("button", { name: "Drawn face" }).count(), 0, "no Drawn face choice");
  await page.locator("#studio-name").fill("Gardener");
  assert.equal(await preview.locator(".studio-header b").innerText(), "Gardener");
  await page.locator("#studio").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator("#studio").waitFor({ state: "detached" });

  // DG-102: the sidebar's Trunks list has a small heading, rows that fit, and the open Trunk marked.
  await page.locator("#rail-view-trunks").click();
  const rows = page.locator("#trunks-rail [data-trunk]");
  await rows.first().waitFor({ state: "visible" });
  assert.equal(await page.locator("#trunks-rail h2").innerText(), "Trunks here");
  assert.ok(Number.parseFloat(await page.locator("#trunks-rail h2").evaluate((node) => getComputedStyle(node).fontSize)) < 13, "a small heading, not a giant one");
  await page.locator(`#trunk-strip [data-strip-id="trunk:${scout.id}"] .strip-face`).click();
  await page.locator(`#trunks-rail [data-trunk="${scout.id}"][aria-current="true"]`).waitFor({ state: "attached" });
  assert.equal(await page.locator('#trunks-rail [data-trunk][aria-current="true"]').count(), 1);

  // DG-112: the strip face and the sidebar row open the same menu, by right-click and by Shift+F10.
  await page.locator(`#trunk-strip [data-strip-id="trunk:${scout.id}"] .strip-face`).click({ button: "right" });
  const fromStrip = await page.locator("#strip-menu [role=menuitem]").allInnerTexts();
  await page.keyboard.press("Escape");
  await page.locator("#strip-menu").waitFor({ state: "detached" });
  await page.locator(`#trunks-rail [data-trunk="${scout.id}"]`).click({ button: "right" });
  assert.deepEqual(await page.locator("#strip-menu [role=menuitem]").allInnerTexts(), fromStrip);
  assert.equal(await page.locator("#strip-menu").getAttribute("aria-label"), "Scout");
  await page.keyboard.press("Escape");
  await page.locator("#strip-menu").waitFor({ state: "detached" });
  const [first, second] = await rows.evaluateAll((nodes) => nodes.map((node) => node.querySelector("strong").textContent));
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.querySelector("strong")?.textContent), second, "arrow keys move between rows");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.querySelector("strong")?.textContent), first);
  await page.keyboard.press("Shift+F10");
  await page.locator("#strip-menu").waitFor({ state: "visible" });
  assert.equal(await page.locator("#strip-menu").getAttribute("aria-label"), first);
  assert.deepEqual(await page.locator("#strip-menu [role=menuitem]").allInnerTexts(), fromStrip);
  await page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (prototype.html's pet is a None / Squirrel / Owl / Hedgehog choice in Settings ›
// Appearance, not eight tiles).
test.skip("the pet tiles sit eight in a row on a desktop and wrap without spilling on a phone", { timeout: 300000 }, async (t) => {
  const f = await fixture(t);
  const { page } = f;
  const tiles = async () => {
    await page.evaluate(async () => (await import("/app.js")).displayView("settings:appearance"));
    await page.locator("#delight-pet-card").waitFor({ state: "attached" });
    await page.evaluate(() => { document.getElementById("delight-pet-more").hidden = false; document.getElementById("delight-pet-card").scrollIntoView(); });
    return page.locator(".delight-pet-tile").evaluateAll((nodes) => nodes.map((node) => { const box = node.getBoundingClientRect(); return { top: Math.round(box.top), width: box.width, height: box.height }; }));
  };
  const wide = await tiles();
  assert.equal(wide.length, 8);
  assert.equal(new Set(wide.map((tile) => tile.top)).size, 1, "one row of eight");
  assert.ok(wide.every((tile) => tile.width >= 90 && tile.height >= 88), `the approved size, with a 60 by 54 pet: ${JSON.stringify(wide)}`);
  await page.setViewportSize({ width: 400, height: 900 });
  const narrow = await tiles();
  assert.ok(new Set(narrow.map((tile) => tile.top)).size > 1, "wraps below");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, "no sideways scroll");
  const box = await page.locator(".delight-pets").evaluate((node) => node.getBoundingClientRect().right);
  assert.ok(Math.max(...await page.locator(".delight-pet-tile").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) <= box + 0.5);
  assert.deepEqual(f.errors, []);
});

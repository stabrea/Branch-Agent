/**
 * r17-i: the reach and platform cards, opened the way a person opens them, at 400 px wide, in a
 * headless browser against a scratch workspace. Every word is behind a key with real French, every
 * control says what it does, and nothing reaches another computer or service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace, openSettingFor } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { reachParts, saveReachMode } from "../dist/reach/settings.js";

const PUBLIC = new URL("../public/", import.meta.url);
const CARDS = ["machines", "background", "usb", "trunks", "video", "relay", "chats", "share", "bundles", "notes", "arena"].map((c) => `reach-${c}-card`);

test("every word on the reach cards has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("reach.js", PUBLIC), "utf8");
  const keys = new Set([...source.matchAll(/"(reach\.[a-zA-Z.-]+)"/g)].map((m) => m[1]));
  for (const part of reachParts) keys.add(`reach.part.${part}`);
  for (const winner of ["a", "b", "tie", "both-bad"]) keys.add(`reach.arena.${winner}Hint`);
  assert.ok(keys.size > 150);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  assert.deepEqual([...keys].filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.ok(en["commands.platform"] && fr["commands.platform"] && en["commands.platform"] !== fr["commands.platform"]);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false);
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/reach.js" type="module"><\/script>/);
});

test("the cards sit in their homes, every control says what it does, a note is kept from the window, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-reach-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

  await openPlace(page, "library:documents");
  const notes = page.locator("#reach-notes-card");
  await notes.waitFor();
  assert.equal(await notes.locator("h2").innerText(), "Notes");
  assert.equal(await page.locator("#reach-switch-notes").inputValue(), "off");
  await page.locator("#reach-switch-notes").selectOption("on");
  await page.locator("#reach-notes-title").waitFor();
  await page.locator("#reach-notes-title").fill("Oak care");
  await page.locator("#reach-notes-body").fill("water weekly");
  await page.locator("#reach-notes-save").click();
  for (let i = 0; i < 100 && !app.reachParts.notes.list().length; i++) await page.waitForTimeout(50);
  assert.equal(app.reachParts.notes.list()[0].body, "water weekly");
  assert.equal(await wide(), false, "no sideways scrolling in Library");

  await openPlace(page, "settings:channels");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical")); // DG-194: its Advanced and Technical rows are on show
  await page.locator("#reach-relay-card").waitFor();
  await page.locator("#reach-chats-card").waitFor();
  assert.equal(await wide(), false, "no sideways scrolling in Channels");
  await openSettingFor(page, "#reach-machines-card");
  await page.locator("#reach-machines-card").waitFor({ state: "visible" });
  assert.equal(await wide(), false, "no sideways scrolling in Settings");

  // Every part on: every control is drawn, and each one is described.
  for (const part of reachParts) saveReachMode(app.store, app.runtime.owner, part, { mode: "on" });
  await page.reload();
  const token = page.getByLabel("Session token", { exact: true });
  if (await token.isVisible().catch(() => false)) {
    await token.fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#reach-arena-prompt").waitFor({ state: "attached" });
  const report = await page.evaluate((ids) => ids.map((id) => {
    const card = document.getElementById(id);
    if (!card) return { id, missing: true };
    // DG-073: Settings' own "N more" line for the section may sit at the end of the card; it is not one of its controls.
    const controls = [...card.querySelectorAll("input, select, textarea, button")].filter((c) => !c.closest(".sg-more-line"));
    const undescribed = controls.filter((c) => {
      const hint = document.getElementById(c.getAttribute("aria-describedby") ?? "");
      return !hint || !hint.textContent.trim();
    }).map((c) => c.id || c.outerHTML.slice(0, 60));
    const unlabelled = controls.filter((c) => c.tagName !== "BUTTON" && !document.querySelector(`label[for="${c.id}"]`)).map((c) => c.id);
    return { id, placed: card.parentElement !== document.body, controls: controls.length, undescribed, unlabelled };
  }), CARDS);
  for (const card of report) {
    assert.equal(card.missing, undefined, `${card.id} was not drawn`);
    assert.ok(card.placed, `${card.id} has no home`);
    assert.ok(card.controls > 0, `${card.id} has no controls`);
    assert.deepEqual(card.undescribed, [], `${card.id}: controls without a description`);
    assert.deepEqual(card.unlabelled, [], `${card.id}: controls without a label`);
  }
  assert.equal(await wide(), false);
});

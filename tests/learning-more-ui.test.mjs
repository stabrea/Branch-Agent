/**
 * R17-F: the "Learning, deeper" cards, opened the way a person opens them, at 400 px wide, in a
 * headless browser against a scratch workspace. Every word is behind a key with real French, and
 * every control has a label and a description.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the learning cards has English and real French, and the script is loaded", async () => {
  const source = await readFile(new URL("learning-more.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(lmore\.[a-zA-Z0-9.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 80);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  for (const status of ["trial", "kept", "dropped"]) keys.push(`lmore.lessons.${status}`);
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/learning-more.js" type="module"><\/script>/);
});

test("the cards sit in their homes, start off, open when switched on, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-learning-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), home: join(root, "home"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  for (const part of ["blocks", "session-lessons", "providers", "readback", "expiry", "meaning-search", "lessons", "journey"])
    app.learningMore.setMode(part, { mode: "on" });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await openPlace(page, "memory");
  const ids = ["lmore-blocks-card", "lmore-journey-card", "lmore-meaning-card", "lmore-lessons-card", "lmore-sessions-card", "lmore-expiry-card", "lmore-readback-card", "lmore-providers-card"];
  for (const id of ids) await page.locator(`#${id}`).waitFor();
  const shapes = await page.evaluate((list) => list.map((id) => {
    const card = document.getElementById(id);
    const controls = [...card.querySelectorAll("input, select, textarea, button")];
    return {
      id, home: card.dataset.home, sentence: card.querySelector("h2 + p.subtle")?.textContent ?? "",
      unnamed: controls.filter((c) => c.tagName !== "BUTTON" && !c.labels?.length).map((c) => c.id),
      undescribed: controls.filter((c) => !document.getElementById(c.getAttribute("aria-describedby") ?? "")?.textContent).map((c) => c.id || c.textContent),
      keyless: [...card.querySelectorAll("h2")].filter((n) => !n.dataset.t).length,
    };
  }), ids);
  for (const shape of shapes) {
    assert.equal(shape.home, "library:memory", shape.id);
    assert.ok(shape.sentence.length > 10, `${shape.id} says what it is for`);
    assert.deepEqual(shape.unnamed, [], `${shape.id}: every control can be named`);
    assert.deepEqual(shape.undescribed, [], `${shape.id}: every control has a description`);
    assert.equal(shape.keyless, 0);
  }
  assert.equal(await page.locator("#lmore-sessions-card h2").innerText(), "Learning your preferences from Claude Code and Codex");
  assert.equal(await page.locator("#lmore-source-claude-code").isChecked(), false, "each assistant starts opted out");
  await page.locator("#lmore-source-claude-code").check();
  for (let i = 0; i < 100 && !app.learningMore.sessions.settings(app.runtime.owner)["claude-code"]; i++) await page.waitForTimeout(50);
  assert.equal(app.learningMore.sessions.settings(app.runtime.owner)["claude-code"], true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  // Switching a part off from its card closes the card's controls.
  await page.locator("#lmore-switch-providers").selectOption("off");
  for (let i = 0; i < 100 && app.learningMore.mode("providers") !== "off"; i++) await page.waitForTimeout(50);
  assert.equal(app.learningMore.mode("providers"), "off");
  await page.locator("#lmore-provider").waitFor({ state: "detached" });
  // The skills card lives under Customize.
  app.learningMore.setMode("curator", { mode: "when-needed" });
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible" }).catch(() => undefined);
  await openPlace(page, "customize:skills");
  await page.locator("#lmore-curator-card").waitFor();
  assert.equal(await page.locator("#lmore-curator-card").getAttribute("data-home"), "customize:skills");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
});

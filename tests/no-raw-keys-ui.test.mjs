/**
 * Dogfood B14: the Talk button beside the microphone read "voice.talkStart". public/voice-talk.js drew it before the
 * words had loaded and never again. This opens the whole window, with everything shown, and looks for any visible
 * word or label that is still a key of public/locales/en.json; then it switches the language and back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { showEverything } from "./places.mjs";

const keys = new Set(Object.keys(JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"))));

async function openApp(t) {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "branch-raw-keys-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [{ id: "main", name: "Main", provider, model: "gpt-6-sol" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await showEverything(page);
  return page;
}
/** Every visible word, and every placeholder, title and label, with where it is. */
const shownWords = (page) => page.evaluate(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const text = walk.currentNode.textContent.trim(), el = walk.currentNode.parentElement;
    if (text && el && el.offsetParent !== null) out.push([text, `${el.tagName.toLowerCase()}#${el.id}`]);
  }
  for (const el of document.querySelectorAll("[placeholder],[title],[aria-label]"))
    for (const name of ["placeholder", "title", "aria-label"]) { const value = el.getAttribute(name)?.trim(); if (value) out.push([value, `${el.tagName.toLowerCase()}#${el.id}@${name}`]); }
  return out;
});

test("B14 no visible word in the window is a raw locale key, and the Talk button follows the language", async (t) => {
  const page = await openApp(t);
  const talk = page.locator("#voice-talk");
  await talk.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("voice-talk")?.textContent === "Talk", null, { timeout: 30000 });
  const raw = (await shownWords(page)).filter(([text]) => keys.has(text)).map(([text, where]) => `${text} (${where})`);
  assert.deepEqual(raw, [], "every shown word is a word, not a key");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await talk.textContent(), "Parler", "drawn again in the new language");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.equal(await talk.textContent(), "Talk");
});

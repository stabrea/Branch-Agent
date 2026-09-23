/* DG-096: the conversations open in this window, along the bottom of the reading pane as in the approved sample:
   the one on screen is marked, each can be closed off the strip, and none shows on a phone. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function signedIn(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-open-strip-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  return { page, errors };
}

/** Sends one message in a new conversation and waits until it has a session of its own. */
async function converse(page, words) {
  await page.locator("#rail-new").click();
  await page.waitForFunction(() => !document.getElementById("conversation").dataset.sessionId);
  await page.locator("#prompt").fill(words);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.getElementById("conversation").dataset.sessionId), null, { timeout: 60000 });
  return page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
}
const items = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-open-list .lx-open-item")]
  .map((node) => ({ id: node.dataset.session, on: node.classList.contains("on") })));

test("DG-096 two open conversations sit along the bottom, the one on screen marked, and one closes off the strip", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const strip = page.locator("#lx-open-strip");
  assert.equal(await strip.isVisible(), false, "nothing open, no strip");
  const first = await converse(page, "Say hello");
  assert.equal(await strip.isVisible(), false, "only the conversation on screen: the sidebar already shows it");
  const second = await converse(page, "Say goodbye");
  await strip.waitFor({ state: "visible" });
  assert.deepEqual(await items(page), [{ id: second, on: true }, { id: first, on: false }]);
  assert.equal((await strip.locator(".lx-open-label").textContent()).trim(), "Open");
  const box = await page.evaluate(() => {
    const s = document.getElementById("lx-open-strip").getBoundingClientRect(), m = document.querySelector("body > main").getBoundingClientRect();
    return { height: Math.round(s.height), bottom: Math.abs(s.bottom - m.bottom) < 3 };
  });
  assert.deepEqual(box, { height: 48, bottom: true }, "48 px, at the foot of the reading pane");
  await strip.locator(`[data-session="${first}"] .lx-open-go`).click();
  await page.waitForFunction((id) => document.getElementById("conversation").dataset.sessionId === id, first);
  await page.waitForFunction((id) => document.querySelector(`#lx-open-list [data-session="${id}"]`)?.classList.contains("on"), first);
  await strip.locator(`[data-session="${second}"] .lx-open-close`).click();
  assert.deepEqual((await items(page)).map((item) => item.id), [first]);
  assert.equal(await strip.isVisible(), false, "back to one: the strip steps aside");
  assert.deepEqual(errors, []);
});

test("DG-096 a phone has no strip, and the words are French in French", async (t) => {
  const { page, errors } = await signedIn(t, 400);
  await page.evaluate(() => localStorage.setItem("branch-open-conversations", JSON.stringify([{ id: "a", title: "One" }, { id: "b", title: "Two" }])));
  await page.reload();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await page.locator("#lx-open-strip").isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#lx-open-strip").waitFor({ state: "visible" });
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction(() => document.getElementById("lx-open-strip").getAttribute("aria-label") === "Conversations ouvertes");
  assert.equal(await page.locator('#lx-open-list [data-session="a"] .lx-open-close').getAttribute("aria-label"), "Fermer One ici");
  assert.deepEqual(errors, []);
});

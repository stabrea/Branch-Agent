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

async function signedIn(t, width, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-open-strip-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
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
  return { page, errors, app, server };
}

/** Sends one message in a new conversation and waits until it has a session of its own. */
async function converse(page, words) {
  await page.locator("#rail-new").click();
  await page.waitForFunction(() => !document.getElementById("conversation").dataset.sessionId);
  await page.locator("#prompt").fill(words);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => Boolean(document.getElementById("conversation").dataset.sessionId), null, { timeout: 60000 });
  /* New conversation is switched off until the reply is in; a slow machine must not click it early */
  await page.waitForFunction(() => !document.getElementById("new-session").disabled, null, { timeout: 60000 });
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
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.getElementById("composer-dock")).bottom), "48px",
    "the message box is not lifted for a strip a phone does not show");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#lx-open-strip").waitFor({ state: "visible" });
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction(() => document.getElementById("lx-open-strip").getAttribute("aria-label") === "Conversations ouvertes");
  assert.equal(await page.locator('#lx-open-list [data-session="a"] .lx-open-close').getAttribute("aria-label"), "Fermer One ici");
  assert.deepEqual(errors, []);
});

test("DG-096 each item wears the face of whoever answers there: a Trunk's own, or the assistant's", async (t) => {
  const { page, errors, app } = await signedIn(t, 1440);
  app.trunks.setMode("trunks", { mode: "on" });
  const ed = app.trunks.create({ name: "Ed" });
  await page.evaluate((id) => localStorage.setItem("branch-open-conversations", JSON.stringify([{ id, title: "With Ed" }, { id: "plain", title: "Mine" }])), ed.chatSessionId);
  await page.reload();
  await page.locator("#lx-open-strip").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction((id) => document.querySelector(`#lx-open-list [data-session="${id}"]`)?.dataset.face?.startsWith("trunk:"), ed.chatSessionId, { timeout: 30000 });
  const faces = await page.evaluate(() => [...document.querySelectorAll("#lx-open-list .lx-open-item")].map((item) => {
    const mark = item.querySelector(".lx-open-go > .lx-open-face");
    const box = mark?.getBoundingClientRect();
    return { key: item.dataset.face.split(":")[0], size: box && [Math.round(box.width), Math.round(box.height)], first: item.querySelector(".lx-open-go").firstElementChild === mark };
  }));
  assert.deepEqual(faces, [{ key: "trunk", size: [24, 24], first: true }, { key: "assistant", size: [24, 24], first: true }]);
  assert.equal(await page.locator(`#lx-open-list [data-session="${ed.chatSessionId}"]`).getAttribute("data-face"), `trunk:${ed.id}:Ed`);
  assert.deepEqual(errors, []);
});

test("DG-096 a conversation at work or waiting for you has the sample's dot on its face, and says so", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const provider = {
    name: "scripted",
    async complete(request) {
      const last = request.messages.at(-1);
      if (last?.role === "user" && String(last.content).includes("Downloads")) await gate;
      if (last?.role === "user" && String(last.content).includes("write notes"))
        return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "one" }) }] };
      return { content: "Done.", toolCalls: [] };
    },
  };
  const { page, errors, app, server } = await signedIn(t, 1440, provider);
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((response) => response.json());
  await call("/api/policy", { preset: "ask-before-changes" });
  const asked = await call("/api/run", { prompt: "write notes" });
  assert.equal(asked.status, "needs_input");
  void call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  let working;
  for (let tries = 0; tries < 200 && !working; tries += 1) {
    working = app.store.runs(app.runtime.owner).find((run) => run.status === "running");
    if (!working) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(working, "a task is at work");
  await page.evaluate((list) => localStorage.setItem("branch-open-conversations", JSON.stringify(list)),
    [{ id: asked.sessionId, title: "Notes" }, { id: working.sessionId, title: "Downloads" }, { id: "quiet", title: "Quiet" }]);
  await page.reload();
  await page.locator("#lx-open-strip").waitFor({ state: "visible", timeout: 120000 });
  const item = (id) => page.locator(`#lx-open-list [data-session="${id}"]`);
  await item(working.sessionId).locator(".lx-open-dot").waitFor({ timeout: 30000 });
  await item(asked.sessionId).locator(".lx-open-dot").waitFor({ timeout: 30000 });
  assert.equal(await item("quiet").locator(".lx-open-dot").count(), 0, "a quiet conversation has no dot");
  assert.equal(await item(asked.sessionId).locator(".lx-open-go").getAttribute("aria-label"), "Notes, needs you");
  assert.equal(await item(working.sessionId).locator(".lx-open-go").getAttribute("aria-label"), "Downloads, working");
  const dot = await item(asked.sessionId).evaluate((node) => {
    const d = node.querySelector(".lx-open-dot").getBoundingClientRect(), f = node.querySelector(".lx-open-face").getBoundingClientRect();
    return { size: [Math.round(d.width), Math.round(d.height)], onFace: d.left > f.left && d.left < f.right && d.top >= f.top - 2 && d.top < f.bottom };
  });
  assert.deepEqual(dot.size, [8, 8]);
  assert.equal(dot.onFace, true, "the dot sits on the face's corner");
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction((id) => document.querySelector(`#lx-open-list [data-session="${id}"] .lx-open-go`)?.getAttribute("aria-label") === "Notes, attend votre réponse", asked.sessionId);
  assert.equal(await item(working.sessionId).locator(".lx-open-go").getAttribute("aria-label"), "Downloads, en cours");
  /* marked in place, not rebuilt, so a strip scrolled sideways stays where it was */
  await item(working.sessionId).evaluate((node) => { globalThis.keptItem = node; });
  release();
  await item(working.sessionId).locator(".lx-open-dot").waitFor({ state: "detached", timeout: 30000 });
  assert.equal(await page.evaluate(() => globalThis.keptItem.isConnected), true, "the same item, not a new one");
  assert.equal(await item(working.sessionId).locator(".lx-open-go").getAttribute("aria-label"), null, "done: the dot and its words go");
  assert.deepEqual(errors, []);
});

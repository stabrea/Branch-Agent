/* DG-099: the top bar says where you are, as the approved sample does: the face and name of the computer you are on,
   "/", then the conversation's title ("New conversation" before its first message) or the place's name. On a phone
   the name and the "/" give way. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs";

async function signedIn(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-topbar-crumbs-"));
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

/** What a person sees across the top, left to right, and whether each part is on show. */
const crumbs = (page) => page.evaluate(() => {
  const shown = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden"
    && node.getBoundingClientRect().width > 1;
  const mid = document.getElementById("lx-crumbs-mid"), sep = document.querySelector(".lx-crumbs-sep");
  const thread = document.getElementById("thread-name"), title = document.getElementById("page-title");
  const threadWords = thread.textContent.trim() || getComputedStyle(thread, "::before").content.replace(/^"|"$/g, "");
  return {
    mark: shown(document.getElementById("lx-crumbs-mark")),
    mid: shown(mid) ? mid.textContent.trim() : null,
    sep: shown(sep),
    title: shown(title) ? title.textContent.trim() : null,
    thread: shown(thread) ? threadWords : null,
    order: !!(mid.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});

test("DG-099 at 1440 px a new conversation reads: this computer / New conversation", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const now = await crumbs(page);
  assert.equal(now.mark, true, "the computer's mark leads");
  assert.ok(now.mid && now.mid.length > 0, "then the computer's name");
  assert.equal(now.sep, true);
  assert.equal(now.title, null, "the place's own heading is not what shows in a conversation");
  assert.equal(now.thread, "New conversation");
  assert.equal(now.order, true, "the name comes before the title");
  assert.deepEqual(errors, []);
});

test("DG-099 a place shows its own name after the computer's", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openPlace(page, "library");
  const now = await crumbs(page);
  assert.ok(now.mid && now.mid.length > 0);
  assert.equal(now.sep, true);
  assert.match(now.title ?? "", /Library/);
  assert.equal(now.thread, null, "no conversation title outside a conversation");
  assert.deepEqual(errors, []);
});

test("DG-099 at 400 px the name and the / give way, and the title stays", async (t) => {
  const { page, errors } = await signedIn(t, 400);
  const now = await crumbs(page);
  assert.equal(now.mid, null);
  assert.equal(now.sep, false);
  assert.equal(now.thread, "New conversation");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

test("DG-099 in French the new conversation's title is French", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("thread-name"), "::before").content !== '"New conversation"');
  const now = await crumbs(page);
  assert.notEqual(now.thread, "New conversation");
  assert.ok(now.thread.length > 3);
  assert.deepEqual(errors, []);
});

/* DG-099: the top bar says where you are: in the new window (design/redesign/prototype.html pass 17) a conversation's
   header names the conversation ("New conversation" before its first message) after Branch's mark, and a place names
   itself. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./new-window-places.mjs";

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
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  return { page, errors };
}

/* Redesign: the prototype's header is not a crumb trail. A conversation's header (the prototype's .head) is Branch's mark,
   then the conversation's name ("New conversation" before its first message) with its status line under it; a place names
   itself with its own heading. The computer's name and the "/" between it and the title are not in the prototype, so they
   are not checked. */
const crumbs = (page) => page.evaluate(() => {
  const shown = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden"
    && node.getBoundingClientRect().width > 1;
  const head = [...document.querySelectorAll(".titlebar .head, #main .head")].find((node) => shown(node) && node.querySelector(".who"));
  const name = head?.querySelector(".who > b");
  const mark = head?.querySelector(".av.brand .mark-face");
  const place = [...document.querySelectorAll("#main .place h1")].find(shown);
  return {
    mark: shown(mark),
    thread: shown(name) ? name.textContent.trim() : null,
    order: !!(mark && name && mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING),
    title: place ? place.textContent.trim() : null,
    marks: head ? [...head.querySelectorAll(".av.brand")].filter(shown).length : 0,
  };
});

test("DG-099 at 1440 px a new conversation's header reads: Branch's mark, then New conversation", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const now = await crumbs(page);
  assert.equal(now.mark, true, "Branch's mark leads");
  assert.equal(now.title, null, "the place's own heading is not what shows in a conversation");
  assert.equal(now.thread, "New conversation");
  assert.equal(now.order, true, "the mark comes before the title");
  assert.equal(now.marks, 1, "exactly one mark");
  assert.deepEqual(errors, []);
});

test("DG-099 a place shows its own name", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await openPlace(page, "library", "memory");
  await page.locator("#main .place h1").first().waitFor();
  const now = await crumbs(page);
  assert.match(now.title ?? "", /Library/);
  assert.equal(now.thread, null, "no conversation title outside a conversation");
  assert.deepEqual(errors, []);
});

test("DG-099 at 400 px the title stays, and nothing scrolls sideways", async (t) => {
  const { page, errors } = await signedIn(t, 400);
  const now = await crumbs(page);
  assert.equal(now.thread, "New conversation");
  assert.equal(now.marks, 1, "exactly one mark");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

test("DG-099 in French the new conversation's title is French", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  // A new conversation in the French window: the header says the French words for it.
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.waitForFunction((words) => [...document.querySelectorAll(".head .who > b")].some((node) => node.textContent.trim() === words),
    french["comfort.field.newConversation"]);
  const now = await crumbs(page);
  assert.notEqual(now.thread, "New conversation");
  assert.equal(now.thread, french["comfort.field.newConversation"]);
  assert.deepEqual(errors, []);
});

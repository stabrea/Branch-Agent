/* The places, their tabs and the phone's bars, measured against the approved design (DG-140, DG-143, DG-174).
   Headless only, 127.0.0.1, a temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { openSettings, pressUntil } from "./places.mjs";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-places-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false), "the window to connect");
  return { page, errors };
}

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the prototype's Inbox tabs (tabsHtml) always carry Needs you's count, 0 included; the side list's Inbox
   carries the same number once something waits. */
const writing = { name: "scripted", async complete(request) {
  if (request.messages.at(-1)?.role === "tool") return { content: "Written.", toolCalls: [] };
  return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
} };
test("DG-140 (new window): the Inbox's Needs you tab carries the live count, the side list's own number", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-places-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writing });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const inbox = page.locator('#side [data-act="view"][data-v="inbox"]');
  const tabCount = page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="needs"] .n');
  await inbox.click();
  assert.equal(await tabCount.innerText(), "0", "none waiting");
  assert.equal(await inbox.locator(".cnt").count(), 0, "and the side list says nothing");
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.locator("#prompt").fill("write the note");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#side [data-act="view"][data-v="inbox"] .cnt')?.textContent === "1", undefined, { timeout: 30000 });
  await inbox.click();
  await page.waitForFunction(() => document.querySelector('#main [data-act="ptab"][data-place="inbox"][data-v="needs"] .n')?.textContent === "1", undefined, { timeout: 30000 });
  assert.equal(await tabCount.innerText(), await inbox.locator(".cnt").innerText(), "the same number as the side list's");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype's tab shows 0 at none; checked above).
test.skip("DG-140: the Inbox's Needs you tab carries the live count, and hides it at none", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => globalThis.branchLayout.go("runs"));
  assert.equal(await page.locator('.lx-tab[data-place="inbox"][data-tab="needs"] #lx-needs-tab-count').count(), 1, "one count, on the Needs you tab");
  /* the badge is set and read in one step, so the Inbox's own redraw cannot land in between: the count follows by a
     mutation observer, a microtask, so waiting one microtask (not a timer, which lets a redraw's answer in) reads it */
  const after = (text, hidden) => page.evaluate(async ([text, hidden]) => {
    const badge = document.getElementById("lx-inbox-badge"), count = document.getElementById("lx-needs-tab-count");
    badge.textContent = text;
    badge.hidden = hidden;
    await Promise.resolve();
    const s = getComputedStyle(count);
    return { text: count.textContent, hidden: count.hidden, look: [s.fontSize, s.fontWeight, s.marginLeft] };
  }, [text, hidden]);
  const two = await after("2", false);
  assert.deepEqual(two, { text: "2", hidden: false, look: ["10.5px", "600", "5px"] }, "the same number as the side list's badge");
  assert.equal((await after("3", false)).text, "3", "and it follows the badge");
  assert.equal((await after("3", true)).hidden, true, "none waiting, no count");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no places bar in the prototype; the side list, with Settings, slides over on a phone: phone-layout).
test.skip("DG-143: a phone's bar ends in Customize, and Settings is still behind the gear", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  const bar = page.locator("#ew-places");
  await bar.waitFor({ state: "visible" });
  assert.deepEqual(await bar.locator(".ew-place").evaluateAll((nodes) => nodes.map((node) => node.dataset.place)),
    ["chat", "inbox", "automations", "library", "customize"]);
  await bar.locator('.ew-place[data-place="customize"]').click();
  await page.locator("#customize").waitFor({ state: "visible" });
  assert.equal(await bar.locator('.ew-place[aria-current="page"]').getAttribute("data-place"), "customize");
  await openSettings(page);
  assert.equal(await page.locator("#settings-window").isVisible(), true, "Settings is still reachable from the side list");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no places bar); French is Coming soon (sw:lang), checked at fc541c24.
test.skip("DG-143: the bar reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal(await page.locator('.ew-place[data-place="customize"] .ew-word').innerText(), "Personnaliser");
  assert.deepEqual(errors, []);
});

/** The crumbs across the top, before the place's heading: every mark and "/" there, and which of them are on show. */
const crumbsOnScreen = (page) => page.evaluate(() => {
  const shown = (node) => node.checkVisibility() && node.getBoundingClientRect().width > 1;
  const head = document.querySelector(".head-title");
  const marks = [...head.querySelectorAll(".lx-crumbs-mark, .lx-crumb-mark, .lx-crumb-where")];
  const slashes = [...head.children].filter((node) => node.textContent.trim() === "/");
  return {
    marks: marks.length, marksShown: marks.filter(shown).length, slashesShown: slashes.filter(shown).length,
    order: [...head.children].filter(shown).map((node) => node.id || node.className).slice(0, 4),
  };
});

// Redesign: replaced by the new window (the prototype's title bar has no crumbs; public/topbar-crumbs.js is gone).
test.skip("DG-141: one crumb, the picked computer / the place, and a phone keeps only its face", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => globalThis.branchLayout.go("memory"));
  await page.locator("#library").waitFor({ state: "visible" });
  assert.deepEqual(await crumbsOnScreen(page), {
    marks: 1, marksShown: 1, slashesShown: 1, order: ["lx-crumbs-mark", "lx-crumbs-mid", "lx-crumbs-sep", "page-title"],
  }, "one crumb (public/topbar-crumbs.js): the face, the name, a slash, then the place");
  assert.equal(await page.locator("#lx-crumbs-mid").innerText(), await page.locator("#rail-target-name").innerText(), "the side list's own name");
  assert.equal(await page.locator("#page-title").innerText(), "Library", "the place, not its tab");
  assert.equal(await page.locator(".lx-back").count(), 0, "no separate back button");
  assert.equal(await page.locator('.nav[data-view="chat"]').count(), 0, "and no Conversation button, as in the sample");
  await page.setViewportSize({ width: 400, height: 844 });
  await page.evaluate(() => globalThis.branchLayout.go("memory"));
  const phone = await crumbsOnScreen(page);
  assert.deepEqual([phone.marks, phone.marksShown, phone.slashesShown], [1, 1, 0], "a phone keeps one face and drops the slash");
  assert.equal(await page.locator("#lx-crumbs-mid").isVisible(), false, "and the name");
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.waitForFunction(() => document.getElementById("lx-crumbs-mid").textContent === document.getElementById("rail-target-name").textContent.trim());
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the prototype keeps the usage ring in the status bar, data-act="usagepop", at every width).
test.skip("DG-145: on a phone the same usage ring sits in the title bar before search; wider it stays under the message box", async (t) => {
  const { page, errors } = await fixture(t);
  const where = () => page.evaluate(() => {
    const ring = document.getElementById("status-bar");
    return { inHeader: !!ring.closest("header"), beforeSearch: ring.nextElementSibling?.id === "head-search", count: document.querySelectorAll("#usage-ring").length };
  });
  assert.deepEqual(await where(), { inHeader: false, beforeSearch: false, count: 1 }, "a computer: on the line under the message box");
  await page.setViewportSize({ width: 400, height: 844 });
  await page.waitForFunction(() => !!document.getElementById("status-bar").closest("header"));
  assert.deepEqual(await where(), { inHeader: true, beforeSearch: true, count: 1 }, "a phone: in the title bar, just before search, still one ring");
  await page.setViewportSize({ width: 860, height: 900 });
  await page.waitForFunction(() => !document.getElementById("status-bar").closest("header"));
  assert.equal(await page.evaluate(() => document.getElementById("status-bar").previousElementSibling?.id), "status-bar-home", "back in its own spot");
  assert.deepEqual(errors, []);
});

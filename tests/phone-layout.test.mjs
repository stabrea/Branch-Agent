/* Redesign phase 2 "everywhere" (#44, #53): the window at phone and tablet widths, after the sample's
   frames. The phone app shows this same window, so this is its layout too. Headless only, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A model that writes a file when asked for a note: a question under "ask before changes". */
const asking = {
  name: "scripted",
  async complete(request) {
    const last = request.messages[request.messages.length - 1];
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    if (asked.includes("note")) return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Hello.", toolCalls: [] };
  },
};

async function fixture(t, { width = 390, height = 844 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-layout-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: asking });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  await page.locator("#ew-places").waitFor({ state: "attached" });
  return { page, call, errors, app };
}
const box = (page, selector) => page.locator(selector).first().boundingBox();
const lit = (page) => page.locator('.ew-place[aria-current="page"]').getAttribute("data-place");
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("a phone has the places at its foot, in the sample's order, and the message box rides above them", async (t) => {
  const f = await fixture(t);
  const bar = f.page.locator("#ew-places");
  assert.equal(await bar.isVisible(), true);
  assert.equal(await bar.getAttribute("aria-label"), "Places");
  assert.deepEqual(await bar.locator(".ew-place").allInnerTexts(), ["Conversation", "Inbox", "Automations", "Library", "Settings"]);
  const edge = await box(f.page, "#ew-places"), prompt = await box(f.page, "#prompt"), dock = await box(f.page, ".composer-dock");
  assert.ok(Math.abs(edge.y + edge.height - 844) <= 1, "the bar is at the very foot");
  assert.ok(dock.y + dock.height <= edge.y + 1, "the message box ends where the bar begins");
  assert.ok(prompt.y + prompt.height <= edge.y, "nothing covers the text field");
  for (const one of await bar.locator(".ew-place").all()) assert.ok((await one.boundingBox()).height >= 44, "each place is a thumb's size");
  assert.equal(await lit(f.page), "chat");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

test("each place in the bar opens where the side list opens it, and says which one is showing", async (t) => {
  const f = await fixture(t);
  await f.page.locator('.ew-place[data-place="inbox"]').click();
  await f.page.locator("#inbox").waitFor({ state: "visible" });
  assert.equal(await lit(f.page), "inbox");
  assert.equal(await f.page.locator("#page-title").innerText(), "Inbox");
  await f.page.locator('.ew-place[data-place="library"]').click();
  await f.page.locator("#library").waitFor({ state: "visible" });
  assert.equal(await lit(f.page), "library");
  await f.page.locator('.ew-place[data-place="settings"]').click();
  await f.page.locator("#settings-window").waitFor({ state: "visible" });
  assert.equal(await lit(f.page), "settings");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#settings-window").waitFor({ state: "hidden" });
  assert.equal(await lit(f.page), "library", "closing Settings lights the place underneath again");
  await f.page.locator('.ew-place[data-place="chat"]').click();
  await f.page.locator("#chat").waitFor({ state: "visible" });
  assert.equal(await lit(f.page), "chat");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

test("a question on a phone scrolls into view above the message box, and is answered with a thumb", async (t) => {
  const f = await fixture(t);
  await f.call("/api/policy", { preset: "ask-before-changes" });
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  const card = f.page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 20000 });
  await f.page.waitForFunction(() => {
    const card = document.getElementById("live-ask")?.getBoundingClientRect();
    const dock = document.querySelector(".composer-dock").getBoundingClientRect();
    return card && card.bottom <= dock.top;
  }, null, { timeout: 5000 });
  const head = await box(f.page, "header"), where = await box(f.page, "#live-ask");
  assert.ok(where.y >= head.y + head.height - 1, "and under the title bar");
  for (const name of ["Yes, just now", "Yes, for this conversation", "Yes, always", "No"]) {
    const answer = await card.getByRole("button", { name, exact: true }).boundingBox();
    assert.ok(answer.height >= 44 && answer.width >= 120, `${name} is a thumb's size`);
    assert.ok(answer.x >= 0 && answer.x + answer.width <= 390, `${name} is on the screen`);
  }
  await card.getByRole("button", { name: "Yes, for this conversation", exact: true }).click();
  await f.page.waitForFunction(() => /Noted/.test(document.getElementById("live-ask")?.textContent ?? "") || !document.getElementById("live-ask"), null, { timeout: 20000 });
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

test("the scroll that brings a question into view favours its answers, and the bar carries the Inbox's count", async (t) => {
  const f = await fixture(t);
  const cases = await f.page.evaluate(async () => {
    const { scrollFor } = await import("/phone-layout.js");
    const dock = { top: 700 }, scroller = { top: 52 };
    return [
      scrollFor({ top: 500, bottom: 900 }, dock, scroller),
      scrollFor({ top: 300, bottom: 600 }, dock, scroller),
      scrollFor({ top: 10, bottom: 300 }, dock, scroller),
      scrollFor({ top: -400, bottom: 900 }, dock, scroller),
    ];
  });
  assert.deepEqual(cases, [212, 0, -54, 212]);
  /* The side list is folded away on a phone, so the bar carries the Inbox's count itself, word for word. */
  await f.page.evaluate(() => { const from = document.getElementById("lx-inbox-badge"); from.textContent = "3"; from.hidden = false; });
  await f.page.locator("#ew-inbox-badge").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#ew-inbox-badge").innerText(), "3");
  await f.page.evaluate(() => { document.getElementById("lx-inbox-badge").hidden = true; });
  await f.page.locator("#ew-inbox-badge").waitFor({ state: "hidden" });
});

test("a tablet held upright keeps the side list as a column; it still folds away, and a phone gets it as a slide-over", async (t) => {
  const f = await fixture(t, { width: 820, height: 1180 });
  const rail = f.page.locator("body > .rail");
  assert.equal(await rail.isVisible(), true, "the side list shows without being asked");
  assert.equal(await f.page.evaluate(() => getComputedStyle(document.querySelector("body > .rail")).position), "relative", "as a column, not over the page");
  const side = await rail.boundingBox(), main = await box(f.page, "body > main");
  assert.ok(main.x >= side.x + side.width, "the conversation sits beside it");
  assert.equal(await f.page.locator("#ew-places").isVisible(), false, "a tablet has no bar at its foot");
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("no-rail"));
  assert.equal(await rail.isVisible(), false, "the toggle folds it away");
  assert.ok((await box(f.page, "body > main")).width > 780, "and the conversation takes the width");
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => !document.body.classList.contains("no-rail"));
  assert.equal(await noSideways(f.page), true);
  await f.page.setViewportSize({ width: 600, height: 900 });
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("rail-open"));
  assert.equal(await f.page.evaluate(() => getComputedStyle(document.querySelector("body > .rail")).position), "fixed", "under 700 px it slides over the page, as before");
  assert.deepEqual(f.errors, []);
});

test("a computer's window is unchanged: no bar, the side list where it always was", async (t) => {
  for (const [width, height] of [[1440, 950], [1024, 700]]) {
    const f = await fixture(t, { width, height });
    assert.equal(await f.page.locator("#ew-places").isVisible(), false, `${width}: no bar`);
    assert.equal(await f.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ew-bar-h")), "", `${width}: nothing is lifted for a bar`);
    assert.equal(await noSideways(f.page), true);
    assert.deepEqual(f.errors, []);
  }
});

test("the bar's words come from the language files, in English and French", async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(`../public/locales/${name}.json`, import.meta.url), "utf8"));
  const [en, fr] = [await read("en"), await read("fr")];
  for (const key of ["ew.places", "nav.chat", "place.inbox", "place.automations", "place.library", "settings.title"]) {
    assert.ok(en[key], `English has ${key}`);
    assert.ok(fr[key], `French has ${key}`);
  }
  assert.notEqual(fr["ew.places"], en["ew.places"]);
});

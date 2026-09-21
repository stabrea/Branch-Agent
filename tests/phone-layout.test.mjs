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
import { pressUntil } from "./places.mjs";

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

async function fixture(t, { width = 390, height = 844, connect = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-layout-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: asking });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    /* A route still answering when the test ends (askOnPhone's route.fetch) failed on the closed browser. */
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
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
  page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = async () => {
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    const workspace = page.locator("#workspace");
    await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
      () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false),
      "the phone window to connect");
  };
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#ew-places").waitFor({ state: "attached", timeout: 120000 });
  if (connect) await signIn();
  return { page, call, errors, app, signIn, browser, url: server.url, connected: connect };
}
const box = (page, selector) => page.locator(selector).first().boundingBox();
const lit = (page) => page.locator('.ew-place[aria-current="page"]').getAttribute("data-place");
/** How a question card would be laid out at this width, measured on a stand-in that is taken away again. */
const askLayout = (page) => page.evaluate(() => {
  const card = Object.assign(document.createElement("div"), { id: "live-ask", className: "live-ask" });
  document.getElementById("chat").append(card);
  const display = getComputedStyle(card).display;
  card.remove();
  return display;
});
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

test("the sign-in screen has no places bar; it comes once the window is connected", async (t) => {
  const f = await fixture(t, { connect: false });
  assert.equal(await f.page.locator("#ew-places").isVisible(), false);
  await f.signIn();
  await f.page.locator("#ew-places").waitFor({ state: "visible" });
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
  assert.equal(await askLayout(f.page), "grid", "a tablet answers a question two by two, as a phone does");
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
    assert.equal(await askLayout(f.page), "flex", `${width}: a question keeps the computer's layout`);
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

/* ---------- integration (phase2/everywhere): the first paint, the safe areas, one answer per question ---------- */

/** What the page paints before any of its modules has run: every script but look-early.js is held back. */
async function firstPaint(f, saved) {
  const context = await f.browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  if (saved) await context.addInitScript((id) => localStorage.setItem("branch-palette", id), saved);
  const page = await context.newPage();
  await page.route(/\.js(\?|$)/, (route) => (new URL(route.request().url()).pathname === "/look-early.js" ? route.continue() : route.abort()));
  await page.goto(f.url);
  /* A style sheet's rules cannot be read until it has arrived (Windows once threw "Cannot access rules"
     here); wait for every one, naming any that never can be. */
  const unreadable = () => page.evaluate(() => [...document.styleSheets].filter((sheet) => {
    try { return !sheet.cssRules; } catch { return true; }
  }).map((sheet) => sheet.href));
  for (let tries = 0; (await unreadable()).length; tries += 1) {
    assert.ok(tries < 100, `style sheets whose rules cannot be read: ${(await unreadable()).join(", ")}`);
    await page.waitForTimeout(100);
  }
  const paint = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const values = {};
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) if (rule.style)
      for (const name of rule.style) if (name.startsWith("--")) values[name] = style.getPropertyValue(name).trim();
    return { palette: document.documentElement.getAttribute("data-palette"), values, body: getComputedStyle(document.body).backgroundColor };
  });
  await context.close();
  return paint;
}
/** Every colour public/layout.js wore on the page once it ran. */
const worn = (page) => page.evaluate(() => {
  const style = document.documentElement.style;
  return Object.fromEntries([...style].filter((name) => name.startsWith("--") && name !== "--composer-h").map((name) => [name, style.getPropertyValue(name).trim()]));
});

test("the first paint is already Slate for somebody who never chose, colour for colour, and a chosen Forest is Forest from the first frame", async (t) => {
  const f = await fixture(t, { width: 1440, height: 950, connect: false });
  const slate = await worn(f.page);
  assert.equal(slate["--ground"], "#18242C", "the window wears Slate by default");
  const fresh = await firstPaint(f, "");
  assert.equal(fresh.palette, null, "nothing chosen, nothing named");
  for (const [name, value] of Object.entries(slate)) assert.equal(fresh.values[name], value, `${name} is Slate's before anything runs`);
  assert.equal(fresh.body, "rgb(24, 36, 44)", "and so is the page's own ground");
  const forest = await firstPaint(f, "forest");
  assert.equal(forest.palette, "forest", "a chosen theme is named before the first paint");
  assert.equal(forest.values["--ground"], "#03140b", "so a chosen Forest paints Forest from the first frame, as before");
  assert.equal(forest.values["--glass"], "rgba(10, 32, 20, 0.62)");
  assert.equal((await firstPaint(f, "slate")).values["--ground"], "#18242C", "a chosen Slate is Slate too");
  assert.equal((await firstPaint(f, "x\" onload=\"")).palette, null, "only a theme's own id is written on the page");
  assert.deepEqual(f.errors, []);
});

test("the Slate first paint in tokens.css is the catalogue's Slate, dark and light, and cannot drift from it", async (t) => {
  const f = await fixture(t, { connect: false });
  const report = await f.page.evaluate(async () => {
    const { themeById, tokensFor, solid, BRIDGE } = await import("/theme-bridge.js");
    const css = await (await fetch("/tokens.css")).text();
    const block = (selector) => {
      const at = css.indexOf(`${selector} {`);
      const body = css.slice(at, css.indexOf("}", at));
      return Object.fromEntries([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
    };
    const expected = (mode) => {
      const tokens = tokensFor(themeById("slate"), mode);
      for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) tokens[name] = tokens[from];
      tokens["--surface"] = solid(tokens["--ground"], mode === "dark" ? tokens["--text"] : "#ffffff", mode === "dark" ? 0.07 : 0.55);
      return tokens;
    };
    return {
      dark: [block(':root[data-palette="slate"]'), expected("dark")],
      light: [block(':root[data-palette="slate"][data-theme="daylight"]'), expected("light")],
    };
  });
  for (const mode of ["dark", "light"]) {
    const [written, catalogue] = report[mode];
    assert.ok(Object.keys(catalogue).length > 50, `${mode}: the whole theme`);
    for (const [name, value] of Object.entries(catalogue)) assert.equal(written[name], value, `${mode} ${name}`);
  }
});

test("on a phone with a notch and a home bar nothing sits under either; a computer's margins do not move", async (t) => {
  const f = await fixture(t, { connect: false });
  const cdp = await f.page.context().newCDPSession(f.page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
  await f.signIn();
  await f.page.locator("#ew-places").waitFor({ state: "visible" });
  assert.match(await f.page.locator('meta[name="viewport"]').getAttribute("content"), /viewport-fit=cover/);
  const head = await box(f.page, "header"), bar = await box(f.page, "#ew-places"), prompt = await box(f.page, "#prompt");
  assert.ok(head.y >= 47, "the title bar starts under the notch");
  assert.equal(await f.page.evaluate(() => getComputedStyle(document.getElementById("ew-places")).paddingBottom), "34px", "the bar keeps the home bar's room");
  assert.ok(Math.abs(bar.y + bar.height - 844) <= 1 && bar.height >= 58 + 34, "and still sits at the foot");
  assert.ok(prompt.y + prompt.height <= bar.y, "the message box stays above the bar");
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("rail-open"));
  assert.ok((await box(f.page, "body > .rail")).y >= 47, "the side list slides over under the notch, not behind it");
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  /* the edges the Trunks strip does not take (it takes the left on a computer, the foot on a tablet, the top on a phone) */
  for (const [width, height, sides] of [[1440, 950, { top: "10px", right: "10px", bottom: "10px" }], [1024, 700, { top: "10px", right: "10px", bottom: "10px" }],
    [820, 1180, { top: "6px", right: "6px", left: "6px" }], [390, 844, { right: "0px", left: "0px", bottom: "0px" }]]) {
    await f.page.setViewportSize({ width, height });
    const pads = await f.page.evaluate((names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(document.body)[`padding${name[0].toUpperCase()}${name.slice(1)}`]])), Object.keys(sides));
    assert.deepEqual(pads, sides, `${width}: the page's margins are the ones it always had`);
  }
  assert.deepEqual(f.errors, []);
});

test("at every width from a phone to a wide screen nothing runs off sideways and nothing covers the message box", async (t) => {
  const f = await fixture(t);
  const sizes = [[390, 844], [560, 900], [561, 900], [699, 900], [700, 900], [820, 1180], [860, 1000], [861, 1000], [900, 1000], [1024, 700], [1440, 950]];
  for (const [width, height] of sizes) {
    await f.page.setViewportSize({ width, height });
    await f.page.waitForTimeout(50);
    const seen = await f.page.evaluate(() => {
      const prompt = document.getElementById("prompt").getBoundingClientRect();
      const top = document.elementFromPoint(prompt.left + prompt.width / 2, prompt.top + prompt.height / 2);
      const rail = document.querySelector("body > .rail");
      return {
        sideways: document.documentElement.scrollWidth > innerWidth,
        covered: !document.querySelector(".composer-dock").contains(top),
        bar: getComputedStyle(document.getElementById("ew-places")).display !== "none",
        docked: getComputedStyle(rail).position !== "fixed" && rail.getBoundingClientRect().width > 0,
      };
    });
    assert.equal(seen.sideways, false, `${width}: nothing sideways`);
    assert.equal(seen.covered, false, `${width}: the text field is on top`);
    assert.equal(seen.bar, width <= 560, `${width}: the places bar only on a phone`);
    assert.equal(seen.docked, width >= 700, `${width}: the side list is a column from 700 px`);
  }
  assert.deepEqual(f.errors, []);
});

test("a household person's bar offers exactly what their side list offers, and carries the same count", async (t) => {
  const f = await fixture(t, { connect: false });
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await f.signIn();
  await f.page.waitForFunction(() => document.documentElement.dataset.household === "on", null, { timeout: 10000 });
  await f.page.waitForTimeout(1500);
  const seen = await f.page.evaluate(() => ({
    /* every place the side list holds for this person (the calm window folds them into More; they are still theirs) */
    side: [...document.querySelectorAll(".lx-place-link")].filter((link) => !link.hidden).map((link) => link.dataset.place),
    bar: [...document.querySelectorAll(".ew-place")].filter((button) => !button.hidden).map((button) => button.dataset.place),
    sideCount: document.getElementById("lx-inbox-badge").hidden ? "" : document.getElementById("lx-inbox-badge").textContent,
    barCount: document.getElementById("ew-inbox-badge").hidden ? "" : document.getElementById("ew-inbox-badge").textContent,
  }));
  assert.deepEqual(seen.bar.filter((place) => !["chat", "settings"].includes(place)), seen.side.filter((place) => place !== "customize"),
    "the bar lists the side list's places (the conversation and Settings in Customize's spot, as in the sample)");
  assert.equal(seen.barCount, seen.sideCount, "and the Inbox count is the side list's own");
  assert.deepEqual(f.errors, []);
});

test("on a phone the Trunks strip runs across the top and the places hold the foot; a tablet keeps the strip at its foot", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#trunk-strip").waitFor({ state: "visible" });
  const strip = await box(f.page, "#trunk-strip"), head = await box(f.page, "header"), bar = await box(f.page, "#ew-places");
  const prompt = await box(f.page, "#prompt");
  assert.ok(strip.y + strip.height <= head.y, "the strip sits above the title bar, as in the phone frame");
  assert.ok(Math.abs(bar.y + bar.height - 844) <= 1, "the places bar alone holds the foot");
  assert.ok(prompt.y + prompt.height <= bar.y, "and the message box rides above it");
  await f.page.setViewportSize({ width: 820, height: 1180 });
  await f.page.waitForTimeout(100);
  const tablet = await box(f.page, "#trunk-strip");
  assert.ok(Math.abs(tablet.y + tablet.height + 6 - 1180) <= 1, "a tablet keeps the strip at its foot, where the shell puts it");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

/** Shows a question at 390 px, with the policy answer rewritten by `edit` on its way to the page. */
async function askOnPhone(f, edit = (body) => body) {
  await f.page.route("**/api/policy", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, json: edit(await response.json()) });
  });
  await f.call("/api/policy", { preset: "ask-before-changes" });
  if (!f.connected) await f.signIn();
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  const card = f.page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 20000 });
  return card;
}

test("a quick double tap on a phone's big answer sends one answer, not two", async (t) => {
  const f = await fixture(t);
  const card = await askOnPhone(f);
  await f.page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.__branchApprovalRequests = 0;
    window.fetch = async (...args) => {
      const target = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
      if (target.endsWith("/api/policy/approve")) {
        window.__branchApprovalRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return original(...args);
    };
  });
  /* Three presses in the same instant (a thumb's double tap, then a slip onto No), so a slow machine cannot
     let the first answer come back before the others land. */
  await card.evaluate((node) => {
    const [yes, no] = ["Yes, just now", "No"].map((name) => [...node.querySelectorAll("button")].find((button) => button.textContent === name));
    yes.click();
    yes.click();
    no.click();
  });
  await f.page.waitForFunction(() => /Noted/.test(document.getElementById("live-ask")?.textContent ?? ""), null, { timeout: 20000 });
  assert.equal(await f.page.evaluate(() => window.__branchApprovalRequests), 1, "one answer left the phone");
  assert.deepEqual(f.errors, []);
});

test("an answer that could not be sent gives the buttons back; No is the quiet answer; a task somebody else started has no Yes, always", async (t) => {
  /* Install the response rewrite before sign-in starts the policy poller. Otherwise an already in-flight
     unmodified GET can win the race, draw the real card without the test-only files, and never be replaced. */
  const f = await fixture(t, { connect: false });
  const files = [{ kind: "write", path: "a.txt" }, { kind: "write", path: "b.txt" }];
  const card = await askOnPhone(f, (body) => ({ ...body, waiting: body.waiting.map((question) => ({ ...question, source: "channel", files })) }));
  /* ci-flakes-4: #live-ask goes visible as soon as the card is there, and its own parts arrive with the
     card's next draw, so both the parts these widths come from are waited for. One of them was still
     missing when it was measured on a busy Windows machine (getBoundingClientRect of null). Both parts
     are now waited for to be visible before measuring. */
  await card.locator(":scope > div:not(.live-ask-choice)").waitFor({ state: "visible", timeout: 30000 });
  await card.locator(":scope > p").waitFor({ state: "visible", timeout: 30000 });
  const widths = await card.evaluate((node) => [node.querySelector(":scope > div:not(.live-ask-choice)"), node.querySelector(":scope > p")]
    .map((child) => child ? Math.round(child.getBoundingClientRect().width) : 0));
  assert.equal(widths[0], widths[1], "the files a question touches run the card's full width, not one answer's cell");
  assert.deepEqual(await card.locator(".live-ask-choice > button").allInnerTexts(), ["Yes, just now", "Yes, for this conversation", "No"],
    "a standing yes stays the owner's, on a phone as on a computer");
  const heights = await card.locator(".live-ask-choice > button").evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().height)));
  assert.equal(new Set(heights).size, 1, `every answer is the same height (${heights.join(", ")})`);
  const [yes, no] = await card.locator(".live-ask-choice > button").evaluateAll((buttons) => [buttons[0], buttons.at(-1)].map((b) => getComputedStyle(b).backgroundColor));
  assert.notEqual(no, yes, "No does not look like a fourth yes");
  await f.page.route("**/api/policy/approve", (route) => route.fulfill({ status: 500, json: { error: "The computer did not answer." } }));
  await card.getByRole("button", { name: "Yes, just now", exact: true }).tap();
  await f.page.waitForFunction(() => document.getElementById("live-status")?.textContent === "The computer did not answer.");
  assert.equal(await card.getByRole("button", { name: "Yes, just now", exact: true }).isEnabled(), true, "it can be tried again");
});

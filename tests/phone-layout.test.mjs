/* Redesign phase 2 "everywhere" (#44, #53): the window at phone and tablet widths, after the sample's
   frames. The phone app shows this same window, so this is its layout too. Headless only, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
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

async function fixture(t, { width = 390, height = 844, connect = true, beforeOpen } = {}) {
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
  await beforeOpen?.(page);
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
  return { page, call, errors, app, signIn, browser, url: server.url, token: server.token, connected: connect };
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

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the prototype has no places bar and no Trunks strip; up to 760 px its side list slides over the conversation
   ("Show conversations", data-act="side"), and from 761 px it is a column. Its approval card (#live-ask) answers with the
   action's own verb, "Always allow" (greyed out until a standing yes can be kept for one Trunk) and "Don’t allow". */
/** The same model for the new window: its yes carries the task on with a nudge ("Yes, go ahead."), so any message of the
    conversation asking for a note makes the call again, which then goes through. */
const carryingOn = {
  name: "scripted",
  async complete(request) {
    const last = request.messages.at(-1);
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    if (last.role === "user" && request.messages.some((m) => m.role === "user" && String(m.content).includes("note")))
      return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
    return { content: "Hello.", toolCalls: [] };
  },
};
async function signedIn(t, { width = 390, height = 844, beforeOpen, provider = carryingOn } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-layout-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  // The first-run card (#323) opens under automation on purpose; these tests are about the phone layout.
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  // Reduced motion: the side list's .22 s slide-out would otherwise race what the tests read.
  page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900, serviceWorkers: "block", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await beforeOpen?.(page);
  await page.goto(server.url, { timeout: 120000 });
  const signIn = async () => {
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "attached", timeout: 120000 });
    await page.locator("#prompt").waitFor({ state: "visible", timeout: 120000 });
  };
  return { app, page, errors, signIn, workspace, server };
}
/** The side list is on the screen (not slid away to the left). */
const sideShown = (page) => page.evaluate(() => { const r = document.getElementById("side").getBoundingClientRect(); return r.right > 0 && r.width > 0; });
/** A question in this conversation, its card drawn with its answers. */
async function ask(page) {
  await page.locator("#prompt").fill("write a note for me");
  await page.locator("#send").click();
  const card = page.locator("#live-ask");
  await card.locator(".acts .btn.pri").waitFor({ state: "visible", timeout: 30000 });
  return card;
}

// Redesign: replaced by the new window (no places bar in the prototype; its side list slides over the conversation up to 760 px).
test.skip("a phone has the places at its foot, in the sample's order, and the message box rides above them", async (t) => {
  const f = await fixture(t);
  const bar = f.page.locator("#ew-places");
  assert.equal(await bar.isVisible(), true);
  assert.equal(await bar.getAttribute("aria-label"), "Places");
  assert.deepEqual(await bar.locator(".ew-place").allInnerTexts(), ["Conversation", "Inbox", "Automations", "Library", "Customize"]);
  const edge = await box(f.page, "#ew-places"), prompt = await box(f.page, "#prompt"), dock = await box(f.page, ".composer-dock");
  assert.ok(Math.abs(edge.y + edge.height - 844) <= 1, "the bar is at the very foot");
  assert.ok(dock.y + dock.height <= edge.y + 1, "the message box ends where the bar begins");
  assert.ok(prompt.y + prompt.height <= edge.y, "nothing covers the text field");
  for (const one of await bar.locator(".ew-place").all()) assert.ok((await one.boundingBox()).height >= 44, "each place is a thumb's size");
  assert.equal(await lit(f.page), "chat");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (no places bar in the prototype).
test.skip("the sign-in screen has no places bar; it comes once the window is connected", async (t) => {
  const f = await fixture(t, { connect: false });
  assert.equal(await f.page.locator("#ew-places").isVisible(), false);
  await f.signIn();
  await f.page.locator("#ew-places").waitFor({ state: "visible" });
  assert.deepEqual(f.errors, []);
});

/* Redesign: the new window has one stylesheet (public/app.css) in place of the shared shell's; a phone still connects
   without it, and Connect still owns its own hit target. */
test("a phone can connect when the shared shell stylesheet does not load", async (t) => {
  const f = await signedIn(t, { width: 400, height: 900, beforeOpen: (page) => page.route("**/app.css", (route) => route.abort()) });
  const connect = f.page.getByRole("button", { name: "Connect", exact: true });
  await f.page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  assert.equal(await connect.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    return hit === button || button.contains(hit);
  }), true, "Connect owns its hit target");
  await connect.click();
  await f.page.locator("#app #side").waitFor({ state: "attached", timeout: 30000 });
  assert.deepEqual(f.errors, []);
});

/* Redesign: the places bar is replaced by the prototype's side list, which slides over the conversation on a phone. */
test("each place in the bar opens where the side list opens it, and says which one is showing", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  assert.equal(await sideShown(f.page), false, "on a phone the side list waits off to the side");
  for (const place of ["inbox", "library", "customize"]) {
    if (!(await sideShown(f.page))) await f.page.locator('[data-act="side"]').first().click();
    await f.page.waitForFunction(() => document.getElementById("side").getBoundingClientRect().left >= 0);
    await f.page.locator(`#side [data-act="view"][data-v="${place}"]`).click();
    await f.page.locator(`#main [data-act="ptab"][data-place="${place}"]`).first().waitFor({ state: "visible" });
    assert.equal(await f.page.locator(`#side [data-act="view"][data-v="${place}"]`).getAttribute("aria-current"), "true", `${place} says it is showing`);
    assert.equal(await f.page.locator('#side [data-act="view"][aria-current="true"]').count(), 1, "one place is showing");
    assert.equal(await noSideways(f.page), true);
  }
  assert.deepEqual(f.errors, []);
});

test("a question on a phone scrolls into view above the message box, and is answered with a thumb", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  const card = await ask(f.page);
  await f.page.waitForFunction(() => {
    const answers = document.querySelector("#live-ask .acts")?.getBoundingClientRect();
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    const head = document.querySelector(".titlebar")?.getBoundingClientRect();
    return answers && dock && head && answers.bottom <= dock.top + 1 && answers.top >= head.bottom - 1;
  }, null, { timeout: 30000 });
  for (const button of await card.locator(".acts button").all()) {
    const where = await button.boundingBox();
    assert.ok(where.x >= 0 && where.x + where.width <= 390, `${await button.innerText()} is on the screen`);
  }
  assert.equal(existsSync(join(f.workspace, "note.txt")), false, "nothing is written before the answer");
  await card.locator(".acts .btn.pri").tap();
  await f.page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  assert.equal(await readFile(join(f.workspace, "note.txt"), "utf8"), "hi");
  assert.equal(await noSideways(f.page), true);
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (public/phone-layout.js and the bar's Inbox count are gone; the side list's own count is the prototype's).
test.skip("the scroll that brings a question into view favours its answers, and the bar carries the Inbox's count", async (t) => {
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

// Redesign: replaced by the new window (the prototype slides the side list over up to 760 px and docks it from 761 px; checked in the every-width test).
test.skip("a tablet held upright keeps the side list as a column; it still folds away, and a phone gets it as a slide-over", async (t) => {
  const f = await fixture(t, { width: 740, height: 1180 });
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
  assert.ok((await box(f.page, "body > main")).width > 700, "and the conversation takes the width");
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => !document.body.classList.contains("no-rail"));
  assert.equal(await noSideways(f.page), true);
  await f.page.setViewportSize({ width: 600, height: 900 });
  await f.page.locator("#rail-toggle").click();
  await f.page.waitForFunction(() => document.body.classList.contains("rail-open"));
  assert.equal(await f.page.evaluate(() => getComputedStyle(document.querySelector("body > .rail")).position), "fixed", "under 700 px it slides over the page, as before");
  assert.deepEqual(f.errors, []);
});

/* Redesign: the prototype's computer layout: the side list is a column beside the conversation. */
test("a computer's window is unchanged: no bar, the side list where it always was", async (t) => {
  for (const [width, height] of [[1440, 950], [1024, 700]]) {
    const f = await signedIn(t, { width, height });
    await f.signIn();
    const side = await f.page.locator("#side").boundingBox(), prompt = await f.page.locator("#prompt").boundingBox();
    assert.ok(side.x >= 0 && side.width > 0, `${width}: the side list shows without being asked`);
    assert.ok(prompt.x >= side.x + side.width, `${width}: the conversation sits beside it`);
    assert.equal(await f.page.locator('[data-act="side"]').first().isVisible(), false, `${width}: no button to slide it over`);
    assert.equal(await noSideways(f.page), true);
    assert.deepEqual(f.errors, []);
  }
});

// Redesign: replaced by the new window (no places bar in the prototype; its words are the prototype's, contract rule 1).
test.skip("the bar's words come from the language files, in English and French", async () => {
  const read = async (name) => JSON.parse(await readFile(new URL(`../public/locales/${name}.json`, import.meta.url), "utf8"));
  const [en, fr] = [await read("en"), await read("fr")];
  for (const key of ["ew.places", "nav.chat", "place.inbox", "place.automations", "place.library", "place.customize"]) {
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
  await page.goto(f.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  // Style sheets hold the load event back, so a busy machine's slow ones have all arrived by then.
  await page.waitForLoadState("load", { timeout: 120000 });
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

// Redesign: replaced by the new window (look-early.js and the Slate first paint are gone; the prototype's themes are public/app/shell/themes.js).
test.skip("the first paint is already Slate for somebody who never chose, colour for colour, and a chosen Forest is Forest from the first frame", async (t) => {
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

// Redesign: replaced by the new window (public/theme-bridge.js is gone; the window's tokens are public/app.css, design doc 2).
test.skip("the Slate first paint in tokens.css is the catalogue's Slate, dark and light, and cannot drift from it", async (t) => {
  const f = await fixture(t, { connect: false });
  const report = await f.page.evaluate(async () => {
    const { themeById, tokensFor, surfaceOf, BRIDGE } = await import("/theme-bridge.js");
    const css = await (await fetch("/tokens.css")).text();
    const block = (selector) => {
      const at = css.indexOf(`${selector} {`);
      const body = css.slice(at, css.indexOf("}", at));
      return Object.fromEntries([...body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
    };
    const expected = (mode) => {
      const tokens = tokensFor(themeById("slate"), mode);
      for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) tokens[name] = tokens[from];
      tokens["--surface"] = surfaceOf(tokens, mode); // the page's own blend, never a copy of it
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

// Redesign: replaced by the new window (the prototype has no safe-area margins, places bar or Trunks strip).
test.skip("on a phone with a notch and a home bar nothing sits under either; a computer's margins do not move", async (t) => {
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
    [740, 1180, { top: "6px", right: "6px", left: "6px" }], [390, 844, { right: "0px", left: "0px", bottom: "0px" }]]) {
    await f.page.setViewportSize({ width, height });
    const pads = await f.page.evaluate((names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(document.body)[`padding${name[0].toUpperCase()}${name.slice(1)}`]])), Object.keys(sides));
    assert.deepEqual(pads, sides, `${width}: the page's margins are the ones it always had`);
  }
  assert.deepEqual(f.errors, []);
});

test("at every width from a phone to a wide screen nothing runs off sideways and nothing covers the message box", async (t) => {
  const f = await signedIn(t);
  await f.signIn();
  const sizes = [[390, 844], [560, 900], [561, 900], [699, 900], [700, 900], [760, 1000], [761, 1000], [800, 1200], [900, 1000], [1024, 700], [1440, 950]];
  for (const [width, height] of sizes) {
    await f.page.setViewportSize({ width, height });
    await f.page.waitForTimeout(300);
    const seen = await f.page.evaluate(() => {
      const prompt = document.getElementById("prompt").getBoundingClientRect();
      const top = document.elementFromPoint(prompt.left + prompt.width / 2, prompt.top + prompt.height / 2);
      const side = document.getElementById("side");
      return {
        sideways: document.documentElement.scrollWidth > innerWidth,
        covered: !document.querySelector(".dock").contains(top),
        docked: getComputedStyle(side).position !== "absolute" && side.getBoundingClientRect().left >= 0,
      };
    });
    assert.equal(seen.sideways, false, `${width}: nothing sideways`);
    assert.equal(seen.covered, false, `${width}: the text field is on top`);
    assert.equal(seen.docked, width > 760, `${width}: the side list is a column from 761 px, as the prototype's`);
  }
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (no places bar in the prototype).
test.skip("a household person's bar offers exactly what their side list offers, and carries the same count", async (t) => {
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
  assert.deepEqual(seen.bar.filter((place) => place !== "chat"), seen.side.filter((place) => place !== "overview"),
    "the bar lists the side list's places, after the conversation, as in the sample (Overview is the sidebar's own)");
  assert.equal(seen.barCount, seen.sideCount, "and the Inbox count is the side list's own");
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (no Trunks strip in the prototype; Trunks are in the side list).
test.skip("on a phone the Trunks strip runs across the top and the places hold the foot; a tablet keeps the strip at its foot", async (t) => {
  const f = await fixture(t);
  await f.page.locator("#trunk-strip").waitFor({ state: "visible" });
  const strip = await box(f.page, "#trunk-strip"), head = await box(f.page, "header"), bar = await box(f.page, "#ew-places");
  const prompt = await box(f.page, "#prompt");
  assert.ok(strip.y + strip.height <= head.y, "the strip sits above the title bar, as in the phone frame");
  assert.ok(Math.abs(bar.y + bar.height - 844) <= 1, "the places bar alone holds the foot");
  assert.ok(prompt.y + prompt.height <= bar.y, "and the message box rides above it");
  await f.page.setViewportSize({ width: 740, height: 1180 });
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
  const f = await signedIn(t);
  await f.signIn();
  const card = await ask(f.page);
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
  /* Three presses in the same instant (a thumb's double tap, then a slip onto Don't allow), so a slow machine cannot
     let the first answer come back before the others land. */
  await card.evaluate((node) => {
    const yes = node.querySelector(".acts .btn.pri");
    const no = [...node.querySelectorAll(".acts button")].find((button) => button.textContent === "Don’t allow");
    yes.click();
    yes.click();
    no.click();
  });
  await f.page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  // WINDOW BUG: public/app/chat/chat.js answer() keeps the card's buttons live while an answer is on its way, so three
  // presses send three answers (two yeses and a no).
  assert.equal(await f.page.evaluate(() => window.__branchApprovalRequests), 1, "one answer left the phone");
  assert.deepEqual(f.errors, []);
});

test("an answer that could not be sent gives the buttons back; No is the quiet answer; a task somebody else started has no Yes, always", async (t) => {
  const f = await signedIn(t);
  /* The policy answer is rewritten on its way to the page before sign-in starts reading it, as if a chat app had
     started the task; nothing else about the question changes. */
  await f.page.route("**/api/policy", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, waiting: (body.waiting ?? []).map((question) => ({ ...question, source: "channel" })) } });
  });
  await f.signIn();
  const card = await ask(f.page);
  const answers = await card.locator(".acts button").evaluateAll((buttons) => buttons.map((b) => ({
    text: b.textContent.trim(), live: b.getAttribute("aria-disabled") !== "true" && !b.disabled, pri: b.classList.contains("pri"), bg: getComputedStyle(b).backgroundColor })));
  assert.equal(answers.some((b) => /^Always allow/.test(b.text) && b.live), false, `no live standing yes: ${JSON.stringify(answers)}`);
  const yes = answers.find((b) => b.pri), no = answers.find((b) => b.text === "Don’t allow");
  assert.ok(yes?.live && no?.live, "a yes for now and a no");
  assert.notEqual(no.bg, yes.bg, "Don’t allow does not look like a yes");
  await f.page.route("**/api/policy/approve", (route) => route.fulfill({ status: 500, json: { error: "The computer did not answer." } }));
  await card.locator(".acts .btn.pri").tap();
  await f.page.locator(".toast").filter({ hasText: "The computer did not answer." }).waitFor({ timeout: 20000 });
  await f.page.locator("#live-ask .acts .btn.pri").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await f.page.locator("#live-ask .acts .btn.pri").isEnabled(), true, "it can be tried again");
  assert.equal(existsSync(join(f.workspace, "note.txt")), false, "nothing happened");
});

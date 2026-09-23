/* DG-154: "Branch in the terminal and on your phone", the approved sample's four-tab preview. The owner
   opens it from More (the calm window) or the workspace menu (Show everything); it is as big as the
   sample's (the window less 24px each side, at most 1400px wide); the terminal takes keys and the
   phones and the tablet can be tapped; and all of it runs on a sample of its own, never the owner's
   conversations, settings or running work. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PUBLIC = join(import.meta.dirname, "..", "public");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-everywhere-"));
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const open = async ({ width = 1440, height = 900, colorScheme = "dark" } = {}) => {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
    return { page, errors };
  };
  return { open };
}
const everything = (page, on) => page.evaluate((value) => { document.documentElement.dataset.everything = value; }, on ? "on" : "off");
async function openFromMore(page) {
  await page.locator("#lx-more").click();
  await page.getByRole("menuitem", { name: "In the terminal and on your phone" }).click();
  await page.locator("#ew-dialog").waitFor({ state: "visible" });
}
/* The window's own reads that go by POST (Settings' "why this model" line asks as the page loads). */
const READS = ["/api/models/profiles/preview"];
/** Every request that could change something on the server, from here on. */
function writes(page) {
  const seen = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() !== "GET" && url.pathname.startsWith("/api/") && !READS.includes(url.pathname)) seen.push(`${request.method()} ${url.pathname}`);
  });
  return seen;
}
/** The workspace menu; on a narrow window the rail slides in first. */
async function openFromWorkspaceMenu(page) {
  if (!(await page.locator("#owner-menu-button").isVisible())) await page.locator("#rail-toggle").click();
  await page.locator("#owner-menu-button").click();
  await page.locator("#menu-everywhere").click();
  await page.locator("#ew-dialog").waitFor({ state: "visible" });
}
const text = (page, selector) => page.locator(selector).innerText();

test("the preview's code keeps to its own sample: no server, no storage, no other module but the words", async () => {
  const source = await readFile(join(PUBLIC, "everywhere.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|\/api\/|\bapi\s*\(|XMLHttpRequest|WebSocket|EventSource|localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);
  assert.deepEqual([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["/i18n.js"]);
});

test("the owner opens it from More or the workspace menu, at the sample's size, in both lights and French", async (t) => {
  const f = await fixture(t);
  for (const [width, height] of [[1440, 900], [860, 900], [400, 800]]) {
    for (const colorScheme of ["dark", "light"]) {
      const { page, errors } = await f.open({ width, height, colorScheme });
      await everything(page, false);
      const group = page.locator("#lx-more-menu .lx-more-group", { has: page.locator("#lx-more-more-elsewhere") });
      await openFromMore(page);
      assert.equal(await group.locator(".lx-more-head").innerText(), "Branch elsewhere");
      assert.equal(await text(page, "#ew-title"), "Branch in the terminal and on your phone");
      assert.deepEqual(await page.locator(".ew-tab").allInnerTexts(), ["Terminal", "iPhone", "Android", "Tablet"]);
      const box = await page.locator("#ew-dialog").boundingBox();
      assert.equal(Math.round(box.width), Math.min(width - 48, 1400), `${width}: the window less 48px, at most 1400px`);
      assert.equal(Math.round(box.height), height - 48);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "ew-tui", "the terminal has the keyboard");
      for (const tab of ["iphone", "android", "tablet"]) {
        await page.locator(`.ew-tab[data-tab="${tab}"]`).click();
        const device = await page.locator(".ew-dv").boundingBox();
        const expected = { iphone: [300, 649], android: [300, 666], tablet: [Math.min(820, Math.min(width - 48, 1400) - 42), 570] }[tab];
        assert.deepEqual([Math.round(device.width), Math.round(device.height)], expected, `${width} ${tab}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways scroll");
      }
      await page.keyboard.press("Escape");
      await page.locator("#ew-dialog").waitFor({ state: "detached" });
      await everything(page, true);
      await openFromWorkspaceMenu(page);
      assert.equal(await page.locator(".ew-tab[aria-selected=true]").innerText(), "Tablet", "the tab chosen last is kept");
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  const { page } = await f.open();
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await everything(page, false);
  await page.locator("#lx-more").click();
  await page.getByRole("menuitem", { name: "Dans le terminal et sur votre téléphone" }).click();
  assert.equal(await text(page, "#ew-title"), "Branch dans le terminal et sur votre téléphone");
  assert.equal(await page.locator('.ew-tab[data-tab="tablet"]').innerText(), "Tablette");
  assert.match(await text(page, ".ew-tui-places"), /2 Boîte de réception/);
  assert.match(await text(page, ".ew-tui-conv"), /Peut-il lancer cette commande \?/);
  await page.close();
});

test("a household profile sees neither way in", async (t) => {
  const f = await fixture(t);
  const { page } = await f.open();
  await everything(page, false);
  const seen = async (household) => page.evaluate(async (away) => {
    /* In one step: the window's next refresh puts the profile back as the server has it. */
    (await import("/app.js")).noteWindowProfile(!away);
    document.getElementById("lx-more").click();
    const row = document.querySelector('#lx-more-menu [data-kind="elsewhere"]');
    const seen = { more: row.checkVisibility(), menu: !document.getElementById("menu-everywhere").hidden };
    document.getElementById("lx-more").click();
    return seen;
  }, household);
  assert.deepEqual(await seen(false), { more: true, menu: true }, "the owner has both");
  assert.deepEqual(await seen(true), { more: false, menu: false }, "somebody else's profile has neither");
  await page.evaluate(async () => (await import("/app.js")).noteWindowProfile(true));
  await openFromMore(page);
  await page.evaluate(async () => (await import("/app.js")).noteWindowProfile(false));
  await page.locator("#ew-dialog").waitFor({ state: "detached" });
  await page.close();
});

test("the terminal takes keys, and /mode changes only the preview", async (t) => {
  const f = await fixture(t);
  const { page, errors } = await f.open();
  await everything(page, false);
  const written = writes(page);
  await openFromMore(page);
  const conv = page.locator(".ew-tui-conv");
  await page.keyboard.press("y");
  await page.waitForFunction(() => document.querySelector(".ew-tui-conv").innerText.includes("Northline is the pick"));
  assert.match(await conv.innerText(), /✓ Ran a command/);
  await page.keyboard.type("hello there");
  assert.match(await conv.innerText(), /› hello there▌/);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".ew-tui-conv").innerText.includes("May it run this command?"));
  await page.keyboard.press("n");
  await page.waitForFunction(() => document.querySelector(".ew-tui-conv").innerText.includes("I did not run it"));
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#ew-dialog").isVisible(), true, "Esc in the terminal waits for a number");
  await page.keyboard.press("2");
  assert.equal(await text(page, ".ew-tui-places .on"), "2 Inbox");
  assert.match(await conv.innerText(), /✓ Finished {2}Supplier quotes this week/);
  await page.keyboard.press("Alt+1");
  await page.keyboard.press("Control+k");
  assert.match(await conv.innerText(), /^Find anything/);
  await page.keyboard.type("tidy");
  await page.keyboard.press("Enter");
  assert.match(await text(page, ".ew-tui-top"), /Tidy the Downloads folder/);
  await page.keyboard.type("/mode");
  await page.keyboard.press("Enter");
  assert.match(await conv.innerText(), /How much may it do in this conversation\?/);
  await page.keyboard.press("Enter");
  assert.match(await text(page, ".ew-tui-r"), /^Auto · Sample model$/);
  assert.match(await conv.innerText(), /Auto for this conversation, in this preview only\./);
  await page.keyboard.type("go on");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+c");
  await page.waitForFunction(() => document.querySelector(".ew-tui-conv").innerText.includes("■ Stopped. Nothing else runs."));
  assert.deepEqual(written, [], "nothing in the preview reached the server");
  assert.deepEqual(errors, []);
});

test("an approval answered on the phone shows on the tablet and in the terminal, and nowhere real", async (t) => {
  const f = await fixture(t);
  const { page, errors } = await f.open({ width: 860 });
  await everything(page, true);
  const written = writes(page);
  await openFromWorkspaceMenu(page);
  await page.locator('.ew-tab[data-tab="iphone"]').click();
  await page.locator(".ew-dv-row", { hasText: "Supplier quotes this week" }).click();
  await page.locator(".ew-dv-ask").getByRole("button", { name: "Yes" }).click();
  await page.locator(".ew-dv-msg", { hasText: "Northline is the pick" }).waitFor();
  await page.locator("#ew-ph-in").fill("Send it to me tonight");
  await page.locator("#ew-ph-in").press("Enter");
  await page.locator(".ew-dv-msg", { hasText: "Got it." }).waitFor();
  await page.locator('.ew-tab[data-tab="tablet"]').click();
  assert.match(await text(page, ".ew-dv-main"), /✓ Approved[\s\S]*Northline is the pick[\s\S]*Send it to me tonight/);
  await page.locator('.ew-tab[data-tab="terminal"]').click();
  assert.match(await text(page, ".ew-tui-conv"), /✓ Ran a command[\s\S]*Northline is the pick[\s\S]*Send it to me tonight/);
  await page.locator('.ew-tab[data-tab="android"]').click();
  await page.locator(".ew-dv-nav button", { hasText: "Settings" }).click();
  await page.locator(".ew-dv-row", { hasText: "Permissions" }).click();
  await page.locator("#ew-dialog").getByLabel("Read replies aloud").check();
  assert.deepEqual(written, [], "nothing in the preview reached the server");
  assert.deepEqual(errors, []);
});

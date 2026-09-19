/* Redesign phase 2, shell (the window): the Trunks strip, Branch's own menu on a face, the Add a
   Trunk studio with its one tab strip, Overview and People, "Who is using Branch", the faces on
   replies, the 3D stand-in, and a household person seeing none of the owner's. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
const MODULES = ["faces.js", "strip.js", "studio.js", "pairing.js", "overview.js", "people-place.js"];
const PREFIXES = ["strip.", "studio.", "pair.", "ov.", "household.", "shellLook.", "place.overview", "place.household"];

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-shell-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A style the page's rules refuse, or a face drawn with a broken path, shows up here.
  // (settings-describe.js and settings-kit.js already make CSP complaints of their own on trunk; those are not this work's.)
  page.on("console", (message) => {
    const mine = /\/(faces|strip|studio|pairing|overview|people-place|trunks)\.js/.test(message.location().url ?? "");
    if (message.type() === "error" && (mine || /attribute d:/.test(message.text()))) errors.push(message.text().slice(0, 200));
  });
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.locator("body.lx-ready").waitFor({ state: "attached" });
    await page.locator("#trunk-strip .strip-brand").waitFor({ state: "visible", timeout: 15000 });
  };
  const refresh = () => page.evaluate(async () => (await import("/strip.js")).refresh());
  return { app, server, call, page, errors, open, refresh };
}
async function withTrunk(f, name = "Scout", look = { face: "letters", letters: "SC", colour: 3, shape: "leaf" }) {
  await f.call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await f.call("/api/trunks", { name, title: "Watches prices", description: "" });
  await f.call(`/api/trunks/${trunk.id}`, { look });
  return trunk;
}
const trunkFace = (page, id) => page.locator(`#trunk-strip [data-strip-id="trunk:${id}"] .strip-face`);
/** No word on screen is still its key: every key the shell draws is in the language file. */
async function untranslated(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-t]")].filter((node) => node.checkVisibility() && node.textContent.trim() === node.dataset.t).map((node) => node.dataset.t));
}

test("the shell's modules write no colour and build no markup from text, and every word is in English and real French", async () => {
  for (const file of [...MODULES, "trunks.js"]) {
    const source = await readFile(new URL(`../public/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `${file} writes no colour`);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, `${file} builds nothing from text`);
  }
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const fr = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const mine = Object.keys(en).filter((key) => PREFIXES.some((prefix) => key.startsWith(prefix)));
  assert.ok(mine.length > 200);
  for (const key of mine) {
    assert.ok(fr[key], `${key} has French`);
    assert.notEqual(fr[key], en[key], `${key} is really translated`);
  }
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const tag of ['<script src="/strip.js" type="module">', '<link rel="stylesheet" href="/faces.css" />', '<link rel="stylesheet" href="/strip.css" />'])
    assert.ok(html.includes(tag), tag);
});

test("the strip sits at the left edge with this computer and each Trunk's own face, and opens a Trunk's conversation", async (t) => {
  const f = await fixture(t);
  const trunk = await withTrunk(f);
  await f.open();
  const strip = await f.page.locator("#trunk-strip").boundingBox();
  assert.ok(strip.x < 20 && strip.width < 90 && strip.height > 800, "a narrow strip down the left edge");
  const rail = await f.page.locator("#conversation-rail").boundingBox();
  assert.ok(rail.x >= strip.x + strip.width, "the sidebar starts after it, nothing covered");
  assert.equal(await f.page.locator('#trunk-strip [data-strip-id="here"]').getAttribute("aria-current"), "true");
  const face = trunkFace(f.page, trunk.id);
  assert.match(await face.getAttribute("aria-label"), /^Scout, Trunk, /);
  assert.equal(await face.locator(".fc-letters").getAttribute("data-text"), "SC", "its own letters");
  assert.equal(await face.locator(".face").evaluate((node) => node.style.getPropertyValue("--c")), "var(--series-3)", "its own colour, a token");
  assert.match(await face.locator(".face").evaluate((node) => node.style.getPropertyValue("--m")), /data:image\/svg\+xml/, "its own shape");
  await face.click();
  await f.page.waitForFunction((id) => document.getElementById("conversation").dataset.sessionId === id, trunk.chatSessionId);
  await f.page.waitForFunction((id) => document.querySelector(`#trunk-strip [data-strip-id="trunk:${id}"]`)?.getAttribute("aria-current") === "true", trunk.id);
  await f.call("/api/shell-look", { strip: "off" });
  await f.refresh();
  assert.equal(await f.page.locator("#trunk-strip").count(), 0, "switched off, the strip is gone");
  assert.equal(await f.page.evaluate(() => document.body.classList.contains("lx-strip")), false, "and the window has its space back");
  assert.deepEqual(f.errors, []);
});

test("on a phone the strip is a row at the foot that never covers the message box or scrolls the page sideways", async (t) => {
  const f = await fixture(t, { width: 390, height: 844 });
  await withTrunk(f);
  await f.open();
  const strip = await f.page.locator("#trunk-strip").boundingBox();
  assert.ok(strip.y > 760 && strip.width > 350, "a row at the foot");
  const prompt = await f.page.locator("#prompt").boundingBox();
  assert.ok(prompt.y + prompt.height <= strip.y, "the message box stays above it");
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  assert.ok(await f.page.locator("#send").isVisible());
  assert.deepEqual(f.errors, []);
});

test("right-click on a Trunk opens Branch's own menu, never the browser's, and its order, pin and hiding are real", async (t) => {
  const f = await fixture(t);
  const scout = await withTrunk(f, "Scout");
  const ledger = await withTrunk(f, "Ledger", { face: "emoji", emoji: "📒", colour: 7, shape: "shield" });
  await f.open();
  const prevented = await trunkFace(f.page, scout.id).evaluate((node) => !node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 200 })));
  assert.equal(prevented, true, "the browser's menu does not open");
  await f.page.locator("#strip-menu").waitFor({ state: "visible" });
  await f.page.locator("#strip-menu").getByRole("menuitem", { name: "Move down" }).click();
  const order = async () => f.page.locator('#trunk-strip [data-strip-id^="trunk:"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.stripId));
  await f.page.waitForFunction((id) => document.querySelectorAll('#trunk-strip [data-strip-id^="trunk:"]')[1]?.dataset.stripId === `trunk:${id}`, scout.id);
  assert.deepEqual(await order(), [`trunk:${ledger.id}`, `trunk:${scout.id}`]);
  await trunkFace(f.page, scout.id).click({ button: "right" });
  await f.page.locator("#strip-menu").getByRole("menuitem", { name: "Hide from the strip and sidebar" }).click();
  await f.page.waitForFunction((id) => !document.querySelector(`#trunk-strip [data-strip-id="trunk:${id}"]`), scout.id);
  assert.equal((await f.call(`/api/trunks/${scout.id}`)).trunk.hidden, true);
  await trunkFace(f.page, ledger.id).click({ button: "right" });
  await f.page.keyboard.press("Escape");
  await f.page.locator("#strip-menu").waitFor({ state: "detached" });
  assert.deepEqual(f.errors, []);
});

test("Change look… edits a Trunk after it is made: face, emoji, colour, shape and movement are saved", async (t) => {
  const f = await fixture(t);
  const trunk = await withTrunk(f);
  await f.open();
  await trunkFace(f.page, trunk.id).click({ button: "right" });
  await f.page.getByRole("menuitem", { name: "Change look…" }).click();
  const dialog = f.page.locator("#studio");
  await dialog.getByRole("heading", { name: "Change Scout" }).waitFor();
  assert.equal(await dialog.locator(".studio-tabs").count(), 0, "changing one has no Add tabs");
  await dialog.getByRole("button", { name: "Emoji", exact: true }).click();
  await dialog.locator('.studio-emoji-pick[data-emoji="🦉"]').click();
  await dialog.getByRole("button", { name: "Colour 5" }).click();
  await dialog.getByRole("button", { name: "Hexagon" }).click();
  await dialog.getByRole("button", { name: "Breathe" }).click();
  assert.equal(await dialog.locator("#studio-preview .studio-big .fc-emoji").getAttribute("data-text"), "🦉", "the preview follows");
  assert.deepEqual(await untranslated(f.page), []);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const look = (await f.call(`/api/trunks/${trunk.id}`)).trunk.look;
  assert.deepEqual([look.face, look.emoji, look.colour, look.shape, look.motion], ["emoji", "🦉", 5, "hexagon", "breathe"]);
  await f.page.waitForFunction((id) => document.querySelector(`#trunk-strip [data-strip-id="trunk:${id}"] .fc-emoji`)?.dataset.text === "🦉", trunk.id);
  assert.deepEqual(f.errors, []);
});

test("Add a Trunk: switched off it says so and offers the switch; the tab strip stays and pairing has a Back", async (t) => {
  const f = await fixture(t);
  await f.open();
  await f.page.locator("#trunk-strip .strip-add").click();
  const dialog = f.page.locator("#studio");
  await dialog.getByText("Trunks are switched off.").waitFor();
  await dialog.getByRole("button", { name: "Switch Trunks on" }).click();
  await dialog.locator("#studio-name").fill("Gardener");
  await dialog.getByRole("button", { name: "Letters", exact: true }).click();
  await dialog.getByRole("button", { name: "Pebble" }).click();
  await dialog.getByRole("tab", { name: "Another computer" }).click();
  assert.equal(await dialog.getByRole("tab", { name: "Another computer" }).getAttribute("aria-selected"), "true", "the same dialog, the same tabs");
  await dialog.locator('.pair-card[data-mode="invite"]').click();
  await dialog.getByRole("button", { name: "Switch it on" }).click();
  await dialog.locator("#pair-number").waitFor();
  assert.match(await dialog.locator("#pair-number").innerText(), /^\d{3} \d{3}$/);
  assert.match(await dialog.locator("#pair-link").innerText(), /\/devices\/pair\?offer=/);
  assert.ok(await dialog.getByText(/only answers on this computer itself/).isVisible(), "an address only this computer can reach is said plainly");
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.getByText("Stop pairing?").waitFor();
  await dialog.getByRole("button", { name: "Keep pairing" }).click();
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.locator('.pair-card[data-mode="join"]').waitFor();
  await dialog.locator('.pair-card[data-mode="join"]').click();
  await dialog.locator("#join-link").waitFor();
  await dialog.getByRole("tab", { name: "Your phone" }).click();
  await dialog.locator(".devices-qr").waitFor();
  await dialog.getByRole("tab", { name: "A new Trunk" }).click();
  await dialog.getByText("Stop pairing?").waitFor();
  assert.equal(await dialog.getByRole("tab", { name: "Your phone" }).getAttribute("aria-selected"), "true", "leaving an open invitation asks first");
  await dialog.getByRole("button", { name: "Stop pairing" }).click();
  await dialog.locator("#studio-name").waitFor();
  assert.deepEqual(await untranslated(f.page), []);
  await dialog.locator("#studio-name").fill("Gardener");
  await dialog.getByRole("button", { name: "Create the Trunk" }).click();
  await dialog.waitFor({ state: "detached" });
  const made = (await f.call("/api/trunks")).trunks.find((entry) => entry.name === "Gardener");
  assert.ok(made, "the Trunk is made");
  assert.deepEqual([made.look.face, made.look.shape], ["letters", "pebble"], "with the look chosen before visiting the other tabs");
  await f.page.waitForFunction((id) => document.getElementById("conversation").dataset.sessionId === id, made.chatSessionId);
  assert.deepEqual(f.errors, []);
});

test("Overview and People are real, with faces; Who is using Branch lists everyone", async (t) => {
  const f = await fixture(t);
  await f.call("/api/profiles", { name: "Amara", pin: "4321" });
  await f.open();
  await f.page.locator("#trunk-strip .strip-brand").click();
  await f.page.locator(".ov-page").getByRole("heading", { name: "This computer" }).waitFor();
  assert.ok(await f.page.locator(".ov-page").getByText("Who uses it").isVisible());
  assert.ok(await f.page.locator(".ov-page .ov-row").filter({ hasText: "Amara" }).isVisible());
  await f.page.locator("#strip-people").click();
  const menu = f.page.locator("#who-menu");
  await menu.getByText("Who is using Branch").waitFor();
  assert.deepEqual(await menu.locator(".who-row b").allInnerTexts(), ["The owner", "Amara"]);
  assert.equal(await menu.locator('.who-row[data-profile="owner"]').getAttribute("aria-checked"), "true");
  await menu.getByRole("button", { name: "People…" }).click();
  await f.page.locator('.person-card[data-person]').nth(1).waitFor();
  assert.equal(await f.page.locator('.person-card[data-person] .face').count(), 2, "everyone has a face");
  assert.deepEqual(await untranslated(f.page), []);
  assert.deepEqual(f.errors, []);
});

test("a household person sees this computer and the people, and nothing of the owner's", async (t) => {
  const f = await fixture(t);
  await withTrunk(f);
  const person = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  await f.call("/api/profiles/switch", { profileId: person.id, pin: "1234" });
  await f.open();
  await f.page.waitForFunction(() => document.documentElement.dataset.household === "on");
  await f.refresh();
  assert.deepEqual(await f.page.locator("#trunk-strip [data-strip-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.stripId)), ["here"]);
  assert.equal(await f.page.locator("#trunk-strip .strip-add, #trunk-strip .strip-more").count(), 0, "no adding, no menus");
  await f.page.locator("#strip-people").click();
  await f.page.getByRole("button", { name: "People…" }).click();
  await f.page.locator(".people-page").waitFor();
  assert.deepEqual(await f.page.locator(".person-card").evaluateAll((nodes) => nodes.map((node) => node.dataset.person)), ["owner", person.id], "only their own card beside the owner's");
  assert.ok(await f.page.getByRole("button", { name: "Back to the owner" }).isVisible());
  assert.equal(await f.page.locator(".person-add").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("replies show the assistant's own face, and a Trunk set to 3D is a 3D stand-in only while 3D faces are on", async (t) => {
  const f = await fixture(t);
  const trunk = await withTrunk(f, "Scout", { face: "drawn", colour: 2, shape: "acorn", depth: "3d" });
  await f.call("/api/conversation-mode/settings", { newConversation: "follow" }).catch(() => undefined);
  await f.open();
  assert.equal(await trunkFace(f.page, trunk.id).locator(".face.is3d").count(), 0, "3D faces ship off");
  await f.call("/api/shell-look", { faces3d: "on" });
  await f.refresh();
  assert.equal(await trunkFace(f.page, trunk.id).locator(".face.is3d .depth .slab").count(), 6, "on, it is a thick tile");
  await f.page.locator("#prompt").fill("Say hello.");
  await f.page.locator("#send").click();
  const face = f.page.locator("#conversation .message.assistant > .message-face[data-assistant]").first();
  await face.waitFor({ timeout: 15000 });
  assert.equal(await face.evaluate((node) => node.nextElementSibling.tagName), "SMALL", "the face sits before the name");
  assert.equal(await f.page.locator('#conversation img[src*="keepoak-mark"]').count(), 0, "not Branch's logo");
  assert.deepEqual(f.errors, []);
});

test("every name gives a face with one of the eight colours and a whole mouth", async (t) => {
  const f = await fixture(t);
  await f.open();
  const broken = await f.page.evaluate(async () => {
    const { assistantSpec, face, trunkSpec } = await import("/faces.js");
    const bad = [];
    for (let n = 0; n < 300; n++) {
      const name = `Name ${n} ${String.fromCharCode(65 + (n % 26))}`;
      for (const spec of [trunkSpec({ name }), assistantSpec(name)]) {
        const drawn = face(spec, 28);
        const mouth = drawn.querySelector(".fc-mouth")?.getAttribute("d") ?? "";
        if (!/^var\(--series-[1-8]\)$/.test(spec.colour) || !/^M\d/.test(mouth)) bad.push(`${name}: ${spec.colour} ${mouth}`);
      }
    }
    return bad;
  });
  assert.deepEqual(broken, []);
  assert.deepEqual(f.errors, []);
});

/**
 * R17-A: the Trunks screens, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace.
 * Redesign: pointed at the new window (public/app, design/redesign/prototype.html pass 17). The Trunks card of
 * Customize › Specialists is now Customize › Trunks; the three-field create is the prototype's one-click "A new Trunk"
 * ("Trunk N for now") followed by its editor; rooms are the prototype's "New group chat"; the roster is the
 * sidebar's conversation list, where a Trunk's conversation is a row with its face.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const PROTOTYPE = new URL("../design/redesign/prototype.html", import.meta.url);

async function fixture(t, rules = [], { width = 400, height = 900 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain(rules) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  // Onboarding is marked done through the engine, and the update question answered, so neither covers the window.
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side .nav[data-v="customize"]').waitFor({ state: "attached", timeout: 120000 });
  };
  return { app, server, call, page, errors, open };
}

/* At this width the sidebar is folded away, so it is slid open first, as a person would (the head's menu button). */
async function sidebar(page, selector) {
  const control = page.locator(selector).first();
  await control.waitFor({ state: "attached" });
  const folded = () => page.evaluate(() => matchMedia("(max-width: 760px)").matches && !document.getElementById("app").classList.contains("side-open"));
  if (await folded()) await page.locator('button[data-act="side"]:visible').first().click();
  // It slides in: wait until it has arrived.
  await page.waitForFunction(() => Math.abs(document.getElementById("side").getBoundingClientRect().left) < 1);
  await control.waitFor({ state: "visible" });
  return control;
}
async function place(page, name, tab) {
  await (await sidebar(page, `#side .nav[data-v="${name}"]`)).click();
  await page.locator("#main .place h1").first().waitFor();
  if (tab) {
    await page.locator(`.tab[data-act="ptab"][data-place="${name}"][data-v="${tab}"]`).click();
    await page.waitForFunction(({ name, tab }) => document.querySelector(`.tab[data-place="${name}"][data-v="${tab}"]`)?.getAttribute("aria-selected") === "true", { name, tab });
  }
}
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const greyed = async (locator) => ({
  disabled: await locator.getAttribute("aria-disabled"),
  soon: await locator.evaluate((node) => node.classList.contains("soon")),
  tip: await locator.getAttribute("data-tip"),
});
const GREY = { disabled: "true", soon: true, tip: "Coming soon" };
/* The words as written (textContent): a heading styled in capitals is still the prototype's own words. */
const texts = (locator) => locator.evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));

test("every word on the Trunks screens is the prototype's, in English and then in French", async (t) => {
  const f = await fixture(t);
  const { trunk } = await f.call("/api/trunks", { name: "Ada", title: "Planner", description: "" });
  await f.open();
  const prototype = await readFile(PROTOTYPE, "utf8");
  const words = [];
  await place(f.page, "customize", "trunks");
  const card = f.page.locator("#main .place");
  words.push(...await card.locator(".tabs .tab").evaluateAll((tabs) => tabs.map((tab) => tab.firstChild.textContent.trim())));
  for (const text of ["A new Trunk", "A new room", "Start from a job", "Use this job", "Edit", "Pause"]) {
    assert.ok(await card.getByText(text, { exact: true }).first().isVisible(), `${text} is on the Trunks tab`);
    words.push(text);
  }
  await card.locator(`[data-act="edit"][data-id="${trunk.id}"]`).click();
  const editor = f.page.locator(".dlg");
  await editor.getByRole("heading", { name: "Edit Ada" }).waitFor();
  words.push(...await texts(editor.locator('[role="tab"]')), ...await texts(editor.locator("label")));
  await editor.getByRole("tab", { name: "What it may do" }).click();
  words.push(...await texts(editor.locator(".ctl > b")));
  await editor.getByRole("button", { name: "Cancel" }).click();
  await place(f.page, "customize", "trunks");
  await f.page.locator('[data-act="grp-new"]').click();
  const group = f.page.locator(".dlg");
  await group.getByRole("heading", { name: "New group chat" }).waitFor();
  words.push(...await texts(group.locator(".fld > span:first-child")), ...await texts(group.locator(".ctl > b")));
  await group.getByRole("button", { name: "Cancel" }).click();
  const missing = [...new Set(words.map((word) => word.trim()).filter(Boolean))].filter((word) => !prototype.includes(word));
  assert.deepEqual(missing, [], "no word on the Trunks screens that the prototype does not have");
  assert.deepEqual(f.errors, []);
  /* French: the prototype's Settings › Appearance › Language offers Français, and the design says every screen switches
     (BRANCH-DESIGN-INTENT.md, stand-in notes). */
  await place(f.page, "customize", "trunks");
  await (await sidebar(f.page, '#side [data-act="view"][data-v="settings"]')).click();
  await f.page.locator('.set-nav [data-act="setpage"][data-v="appearance"]').click();
  const language = f.page.locator("#lang");
  await language.waitFor();
  assert.ok((await language.locator("option").allInnerTexts()).includes("Français"));
  assert.equal(await language.isEnabled(), true, "window bug: Language is greyed and the window has no French, so no Trunks screen can be read in French");
});

test("renaming the active Trunk updates the shell target immediately", async (t) => {
  const f = await fixture(t);
  const { trunk } = await f.call("/api/trunks", { name: "Ada", title: "", description: "" });
  await f.app.trunks.introduced();
  await f.open();
  await (await sidebar(f.page, `#side .row[data-id="${trunk.chatSessionId}"]`)).click();
  await f.page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", trunk.chatSessionId);
  await f.page.locator('[data-act="chatmenu"]:visible').first().click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "Edit Trunk…" }).click();
  const editor = f.page.locator(".dlg");
  await editor.getByRole("heading", { name: "Edit Ada" }).waitFor();
  await editor.locator("#st-name").fill("Ada Bloom");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(f.app.trunks.records.list()[0].name, "Ada Bloom");
  // The conversation's own menu is Ada Bloom's at once, without a reload.
  await f.page.locator('[data-act="chatmenu"]:visible').first().click();
  await f.page.locator(".pop").getByRole("menuitem", { name: "Edit Trunk…" }).click();
  await f.page.locator(".dlg").getByRole("heading", { name: "Edit Ada Bloom" }).waitFor();
  await f.page.locator(".dlg").getByRole("button", { name: "Cancel" }).click();
  assert.deepEqual(f.errors, []);
  /* The prototype's conversation header (renderChat) and sidebar row (rowHtml) show the Trunk's face and name. */
  const header = f.page.locator(".head .who b:visible").first();
  await f.page.waitForFunction(() => [...document.querySelectorAll(".head .who b")].some((b) => b.textContent === "Ada Bloom"), undefined, { timeout: 5000 }).catch(() => undefined);
  assert.equal(await header.innerText(), "Ada Bloom", "window bug: a Trunk's conversation header shows its first message, not the Trunk's name");
});

const rules = [({ last, system }) => {
  const text = last?.content ?? "";
  if (text.startsWith("[Room") && /\nYou are Ada \(@ada\)/.test(system)) return "I can do it. @you which day?";
  if (text.startsWith("[Room")) return "(pass)";
  return null;
}];

test("the card, the three-field create, Edit Trunk, a room, the roster and @ in the message box, with nothing scrolling sideways", async (t) => {
  const f = await fixture(t, rules);
  const { page, app } = f;
  await f.open();
  const until = async (check) => { for (let i = 0; i < 200 && !(await check()); i++) await page.waitForTimeout(50); };

  // The card: Customize › Trunks, empty until a Trunk is made.
  await place(page, "customize", "trunks");
  const card = page.locator("#main .place");
  assert.equal(await card.locator("h1").innerText(), "Customize");
  assert.equal(await card.locator('.tab[data-v="trunks"]').getAttribute("aria-selected"), "true");
  assert.equal(await card.locator('.prow [data-act="edit"]').count(), 0, "no Trunk yet");
  assert.equal(await wide(page), false, "no sideways scrolling in Customize");

  // The create: "A new Trunk" makes "Trunk 1" and opens its conversation; its name and what it is for come from its editor.
  await card.getByRole("button", { name: "A new Trunk" }).click();
  await until(async () => app.trunks.records.list().length === 1);
  const made = app.trunks.records.list()[0];
  assert.equal(made.name, "Trunk 1");
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", made.chatSessionId);
  await app.trunks.introduced();

  // Edit Trunk opens its fields.
  await place(page, "customize", "trunks");
  await card.locator(`[data-act="edit"][data-id="${made.id}"]`).click();
  const editor = page.locator(".dlg");
  await editor.getByRole("heading", { name: "Edit Trunk 1" }).waitFor();
  for (const id of ["st-name", "st-role", "st-photo"]) assert.equal(await editor.locator(`#${id}`).count(), 1, id);
  assert.equal(await editor.locator('[data-act="st-colour"]').count(), 8, "the prototype's eight colours");
  assert.equal(await editor.locator('[data-act="st-shape"]').count(), 5, "its five shapes");
  await editor.locator("#st-name").fill("Ada");
  await editor.locator("#st-role").fill("Planner");
  // Redesign: what a Trunk may do stays greyed in the window: loosening a Trunk is held for separate security review.
  await editor.getByRole("tab", { name: "What it may do" }).click();
  assert.deepEqual(await greyed(editor.locator("#tm-read")), GREY);
  assert.equal(await editor.locator("#tm-read").isDisabled(), true);
  assert.deepEqual(await greyed(editor.getByRole("button", { name: "Ask first" })), GREY);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  await until(async () => app.trunks.records.list()[0].name === "Ada");
  const ada = app.trunks.records.list()[0];
  assert.deepEqual([ada.name, ada.title, ada.handle], ["Ada", "Planner", "ada"]);
  await card.locator(".prow").filter({ hasText: "Ada" }).first().waitFor();
  assert.equal(await wide(page), false, "no sideways scrolling in the editor");

  // The roster: Ada's conversation is a row in the sidebar's list, with her face.
  const row = await sidebar(page, `#side .row[data-id="${ada.chatSessionId}"]`);
  assert.equal(await row.locator(".avw .av").count(), 1, "the row has her face");
  await page.keyboard.press("Escape");

  // A room: two Trunks, one @you.
  const { trunk: bo } = await f.call("/api/trunks", { name: "Bo", title: "", description: "" });
  await app.trunks.introduced();
  await place(page, "customize", "trunks");
  await card.getByRole("button", { name: "A new room" }).click();
  const group = page.locator(".dlg");
  await group.getByRole("heading", { name: "New group chat" }).waitFor();
  await group.locator("#grp-name").fill("Trip");
  await group.locator('[data-act="grp-pick"]').filter({ hasText: "Ada" }).click();
  await group.locator('[data-act="grp-pick"]').filter({ hasText: "Bo" }).click();
  assert.equal(await group.locator("#grp-name").inputValue(), "Trip", "the name is kept while picking");
  const who = page.waitForResponse((response) => /\/api\/trunks\/conversations\/[^/?]+$/.test(new URL(response.url()).pathname));
  await group.getByRole("button", { name: "Start the group chat" }).click();
  await group.waitFor({ state: "detached" });
  await until(async () => app.trunks.rooms.list().length === 1);
  const room = app.trunks.rooms.list()[0];
  assert.deepEqual([...room.members].sort(), [ada.id, bo.id].sort());
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", room.sessionId);
  await who;
  await page.locator("#prompt").fill("Where shall we go?");
  await page.locator("#prompt").press("Enter");
  await until(async () => app.store.messages(room.sessionId).some((m) => m.content === "Where shall we go?"));
  await app.trunks.rooms.settled(room.id);
  const reply = page.locator("#main .b").filter({ hasText: "I can do it. @you which day?" }).first();
  await reply.waitFor({ timeout: 30000 });
  assert.equal(await reply.locator(".from").innerText(), "Ada", "the reply is signed with who wrote it");
  assert.equal(await reply.locator(".txt").innerText(), "I can do it. @you which day?", "without its @handle prefix");
  assert.equal(await wide(page), false, "no sideways scrolling with a room open");

  // "@" in the message box offers the Trunks; "@Ada …" goes to Ada.
  await (await sidebar(page, '#side [data-act="newmenu"]')).click();
  await page.locator(".pop").getByRole("menuitem", { name: "New conversation" }).click();
  await page.locator("#prompt").click();
  await page.locator("#prompt").pressSequentially("@ad");
  await page.locator('.pop [data-act="mention-pick"][data-v="Ada"]').waitFor();
  assert.equal(await page.locator(".pop .ph").first().textContent(), "Call a Trunk", "the list is headed as the prototype's");
  await page.locator("#prompt").press("Enter");
  assert.equal(await page.locator("#prompt").inputValue(), "@Ada ", "the prototype's mention-pick puts in the name");
  await page.locator("#prompt").pressSequentially("hello there");
  await page.locator("#prompt").press("Enter");
  await until(async () => app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"));
  assert.ok(app.store.messages(ada.chatSessionId).some((m) => m.content === "hello there"), "the message went to Ada's own conversation");
  assert.equal(await wide(page), false, "no sideways scrolling in the conversation");
  assert.deepEqual(f.errors, []);

  // "Needs you": the room's @you. The prototype marks a waiting conversation's line in its row (rowHtml, p.attn).
  assert.equal(app.trunks.rooms.list()[0].needsYou, true, "the engine says the room needs you");
  const roomRow = await sidebar(page, `#side .row[data-id="${room.sessionId}"]`);
  assert.equal(await roomRow.locator("p.attn").count(), 1, "window bug: a room that needs you (GET /api/trunks rooms[].needsYou) is not marked in its row");
});

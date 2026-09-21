/* Redesign phase 2 "rooms": the window's side. The faces at the top of a conversation, choosing a
   Trunk, "@" in the message box, and a room drawn as a conversation with its questions answered in
   place. Headless only; nothing here opens a microphone. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Answers as whichever Trunk is speaking; Ledger asks to write a file when it is its turn in a room. */
const model = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const last = request.messages.at(-1), text = String(last?.content ?? "");
  const who = /\nYou are ([^(\n]+) \(@/.exec(system)?.[1]?.trim();
  if (last?.role === "tool") return { content: "Written.", toolCalls: [] };
  if (text.startsWith("[Room") && who === "Ledger")
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 7)}`, name: "files.write", arguments: JSON.stringify({ path: "totals.csv", content: "x" }) }] };
  if (text.startsWith("[Room")) return { content: `${who} here, in the room.`, toolCalls: [] };
  return { content: who ? `${who} here.` : "Your assistant here.", toolCalls: [] };
} };

async function fixture(t, parts, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-rooms-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/conversation-mode/settings", { newConversation: "follow" });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  for (const part of ["trunks", ...parts]) await call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await call("/api/trunks", { name: "Scout", title: "Finds things" })).trunk;
  const ledger = (await call("/api/trunks", { name: "Ledger", title: "Keeps the books" })).trunk;
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => globalThis.branchRooms);
  return { app, call, page, errors, scout, ledger };
}
const send = async (page, text) => { await page.locator("#prompt").fill(text); await page.locator("#prompt").press("Enter"); };
/* The reply is on screen before the window has finished that send (it reloads the conversation, then
   the state): Send stays greyed until then, and a message sent in between goes nowhere. */
const readyToSend = (page) => page.waitForFunction(() => !document.getElementById("send").disabled);
const lastReply = (page) => page.locator("#conversation > .message.assistant").last();

test("with choosing a Trunk switched off, nothing new shows and @name goes to the Trunk's own chat as before", async (t) => {
  const f = await fixture(t, []);
  await f.page.evaluate(() => globalThis.branchRooms.refresh());
  assert.equal(await f.page.locator("#who-button").isVisible(), false);
  assert.equal(await f.page.locator("#who-hero").count(), 0);
  assert.equal(await f.page.evaluate(() => globalThis.branchRooms.handlesMentions()), false);
  // Integration review: the sidebar's roster is drawn once public/trunks.js knows the Trunks; on a busy
  // machine the message could go before that, as an ordinary message.
  await f.page.locator("#trunks-rail .trunk-face").nth(1).waitFor({ state: "attached" });
  await send(f.page, "@scout hello there");
  await f.page.waitForFunction((id) => document.getElementById("conversation").dataset.sessionId === id, f.scout.chatSessionId);
  assert.deepEqual(f.errors, []);
});

test("choosing who answers: Talking to on an empty conversation, then every reply signed by that Trunk", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await f.page.evaluate(() => globalThis.branchRooms.refresh());
  await f.page.locator("#who-hero").click();
  const pop = f.page.locator("#who-pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /Your assistant[\s\S]*Choose who answers here[\s\S]*Ledger[\s\S]*Scout/);
  await pop.getByRole("button", { name: /Scout/ }).click();
  await f.page.waitForFunction(() => document.getElementById("who-button")?.getAttribute("aria-label")?.includes("Scout"));
  await send(f.page, "Has the price moved?");
  await f.page.waitForFunction(() => /Scout here\./.test(document.querySelector("#conversation > .message.assistant:last-of-type")?.textContent ?? ""));
  await f.page.waitForFunction(() => document.querySelector("#conversation > .message.assistant:last-of-type")?.dataset.trunk);
  assert.match(await lastReply(f.page).locator("small").first().textContent(), /Scout/);
  await readyToSend(f.page);
  // Back to your assistant: the next reply is not Scout's, and Scout's reply keeps its name.
  await f.page.locator("#who-button").click();
  await f.page.locator("#who-pop").getByRole("button", { name: "Let your assistant answer here again" }).click();
  await send(f.page, "And you?");
  await f.page.waitForFunction(() => /Your assistant here\./.test([...document.querySelectorAll("#conversation > .message.assistant")].at(-1)?.textContent ?? ""));
  await f.page.waitForTimeout(400);
  const signs = await f.page.$$eval("#conversation > .message.assistant", (nodes) => nodes.map((node) => node.dataset.trunk ?? ""));
  assert.equal(signs.filter(Boolean).length, 1, "only Scout's reply carries Scout's face");
  assert.deepEqual(f.errors, []);
});

test("@ in the message box: the list offers the Trunks, Enter picks one, and sending makes it answer here", async (t) => {
  const f = await fixture(t, ["conversations"]);
  await send(f.page, "hello");
  await f.page.waitForFunction(() => /Your assistant here\./.test(document.getElementById("conversation").textContent));
  await readyToSend(f.page);
  await f.page.evaluate(() => globalThis.branchRooms.refresh());
  await f.page.locator("#prompt").fill("");
  await f.page.locator("#prompt").pressSequentially("@sco");
  const list = f.page.locator("#rooms-mentions");
  await list.waitFor({ state: "visible" });
  assert.match(await list.innerText(), /@scout[\s\S]*Answers here from this message on/);
  await f.page.locator("#prompt").press("Enter");
  assert.equal(await f.page.locator("#prompt").inputValue(), "@scout ", "Enter picks, it does not send");
  await f.page.locator("#prompt").pressSequentially("what now?");
  await f.page.locator("#prompt").press("Enter");
  await f.page.waitForFunction(() => /Scout here\./.test(document.getElementById("conversation").textContent));
  const info = await f.call(`/api/trunks/conversations/${await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId)}`);
  assert.equal(info.kind, "trunk");
  assert.equal(info.trunk.name, "Scout");
  assert.deepEqual(f.errors, []);
});

test("a room opens as a conversation: signed replies, a question answered in place, and the mode it follows", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"], { width: 390, height: 844 });
  const room = (await f.call("/api/trunks/rooms", { name: "Price check", members: [f.scout.id, f.ledger.id] })).room;
  await f.call("/api/conversation-mode", { sessionId: room.sessionId, mode: "ask" });
  await f.page.evaluate(async () => globalThis.branchRooms.refresh());
  assert.equal(await f.page.evaluate((id) => globalThis.branchOpenRoom(id), room.id), true);
  await f.page.waitForFunction(() => document.getElementById("conversation").dataset.room);
  await send(f.page, "@scout what is the price?");
  await f.page.waitForFunction(() => /Scout here, in the room\./.test(document.getElementById("conversation").textContent), null, { timeout: 15000 });
  assert.match(await f.page.locator(".rooms-reply").first().locator("small").textContent(), /Scout/);
  assert.equal(await f.page.locator("#conversation .message.user[data-rewind='room']").count(), 1, "no going back in a room");
  // Ledger is not mentioned yet: mentioning it in the room asks it, and under Ask first it waits for a yes.
  await send(f.page, "@ledger write the totals");
  const ask = f.page.locator(".rooms-ask");
  await ask.waitFor({ state: "visible", timeout: 15000 });
  assert.match(await ask.innerText(), /Ledger needs you/);
  assert.equal(existsSync(join(f.app.runtime.workspace, "totals.csv")), false, "nothing written before the yes");
  await ask.getByRole("button", { name: "Yes: Ledger may do this in this room, for up to an hour" }).click();
  await f.page.waitForFunction(() => /Written\./.test(document.getElementById("conversation").textContent), null, { timeout: 15000 });
  assert.equal(existsSync(join(f.app.runtime.workspace, "totals.csv")), true);
  const width = await f.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(width, 0, "nothing overflows sideways at 390");
  assert.deepEqual(f.errors, []);
});

test("bringing a second Trunk into a Trunk's conversation makes a room and opens it", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const started = await f.call("/api/trunks/conversations", { trunkId: f.scout.id });
  await f.page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, started.sessionId);
  await f.page.waitForFunction(() => document.getElementById("who-button")?.getAttribute("aria-label")?.includes("Scout"));
  await f.page.locator("#who-button").click();
  const pop = f.page.locator("#who-pop");
  assert.match(await pop.innerText(), /Bring another Trunk in[\s\S]*This makes a room with both of them/);
  await pop.getByRole("button", { name: /Ledger/ }).click();
  await f.page.waitForFunction(() => document.getElementById("conversation").dataset.room);
  assert.match(await f.page.locator("#who-button").getAttribute("aria-label"), /Scout, Ledger/);
  assert.equal(await f.page.locator("#thread-name").innerText(), "Scout and Ledger");
  assert.deepEqual(f.errors, []);
});

test("a private room shows its people and shared artifacts in the conversation", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Private bench", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  await f.call(`/api/trunks/rooms/${room.id}/artifacts`, { name: "brief.txt", content: "private oak plan" });
  await f.page.evaluate(async () => globalThis.branchRooms.refresh());
  assert.equal(await f.page.evaluate((id) => globalThis.branchOpenRoom(id), room.id), true);
  const card = f.page.locator(".rooms-artifacts");
  await card.waitFor({ state: "visible" });
  assert.match(await card.innerText(), /People here: Sam[\s\S]*brief\.txt[\s\S]*Shared by Owner[\s\S]*private oak plan/);
  await card.locator(".rooms-artifact-name").fill("notes.txt");
  await card.locator(".rooms-artifact-content").fill("only this room");
  await card.getByRole("button", { name: "Share", exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector(".rooms-artifacts")?.textContent?.includes("only this room"));
  assert.deepEqual(f.errors, []);
});

test("the owner can revoke a person's access to an existing room", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Private bench", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  await openPlace(f.page, "customize:specialists");
  await f.page.evaluate(async () => (await import("/trunks.js")).draw());
  const roomRow = f.page.locator(".trunks-room-row").filter({ hasText: "Private bench" });
  await roomRow.getByText("Change who may enter", { exact: true }).click();
  const samAccess = roomRow.getByRole("checkbox", { name: "Sam" });
  assert.equal(await samAccess.isChecked(), true);
  await samAccess.uncheck();
  await roomRow.getByRole("button", { name: "Save room access", exact: true }).click();
  let view;
  for (let attempt = 0; attempt < 80; attempt++) {
    view = await f.call(`/api/trunks/rooms/${room.id}`);
    if (!view.people.length) break;
    await f.page.waitForTimeout(25);
  }
  assert.deepEqual(view.people, []);
  assert.deepEqual(f.errors, []);
});

test("a named household member can open only a room they belong to in the real window", async (t) => {
  const f = await fixture(t, ["conversations", "rooms"]);
  const sam = await f.call("/api/profiles", { name: "Sam", pin: "1234" });
  const room = (await f.call("/api/trunks/rooms", {
    name: "Sam's room", members: [f.scout.id, f.ledger.id], people: [sam.id],
  })).room;
  await f.call(`/api/trunks/rooms/${room.id}/artifacts`, { name: "brief.txt", content: "members only" });
  await f.call("/api/profiles/switch", { profileId: sam.id, pin: "1234" });
  await f.page.evaluate(async () => globalThis.branchRooms.refresh());
  assert.equal(await f.page.evaluate((id) => globalThis.branchOpenRoom(id), room.id), true);
  await f.page.waitForFunction(() => document.getElementById("conversation")?.dataset.room);
  assert.match(await f.page.locator(".rooms-artifacts").innerText(), /People here: Sam[\s\S]*members only/);
  await send(f.page, "@scout hello from Sam");
  await f.page.waitForFunction(() => document.querySelector("#conversation .message.user small")?.textContent === "Sam");
  assert.deepEqual(f.errors, []);
});

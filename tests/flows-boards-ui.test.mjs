/**
 * R17-H: the flows-and-boards cards, opened the way a person opens them, at 400 px wide, in a headless
 * browser against a scratch workspace. Every word on them is behind a key with real French, every
 * control has a label and a sentence saying what it does, and focus view folds the steps away.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
/* DG-198: these cards live on Settings › Automations & inbox, some of them past Regular. */
const openAutomations = async (page) => {
  await openPlace(page, "settings:automations");
  await page.evaluate(() => globalThis.branchSettingsLevel.set("technical"));
};

import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { boardParts } from "../dist/flows-boards/settings.js";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the flows-and-boards cards has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("flows-boards.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/"(flowsBoards\.[a-zA-Z.]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 90);
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  const commands = ["commands.queue", "commands.busy", "commands.focus", "commands.installs"];
  assert.deepEqual([...keys, ...commands].filter((key) => !en[key] || !fr[key] || en[key] === fr[key]), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(source), false);
  assert.match(await readFile(new URL("index.html", PUBLIC), "utf8"), /<script src="\/flows-boards.js" type="module"><\/script>/);
});

const CARDS = {
  "flows-travel-card": ["settings:automations", "Go back in a flow"],
  "flows-recipes-card": ["settings:automations", "Checks for procedures"],
  "flows-board-card": ["settings:automations", "Shared board"],
  "flows-waiting-card": ["settings:automations", "Change the waiting line"],
  "flows-widgets-card": ["library:made", "Widgets the assistant built"],
  "flows-focus-card": ["settings:appearance", "Focus view"],
  "flows-installs-card": ["settings:automations", "Package and tool server requests"],
};

/** What is wrong with one card's shape, as it stands on screen. */
function shapeOf(cardId) {
  const card = document.getElementById(cardId);
  const shown = (node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const controls = [...card.querySelectorAll("input, select, textarea")].filter(shown);
  const filled = [...card.querySelectorAll("button")].filter((b) => shown(b) && !b.classList.contains("quiet-button") && !b.classList.contains("text-button"));
  return {
    home: card.dataset.home, tag: card.tagName, title: card.querySelector(":scope > :is(h2, h3)")?.textContent ?? "",
    headings: card.querySelectorAll("h2, h3").length, sentence: card.querySelector(":is(h2, h3) + p")?.textContent ?? "",
    filled: filled.length,
    unnamed: controls.filter((c) => !c.labels?.length).map((c) => c.id),
    undescribed: controls.filter((c) => !(c.getAttribute("aria-describedby") || "").split(/\s+/)
      .some((id) => document.getElementById(id)?.textContent.trim())).map((c) => c.id),
    keyless: [...card.querySelectorAll("h2, h3, label, button, summary")].filter((n) => !n.dataset.t).map((n) => n.textContent),
  };
}

async function signIn(page, server) {
  await page.goto(server.url + "/");
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#workspace").waitFor({ state: "visible", timeout: 120000 });
}

test("the cards sit in their homes with the card anatomy, work from the window, and nothing scrolls sideways", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-flows-boards-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  for (const part of boardParts) app.flowsBoards.setMode(part, { mode: "on" });
  // Something for each card to show: a flow run with its steps kept, a verified procedure, a card.
  app.registry.register({ name: "tests.echo", permission: "workflows.read", description: "test", parameters: z.object({}).passthrough(), execute: async () => ({ ok: true }) });
  const flow = app.flows.saveGraph({ name: "Echo", input: { topic: "text" }, state: { said: "anything" }, entry: "a",
    nodes: [{ id: "a", name: "Echo", kind: "tool", tool: "tests.echo", args: {}, input: {}, output: { said: "anything" } },
      { id: "b", name: "Echo again", kind: "tool", tool: "tests.echo", args: {}, input: {}, output: { said: "anything" } }],
    edges: [{ from: "a", to: "b" }] });
  await app.flows.settled(app.flows.startGraph(flow.id, { topic: "oak" }).runId);
  const context = app.runtime.context();
  const recipe = await app.registry.execute("procedures.propose", { name: "Echo once", preconditions: [], steps: [{ tool: "tests.echo", args: {}, expected: { ok: true } }] }, context);
  await app.registry.execute("procedures.verify", { id: recipe.id }, context);
  app.flowsBoards.kanban.add({ title: "Rake the leaves" }, "owner");
  await app.flowsBoards.installs.request({ kind: "mcp", name: "notes", server: { transport: "http", url: "https://mcp.example.com/mcp" }, why: "keep notes" }, "chat", "a chat app");

  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const [id, [home, title]] of Object.entries(CARDS)) {
    if (home === "settings:automations") await openAutomations(page);
    else await openPlace(page, home);
    await page.locator(`#${id} :is(h2, h3)`).waitFor({ state: "visible" });
    const shape = await page.evaluate(shapeOf, id);
    assert.equal(shape.home, home, id);
    assert.equal(shape.tag, "SECTION", id);
    assert.equal(shape.title, title, id);
    assert.equal(shape.headings, 1, id);
    assert.ok(shape.sentence.length > 20, `${id} says what it is for`);
    assert.equal(shape.filled, 1, `${id} has one filled button`);
    assert.deepEqual(shape.unnamed, [], `${id}: every control can be named`);
    assert.deepEqual(shape.undescribed, [], `${id}: every control says what it does`);
    assert.deepEqual(shape.keyless, [], `${id}: every word goes through a key`);
    assert.ok(await wide() <= 0, `${id}: no sideways scrolling at 400 px`);
  }

  await openAutomations(page);
  const board = page.locator("#flows-board-card");
  await board.locator("#flows-board-title").fill("Sweep the path");
  await board.getByRole("button", { name: "Add card" }).click();
  for (let i = 0; i < 100 && app.flowsBoards.kanban.view().lanes.todo.length < 2; i++) await page.waitForTimeout(50);
  assert.ok(app.flowsBoards.kanban.view().lanes.todo.some((card) => card.title === "Sweep the path"));

  await openAutomations(page);
  const needs = page.locator("#flows-installs-card");
  await needs.getByText("keep notes", { exact: false }).waitFor();
  await needs.getByRole("button", { name: "Approve", exact: true }).click();
  for (let i = 0; i < 100 && app.flowsBoards.installs.waiting().length; i++) await page.waitForTimeout(50);
  assert.equal(app.flowsBoards.installs.list()[0].status, "approved");
  await needs.getByText("Nothing was installed", { exact: false }).waitFor();

  assert.equal(await page.evaluate(() => globalThis.branchBusySend("00000000-0000-4000-8000-000000000000", "hi")), null,
    "while the choice is to wait, the message box keeps its own way");
  // Integration review: a steer the server refuses (a key on the phone, a conversation it cannot find)
  // hands the message back to the ordinary queue instead of losing it.
  await openAutomations(page);
  await page.locator("#flows-busy").selectOption("steer");
  await page.locator("#flows-waiting-card").getByRole("button", { name: "Save", exact: true }).click();
  for (let i = 0; i < 100 && app.flowsBoards.waiting.busyMode() !== "steer"; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => globalThis.branchBusySend("00000000-0000-4000-8000-000000000000", "hi")), null,
    "a refused steer leaves the message to the ordinary queue");
  assert.deepEqual(errors, []);
});

test("focus view folds away the steps and the in-between replies, and brings them back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-flows-focus-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  app.flowsBoards.setMode("focus", { mode: "on" });
  const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
  await signIn(page, server);
  await page.locator("#flows-focus-card").waitFor({ state: "attached" });
  const hidden = await page.evaluate(() => {
    const holder = document.getElementById("conversation");
    const add = (tag, className, text) => { const node = document.createElement(tag); node.className = className; node.textContent = text; node.dataset.test = text; holder.append(node); };
    add("div", "message user", "ask");
    add("details", "message assistant-step tool-step", "step");
    add("div", "message assistant", "thinking aloud");
    add("details", "message assistant-step tool-step", "step two");
    add("div", "message assistant", "final");
    add("div", "message user", "ask again");
    add("div", "message assistant", "second final");
    globalThis.branchFocusView(true);
    return [...holder.querySelectorAll("[data-test]")].filter((n) => getComputedStyle(n).display === "none").map((n) => n.dataset.test);
  });
  assert.deepEqual(hidden, ["step", "thinking aloud", "step two"]);
  const shown = await page.evaluate(async () => {
    const holder = document.getElementById("conversation");
    const later = document.createElement("details");
    later.className = "message assistant-step tool-step";
    later.dataset.test = "late step";
    holder.append(later);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lateHidden = getComputedStyle(later).display === "none";
    globalThis.branchFocusView(false);
    return { lateHidden, anyHidden: [...holder.querySelectorAll("[data-test]")].some((n) => getComputedStyle(n).display === "none") };
  });
  assert.deepEqual(shown, { lateHidden: true, anyHidden: false });
});

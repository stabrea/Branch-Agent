/* Redesign phase 1: how much the assistant may do, picked per conversation in the message box.
   Enforced in the runtime's own policy check, not only on the screen: these drive real tasks and the
   real check a model's tool call goes through. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, evaluatePolicy, PolicySchema, presetRules, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { heldMode, modeChoices, policyForMode, readConversationMode } from "../dist/conversation-mode.js";
import { sessionPlanAct } from "../dist/plan-act.js";

const off = PolicySchema.parse({});
const decide = (policy, tool, readOnly = false, resource) => evaluatePolicy(policy, { tool, target: "x", readOnly, resource }).decision;

test("each mode says what it means, even when the owner's setting is No approvals", () => {
  const ask = policyForMode(off, "ask"), plan = policyForMode(off, "plan"), auto = policyForMode(off, "auto"), full = policyForMode(off, "full");
  assert.equal(decide(off, "files.write"), "allow", "No approvals writes without asking");
  assert.equal(decide(ask, "files.write"), "ask", "Ask first asks before a write");
  assert.equal(decide(ask, "shell.execute"), "ask");
  assert.equal(decide(ask, "files.read", true), "allow", "and reading stays free");
  assert.equal(decide(plan, "files.write"), "deny", "Plan refuses a change outright");
  assert.equal(decide(plan, "shell.execute"), "deny");
  assert.equal(decide(plan, "files.read", true), "allow", "Plan still reads");
  assert.equal(decide(auto, "files.write"), "allow", "Auto writes in the workspace");
  assert.equal(decide(auto, "shell.execute"), "ask", "Auto asks before a command");
  assert.equal(decide(auto, "web.fetch"), "ask", "and before the web");
  assert.equal(decide(full, "files.write"), "allow");
});

test("a mode never lifts a refusal the owner wrote, and Ask first and Plan drop every yes", () => {
  const owner = PolicySchema.parse({ preset: "custom", rules: [
    { tool: "files.write", match: "secrets/*", decision: "deny" },
    { tool: "files.*", match: "*", decision: "allow" },
  ] });
  const at = (policy, target) => evaluatePolicy(policy, { tool: "files.write", target, readOnly: false }).decision;
  assert.equal(at(policyForMode(owner, "full"), "secrets/a"), "deny", "Full access keeps the owner's refusal");
  assert.equal(at(policyForMode(owner, "ask"), "notes/a"), "ask", "Ask first does not keep a broad yes");
  assert.equal(at(policyForMode(owner, "plan"), "notes/a"), "deny");
  const strict = PolicySchema.parse({ preset: "ask-before-changes", rules: presetRules("ask-before-changes") });
  assert.equal(decide(policyForMode(strict, "full"), "files.write"), "allow", "the owner may loosen one conversation");
});

test("somebody other than the owner never gets a mode looser than the owner's setting; Lockdown greys the loose ones", () => {
  assert.equal(heldMode({ mode: "full", planSet: false }, "ask-before-changes", false), null, "a person's Full access is ignored");
  assert.equal(heldMode({ mode: "plan", planSet: true }, "ask-before-changes", false), "plan", "but they may be stricter");
  assert.equal(heldMode({ mode: "full", planSet: false }, "ask-before-changes", true), "full");
  const locked = modeChoices("off", { locked: true, owner: true });
  assert.deepEqual(locked.filter((choice) => !choice.available).map((choice) => choice.mode), ["auto", "full"]);
  assert.match(locked.find((choice) => choice.mode === "full").why, /Lockdown is on/);
  const person = modeChoices("ask-before-changes", { locked: false, owner: false });
  assert.deepEqual(person.filter((choice) => !choice.available).map((choice) => choice.mode), ["auto", "full"]);
  const lockedPolicy = PolicySchema.parse({ preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "ask", remember: "never" }] });
  assert.equal(decide(policyForMode(lockedPolicy, "full", true), "files.write"), "ask", "under Lockdown Full access is still asked");
  assert.equal(decide(policyForMode(lockedPolicy, "plan", true), "files.write"), "deny", "and Plan can only tighten it");
});

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-conversation-mode-"));
  const provider = { name: "scripted", turn: 0, async complete(request) {
    provider.turn += 1;
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return script(provider.turn, String(asked));
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.testRoot = root;
  return app;
}
/** A model that writes a file on its first turn of each task, then says it is done. */
const writes = (file) => (turn) => turn % 2 === 1
  ? { content: "", toolCalls: [{ id: `c${turn}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "x" }) }] }
  : { content: "done", toolCalls: [] };

test("an Ask first conversation asks before a write even when the owner's setting is No approvals", async (t) => {
  const app = await fixture(t, writes("a.txt"));
  const asked = await app.runtime.run({ prompt: "write it", conversationMode: "ask" });
  assert.equal(asked.status, "needs_input", "the write waits for a yes");
  assert.equal(existsSync(join(app.runtime.workspace, "a.txt")), false);
  assert.equal(readConversationMode(app.store, app.runtime.owner, asked.sessionId).mode, "ask");
  const context = app.runtime.context({ runId: asked.id });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "ask",
    "and before a command");
  savePolicy(app.store, app.runtime.owner, { unmatchedCommands: "allow" });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "ask",
    "even with commands let through by the owner's setting");
  const other = await fixture(t, writes("b.txt"));
  const before = await other.runtime.run({ prompt: "write it" });
  assert.equal(before.status, "completed", "a conversation with no mode behaves exactly as before");
  assert.equal(readConversationMode(other.store, other.runtime.owner, before.sessionId), null);
});

test("a Plan conversation refuses changes and shows the plan first", async (t) => {
  const app = await fixture(t, writes("plan.txt"));
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "plan" });
  assert.equal(existsSync(join(app.runtime.workspace, "plan.txt")), false, "nothing was written");
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "plan.txt", content: "x" }, context).decision, "deny");
  assert.equal(app.runtime.checkPolicy("files.read", { path: "plan.txt" }, context).decision, "allow", "reading is free");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "show-plan", "Plan means Show me the plan first");
});

test("a task from a chat app is held to Ask first in a Full access conversation", async (t) => {
  const app = await fixture(t, writes("c.txt"));
  const first = await app.runtime.run({ prompt: "write it", conversationMode: "full" });
  assert.equal(first.status, "completed", "the owner's own task in Full access goes ahead");
  const outside = await app.runtime.run({ prompt: "write it again", sessionId: first.sessionId, source: "channel" });
  assert.equal(outside.status, "needs_input", "the 0.18.1 hold on outside tasks still stands");
});

async function served(t, script = writes("d.txt")) {
  const app = await fixture(t, script);
  const server = await startServer(app, { dataDir: join(app.testRoot, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, call };
}

test("the window's new conversation starts in the mode picked, and each change is checked", async (t) => {
  const { app, call } = await served(t);
  const fresh = await call("/api/conversation-mode");
  assert.equal(fresh.body.newConversation, "ask", "a new conversation starts on Ask first");
  assert.equal(fresh.body.following.preset, "off");
  const run = (await call("/api/run", { prompt: "write it", mode: "plan" })).body;
  assert.equal((await call(`/api/conversation-mode?sessionId=${run.sessionId}`)).body.mode, "plan");
  const picked = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "auto" });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.mode, "auto");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "just-do-it", "leaving Plan leaves the plan-first switch too");
  await call("/api/lockdown", { on: true });
  const locked = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "full" });
  assert.equal(locked.status, 403, "Lockdown refuses a looser mode");
  assert.match(locked.body.error, /Lockdown/);
  assert.equal((await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "ask" })).status, 200, "a stricter one is fine");
  await call("/api/lockdown", { on: false });
  assert.equal((await call("/api/conversation-mode", { sessionId: run.sessionId, mode: null })).body.mode, null, "and it can follow the setting again");
});

test("a household person may not pick a mode looser than the owner's setting", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const run = (await call("/api/run", { prompt: "hello" })).body;
  const choices = (await call(`/api/conversation-mode?sessionId=${run.sessionId}`)).body.choices;
  assert.deepEqual(choices.filter((c) => !c.available).map((c) => c.mode), ["auto", "full"]);
  const refused = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "full" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only the owner/);
  app.store.profiles.switch({ profileId: null });
});

test("agreeing a plan in a Plan conversation lets it act, asking first", async (t) => {
  const { planAgreed } = await import("../dist/conversation-mode-api.js");
  const app = await fixture(t, writes("e.txt"));
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "plan" });
  planAgreed(app, run.sessionId);
  assert.equal(readConversationMode(app.store, app.runtime.owner, run.sessionId).mode, "ask");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "just-do-it");
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "e.txt", content: "x" }, context).decision, "ask");
});

/* ---------------------------------------------------------------- the chip in the window */

async function windowFixture(t, script = () => ({ content: "Done.", toolCalls: [] })) {
  const { chromium } = await import("playwright");
  const { app, server, call } = await served(t, script);
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  return { app, server, call, page, errors };
}

test("the chip starts a new conversation on Ask first, and its menu asks before giving full access", async (t) => {
  const f = await windowFixture(t);
  const chip = f.page.locator("#mode-chip");
  await f.page.waitForFunction(() => document.getElementById("mode-chip")?.dataset.mode === "ask");
  assert.match(await chip.innerText(), /Ask first/);
  await f.page.locator("#prompt").fill("Tidy my notes");
  await f.page.locator("#send").click();
  await f.page.locator(".message.assistant").first().waitFor();
  const sessionId = await f.page.evaluate(() => document.getElementById("conversation").dataset.sessionId);
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, sessionId).mode, "ask", "the conversation was started on Ask first");
  await chip.click();
  const menu = f.page.locator("#mode-menu");
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await menu.locator(".mode-item b").allInnerTexts(), ["Ask first", "Plan", "Auto", "Full access", "Use my setting"]);
  await f.page.keyboard.press("ArrowDown");
  assert.equal(await f.page.evaluate(() => document.activeElement?.dataset.mode), "plan", "arrows move between the choices");
  await menu.locator('[data-mode="full"]').click();
  await menu.locator(".mode-confirm").waitFor();
  assert.match(await menu.innerText(), /without asking you first/);
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, sessionId).mode, "ask", "nothing changes before the warning is answered");
  await menu.getByRole("button", { name: "Give full access" }).click();
  await f.page.waitForFunction(() => document.getElementById("mode-chip").dataset.mode === "full");
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, sessionId).mode, "full");
  await chip.click();
  await menu.waitFor({ state: "visible" });
  await chip.click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

test("under Lockdown the looser modes are greyed with the reason, not hidden, and cannot be picked", async (t) => {
  const f = await windowFixture(t);
  await f.call("/api/lockdown", { on: true });
  await f.page.evaluate(() => globalThis.branchConversationMode.refresh());
  await f.page.waitForFunction(() => document.getElementById("mode-chip").dataset.locked === "true");
  await f.page.locator("#mode-chip").click();
  const full = f.page.locator('#mode-menu [data-mode="full"]');
  assert.equal(await full.getAttribute("aria-disabled"), "true");
  assert.match(await full.getAttribute("title"), /Lockdown is on/);
  assert.equal(await f.page.locator('#mode-menu [data-mode="auto"]').getAttribute("aria-disabled"), "true");
  assert.equal(await f.page.locator('#mode-menu [data-mode="plan"]').getAttribute("aria-disabled"), null);
  await full.click({ force: true });
  assert.equal(await f.page.locator(".mode-confirm").count(), 0, "a greyed choice does nothing");
  await f.call("/api/lockdown", { on: false });
  assert.deepEqual(f.errors, []);
});

test("a conversation from before keeps following the owner's setting, and says so", async (t) => {
  const f = await windowFixture(t);
  const old = (await f.call("/api/run", { prompt: "an older conversation" })).body;
  await f.page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, old.sessionId);
  await f.page.waitForFunction(() => document.getElementById("mode-chip").dataset.following === "true");
  assert.match(await f.page.locator("#mode-chip").getAttribute("title"), /Following your setting: No approvals/);
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, old.sessionId), null, "looking changed nothing");
  assert.deepEqual(f.errors, []);
});

test("the owner can have new conversations follow the setting instead, and only the owner", async (t) => {
  const { app, call } = await served(t);
  assert.equal((await call("/api/conversation-mode")).body.settings.newConversation, "ask", "Ask first is the default");
  assert.equal((await call("/api/conversation-mode/settings", { newConversation: "follow" })).body.settings.newConversation, "follow");
  assert.equal((await call("/api/conversation-mode")).body.newConversation, null, "the window then starts conversations on the setting");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await call("/api/conversation-mode/settings", { newConversation: "ask" });
  assert.ok([400, 403].includes(refused.status), `a household person is refused (${refused.status})`);
  app.store.profiles.switch({ profileId: null });
});

test("in the window, a new conversation on Ask first stops before its first write, though the setting is No approvals", async (t) => {
  const f = await windowFixture(t, (turn, asked) => (asked.includes("note") && turn % 2 === 1
    ? { content: "", toolCalls: [{ id: `w${turn}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] }
    : { content: "Written.", toolCalls: [] }));
  await f.page.waitForFunction(() => document.getElementById("mode-chip")?.dataset.mode === "ask");
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  await f.page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await f.page.locator("#live-ask").innerText(), /note\.txt/);
  assert.equal(existsSync(join(f.app.runtime.workspace, "note.txt")), false, "nothing written before the yes");
  assert.deepEqual(f.errors, []);
});

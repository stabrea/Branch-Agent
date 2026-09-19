/**
 * mac7/residuals: the leftovers reviewers found on 2026-09-19 (docs/agents/STATUS-residuals.md).
 * Each test fails with its fix taken out. A stand-in model and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { replayRun } from "../dist/replay.js";
import { keyAnswerRefusal, runOrigin, underShortLivedKey } from "../dist/key-context.js";
import { accessRefusal, keyRefusal } from "../dist/devices/tools.js";
import { TrunkMessages } from "../dist/trunks/messages.js";
import { fixture as trunksFixture, on } from "./trunks-helpers.mjs";
import { PassThrough } from "node:stream";
import { AcpConnection } from "../dist/acp.js";
import { AppServerConnection } from "../dist/asks/app-server.js";

/** A model that calls the tool the newest message names ("please <tool> <json>"), then says it is done. */
function scripted() {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => {
    model.requests.push(request);
    const last = request.messages.at(-1);
    const asked = /please ([a-z_.]+) (\{.*\})$/s.exec(last?.role === "user" ? String(last.content) : "");
    if (asked) return { content: "", toolCalls: [{ id: `c${model.requests.length}`, name: asked[1], arguments: asked[2] }] };
    return { content: "Done.", toolCalls: [] };
  };
  return model;
}
async function fixture(t, provider = scripted()) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider, home: join(root, "home") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;

test("1. Do this again on a short-lived key's task is held as that key's work, not the owner's own", async (t) => {
  const { app } = await fixture(t);
  const first = await underShortLivedKey(() => app.runtime.run({ prompt: "hello" }), { keyId: "k1" });
  assert.equal(started(app, first.id).shortLivedKey, true);
  // The owner presses "Do this again" in the window: no key behind this request.
  const again = (await replayRun(app.runtime, app.store, first.id)).run;
  assert.equal(started(app, again.id).shortLivedKey, true, "the copy is marked as a key's work");
  assert.deepEqual(runOrigin(app.store, again.id).keyIds, ["k1"], "and names the key");
  assert.equal(accessRefusal({ store: app.store }, { runId: again.id }), keyRefusal, "owner-only tools refuse it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k2" }) !== null, true, "another key may not answer it");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(app.store, again.id), { keyId: "k1" }), null, "its own key may");
  // The owner's own task done again is unchanged.
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = (await replayRun(app.runtime, app.store, mine.id)).run;
  assert.equal(started(app, own.id).shortLivedKey, undefined);
  assert.equal(started(app, own.id).originFrom, undefined);
});

test("2. A Trunk's message whose task stops to ask waits for a yes: not failed, no failure notice, answered after", async (t) => {
  const { app } = await trunksFixture(t);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.messages.close(); // only the copy under test follows the tasks
  const sent = [];
  const messages = new TrunkMessages(app.store, app.runtime.owner, app.trunks.records,
    { followUp: (sessionId, prompt, _person, carry) => { sent.push({ sessionId, prompt, carry }); return { id: "q", position: 1, queued: 1 }; } });
  t.after(() => messages.close());
  const own = await app.runtime.run({ prompt: "hi", sessionId: ann.chatSessionId });
  messages.send({ ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` }, { to: "ben", message: "ping" });
  const task = (prompt, status, output) => {
    const run = app.store.createRun(app.runtime.owner, prompt, ben.chatSessionId);
    app.store.event(run.id, "run.started", {});
    app.store.event(run.id, "run.finished", { status, output });
    return run;
  };
  task(sent[0].prompt, "needs_input", "May I write ben.txt?");
  const receipt = () => messages.receipts(ben.id).find((r) => r.kind === "message");
  assert.equal(receipt().status, "waiting", "waiting for a yes, not failed");
  assert.equal(sent.length, 1, "no failure notice goes back to Ann");
  // The owner says yes and sends the next message in Ben's conversation; that task's answer is the reply.
  const next = task("Go ahead.", "completed", "Written.");
  assert.equal(receipt().status, "answered");
  assert.equal(receipt().runId, next.id);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].sessionId, ann.chatSessionId);
  assert.match(sent[1].prompt, /^Reply from Ben \(@ben\) to your message:\nWritten\./);
  // Two messages waiting in the same conversation: the owner's answers take the oldest first, one each.
  for (const words of ["one", "two"]) {
    messages.send({ ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` }, { to: "ben", message: words });
    task(sent.at(-1).prompt, "needs_input", "May I?");
  }
  const waiting = () => messages.receipts(ben.id).filter((r) => r.kind === "message" && r.status === "waiting").map((r) => r.prompt);
  assert.equal(waiting().length, 2);
  task("Yes to the first.", "completed", "First done.");
  assert.deepEqual(waiting().map((p) => p.endsWith("two")), [true], "the older one was answered, the newer still waits");
});

test("3. A2A, ACP and the app-server carry on only conversations they began; the owner's is refused in plain words", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const mine = await app.runtime.run({ prompt: "hello" });
  const refused = /only carry on a conversation it started itself/;
  const text = (words) => ({ role: "user", parts: [{ type: "text", text: words }] });
  app.a2a.enabled = () => true;
  await assert.rejects(app.a2a.send({ sessionId: mine.sessionId, message: text("park this") }, "other"), refused);
  await assert.rejects(app.a2a.send({ sessionId: "not-a-conversation", message: text("hi") }, "other"), refused, "an unknown id reads the same");
  const began = await app.a2a.send({ message: text("hi") }, "other");
  assert.equal((await app.a2a.send({ sessionId: began.sessionId, message: text("more") }, "other")).sessionId, began.sessionId,
    "its own conversation carries on");
  const io = () => ({ input: new PassThrough(), output: new PassThrough(), log: () => {} });
  const acp = new AcpConnection(app.runtime, app.store, io());
  await acp.onRequest("initialize", { protocolVersion: 1 });
  const words = [{ type: "text", text: "park this" }];
  await assert.rejects(acp.onRequest("session/prompt", { sessionId: mine.sessionId, prompt: words }), refused);
  const opened = await acp.onRequest("session/new", { cwd: ".", mcpServers: [] });
  assert.equal((await acp.onRequest("session/prompt", { sessionId: opened.sessionId, prompt: words })).stopReason, "end_turn");
  const threads = new AppServerConnection(app.runtime, io(), "test");
  await threads.onRequest("initialize", {});
  await assert.rejects(threads.onRequest("turn/start", { threadId: mine.sessionId, input: [{ type: "text", text: "x" }] }), refused);
  assert.equal(app.store.runs(owner).filter((run) => run.sessionId === mine.sessionId).length, 1, "nothing ran in the owner's conversation");
});

test("4e. money a task started last month and still running has spent counts in this month's figure", async (t) => {
  const { app } = await fixture(t);
  const store = app.store;
  const running = store.createRun(app.runtime.owner, "make a long video");
  const lastMonth = new Date(Date.now() - 40 * 86_400_000).toISOString();
  store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(lastMonth, running.id);
  store.event(running.id, "spend.recorded", { dollars: 2.5, what: "a video", estimate: false });
  const month = store.usageStore().getMonthlyStats();
  assert.equal(month.stillBeingMade, 2.5);
  assert.equal(month.estimatedCost, 2.5);
});

test("4c. mail.save_attachment says it writes into the attachments folder, so a folder rule judges it", async () => {
  const { registerMailSearch } = await import("../dist/personal/mail-search.js");
  const { resourceOf, resourceMatches } = await import("../dist/policy-resources.js");
  const tools = {};
  registerMailSearch({ register: (tool) => { tools[tool.name] = tool; } }, { settings: () => ({ folder: "finance/mail" }) });
  const tool = tools["mail.save_attachment"];
  const target = tool.target?.({ uid: 1, index: 0 }) ?? "";
  assert.equal(target, "finance/mail");
  const resource = resourceOf(tool.name, tool.permission, target, { uid: 1, index: 0 });
  assert.equal(resourceMatches({ kind: "path", pattern: "finance" }, resource, "deny"), true, "never under finance holds");
});

test("4d. an older match-style rule reads the file path tidied, and inside the active project folder", async () => {
  const { PolicySchema, evaluatePolicy } = await import("../dist/policy.js");
  const { resourceOf } = await import("../dist/policy-resources.js");
  const policy = PolicySchema.parse({ preset: "custom", rules: [{ tool: "files.write", match: "finance/*", decision: "deny" }] });
  const judge = (target, inWorkspace) => {
    const resource = { ...resourceOf("files.write", "files.write", target, { path: target }), ...(inWorkspace ? { inWorkspace } : {}) };
    return evaluatePolicy(policy, { tool: "files.write", target, readOnly: false, resource }).decision;
  };
  assert.equal(judge("finance/q1.txt"), "deny");
  for (const sneaky of ["././finance/q1.txt", "finance\\q1.txt", "notes/../finance/q1.txt", "finance//q1.txt"])
    assert.equal(judge(sneaky), "deny", sneaky);
  assert.equal(judge("q1.txt", "finance/q1.txt"), "deny", "the file inside the active project folder");
  assert.notEqual(judge("notes/q1.txt"), "deny", "another folder is not covered");
});

test("4a. process.start is judged by command rules on the command it really runs, arguments included", async (t) => {
  const { app } = await fixture(t);
  const { PolicySchema, evaluatePolicy } = await import("../dist/policy.js");
  app.store.save("settings", app.runtime.owner, "background-processes", { programs: {
    dev: { path: "C:/Program Files/nodejs/npm.cmd", args: ["run", "dev"] },
    setup: { path: "/usr/bin/npm", args: ["install"] },
  } });
  const policy = PolicySchema.parse({ preset: "custom", rules: [
    { tool: "*", match: "*", decision: "deny", resource: { kind: "command", pattern: "npm install" } },
    { tool: "*", match: "*", decision: "deny", resource: { kind: "command", pattern: "npm run dev --host" } },
  ] });
  const judge = (args) => {
    const target = app.registry.targetOf("process.start", args, app.runtime.context({}));
    const resource = app.registry.resourceOf("process.start", target, args);
    return evaluatePolicy(policy, { tool: "process.start", target, readOnly: false, resource }).decision;
  };
  assert.equal(judge({ program: "setup", args: ["left-pad"] }), "deny", "whatever short name the owner gave npm install");
  assert.equal(judge({ program: "dev", args: ["--host", "0.0.0.0"] }), "deny", "the call's own arguments are read");
  assert.equal(judge({ program: "dev", args: ["--port", "3000"] }), "allow", "a listed program no rule is about still goes ahead");
  assert.equal(app.registry.targetOf("process.start", { program: "dev", args: [] }, app.runtime.context({})), "dev", "the card is unchanged");
});

test("10. the phone app works out the same check code the computer shows beside its request", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { keyCheck: serverCheck } = await import("../dist/devices/protocol.js");
  const { keyCheck: phoneCheck } = await import("../apps/mobile/web/rules.js");
  for (let i = 0; i < 5; i++) {
    const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.equal(await phoneCheck(globalThis.crypto, key), serverCheck(key));
  }
  const device = await readFile(new URL("../apps/mobile/web/phone-device.js", import.meta.url), "utf8");
  assert.match(device, /status\("device-status", await waitingWords\(\)\)/, "the waiting line is the one with the code");
  for (const native of ["../apps/mobile/ios/App/App/BranchPhonePlugin.swift",
    "../apps/mobile/android/app/src/main/java/com/keepoak/branchagent/BranchPhonePlugin.java"])
    assert.match(await readFile(new URL(native, import.meta.url), "utf8"), /deviceKey/, `${native} hands the page the public key`);
});

test("8. the achievements' names and sentences come in French when the window asks in French", async (t) => {
  const { app } = await fixture(t);
  const { delightRoute } = await import("../dist/delight.js");
  const { achievementCatalogue } = await import("../dist/achievements.js");
  const { inFrench } = await import("../dist/achievements-fr.js");
  await delightRoute(app, "POST", "/api/delight/settings", async () => ({ achievements: { on: true } }));
  const view = (language) => delightRoute(app, "GET", "/api/delight/achievements", async () => ({}), language);
  const byId = (list, id) => list.find((a) => a.id === id);
  const french = await view("fr"), english = await view(null);
  assert.deepEqual(byId(french.list, "tasks:1"), { ...byId(english.list, "tasks:1"), name: "Pousse", desc: "Terminer 1 tâche." });
  assert.equal(byId(english.list, "tasks:1").name, "Sprout", "without a language it stays English");
  assert.deepEqual(french.list.map((a) => [a.id, a.tier]), english.list.map((a) => [a.id, a.tier]), "the same ones, in the same order");
  // Every one of the 505 has French words; the few that read the same are the same in both languages.
  const same = achievementCatalogue().filter((a) => inFrench(a).desc === a.desc);
  assert.deepEqual(same, [], "every sentence is French");
  const pets = achievementCatalogue().filter((a) => a.metric.startsWith("noticed:pet:")).map((a) => inFrench(a).name);
  assert.ok(pets.includes("Rencontre avec la chouette") && pets.includes("Rencontre avec l'écureuil"), pets.join(", "));
  assert.equal(inFrench(achievementCatalogue().find((a) => a.id === "noticed:theme:dark:forest:1")).name, "Forêt au clair de lune");
});

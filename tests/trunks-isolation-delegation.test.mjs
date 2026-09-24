/**
 * FQ-routing.isolated-agents (NAS caa1843): one Trunk must never reach another Trunk's memory one
 * delegation away, nor another Trunk's kept file bytes through workspace.undo.
 *
 * A specialist runs with `agent` set to its own id, so every Trunk's hand-off to one specialist used to
 * share one `agent:<specialist>` memory scope: what Ada's researcher saved, Bo's researcher found. And
 * workspace.undo read the kept versions of a conversation without asking which scope kept them, so a
 * conversation the owner re-chose from Ada to Bo handed Bo the bytes Ada's own Trunk Chat had written.
 * Everything here goes through real Trunk turns (`trunks.say`, a started conversation), a scripted model
 * and the real tools, never a helper the fix adds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";

const secret = "SECRETXYZZY4417";

/** The owner makes a specialist, evaluated and promoted, as tests/orchestration.test.mjs does. */
async function specialist(app, name, permissions) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", {
    name, instructions: `You are the ${name}.`, permissions,
    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
  }, context);
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

const lastEvent = (app) => Number(app.store.sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id);
/** Every result (or error) of one tool since event `after`, oldest first, as text. */
function outcomesSince(app, after, name) {
  return app.store.sqlite.prepare("SELECT kind, data FROM events WHERE id > ? AND kind IN ('tool.completed','tool.failed') ORDER BY id")
    .all(after).map((row) => JSON.parse(row.data)).filter((data) => data.name === name)
    .map((data) => JSON.stringify(data.result ?? data.error ?? null));
}
/** Waits for background specialists: until no task is still running. */
async function settled(app) {
  for (let tries = 0; tries < 200; tries++) {
    if (!app.store.sqlite.prepare("SELECT 1 FROM tasks WHERE status IN ('running','queued') LIMIT 1").get()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("a task never finished");
}

/**
 * A Trunk's turn "<how>: <brief>" sends the brief to the researcher by that route; the researcher saves
 * "remember …" and searches "recall …", then says what the tool gave back.
 */
function rules(ids) {
  const route = {
    handoff: (brief) => call("delegate.handoff", { specialist: ids.researcher, brief }),
    parallel: (brief) => call("delegate.parallel", { tasks: [{ specialist: ids.researcher, prompt: brief }] }),
    delegate: (brief) => call("specialists.delegate", { id: ids.researcher, prompt: brief }),
    background: (brief) => call("specialists.delegate", { id: ids.researcher, prompt: brief, background: true }),
    onward: (brief) => call("delegate.handoff", { specialist: ids.writer, brief }),
  };
  return [({ system, last }) => {
    if (!/You are the (researcher|writer)/.test(system)) return null;
    if (last?.role === "tool") return `Found: ${last.content}`;
    const text = String(last?.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "the researcher" });
    if (text.startsWith("recall ")) return call("memory.search", { query: text.slice("recall ".length) });
    if (text.startsWith("share ")) return call("memory.put", { text: text.slice("share ".length), source: "the researcher", scope: "shared" });
    if (text.startsWith("onward: ")) return route.onward(text.slice("onward: ".length));
    return null;
  }, ({ last }) => {
    if (last?.role === "tool") return "Done.";
    const text = String(last?.content ?? ""), at = text.indexOf(": ");
    return at > 0 ? route[text.slice(0, at)]?.(text.slice(at + 2)) ?? null : null;
  }];
}

async function twoTrunks(t, extra = {}) {
  const ids = {};
  const { app } = await fixture(t, rules(ids));
  on(app);
  ids.researcher = await specialist(app, "researcher", ["memory.read", "memory.write", "specialists.use"]);
  ids.writer = await specialist(app, "writer", ["memory.read"]);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo])
    app.trunks.edit(trunk.id, { permissions: ["specialists.use", "memory.read", "memory.write"], ...extra });
  await app.trunks.introduced();
  const say = async (trunk, text) => { await app.trunks.say(trunk.id, text); await settled(app); };
  return { app, ids, ada, bo, say };
}

for (const how of ["handoff", "parallel", "delegate", "background"]) {
  test(`a specialist a Trunk works through (${how}) keeps that Trunk's facts from every other Trunk`, async (t) => {
    const { app, ada, bo, say } = await twoTrunks(t);
    await say(ada, `${how}: remember Launch code ${secret}`);
    let after = lastEvent(app);
    await say(bo, `${how}: recall launch code`);
    const bos = outcomesSince(app, after, "memory.search");
    assert.equal(bos.length, 1, "Bo's researcher searched");
    assert.doesNotMatch(bos[0], new RegExp(secret), "Bo's researcher never finds what Ada's saved");
    assert.equal(bos[0], "[]", "an empty answer, not an error");
    after = lastEvent(app);
    await say(ada, `${how}: recall launch code`);
    const adas = outcomesSince(app, after, "memory.search");
    assert.equal(adas.length, 1, "Ada's researcher searched");
    assert.match(adas[0], new RegExp(secret), "Ada's researcher still finds its own fact");
  });
}

test("the owner's own specialist keeps the memory it always had, apart from every Trunk's", async (t) => {
  const { app, ids, ada, say } = await twoTrunks(t);
  const ownerSays = async (text) => {
    const parent = await app.runtime.run({ prompt: "owner" });
    await app.registry.execute("delegate.handoff", { specialist: ids.researcher, brief: text }, app.runtime.context({ runId: parent.id }));
  };
  await ownerSays(`remember Owner code ${secret}`);
  const saved = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes(secret));
  assert.equal(saved.data.scope, `agent:${ids.researcher}`, "the key the owner's specialist always used");
  let after = lastEvent(app);
  await say(ada, "handoff: recall owner code");
  assert.doesNotMatch(outcomesSince(app, after, "memory.search")[0], new RegExp(secret), "Ada's researcher is not the owner's");
  after = lastEvent(app);
  await ownerSays("recall owner code");
  assert.match(outcomesSince(app, after, "memory.search")[0], new RegExp(secret), "the owner's specialist finds its own fact");
});

test("a Trunk that keeps to itself keeps its specialists from the owner's shared facts too", async (t) => {
  const { app, ada, say } = await twoTrunks(t, { sharedFacts: false });
  await app.registry.execute("memory.put", { text: `Shared code ${secret}`, source: "the owner", scope: "shared" }, app.runtime.context());
  const after = lastEvent(app);
  await say(ada, "handoff: recall shared code");
  const [found] = outcomesSince(app, after, "memory.search");
  assert.doesNotMatch(found, new RegExp(secret));
  assert.equal(found, "[]", "an empty answer, not an error");
});

test("under a Trunk a specialist is still itself by name: the owner's hand-on rules for it still hold", async (t) => {
  const { app, ids, ada, say } = await twoTrunks(t);
  app.runtime.handoffs.save(ids.researcher, [ids.researcher]); // the researcher may hand work only to itself
  const after = lastEvent(app);
  await say(ada, "handoff: onward: write it up");
  const refused = outcomesSince(app, after, "delegate.handoff");
  assert.ok(refused.some((text) => /only set up to hand work on to/.test(text)), refused.join("\n"));
});

test("workspace.undo in a conversation the owner re-chose never hands one Trunk another Trunk's kept bytes", async (t) => {
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write private") return call("files.write", { path: "plan.md", content: `Ada private plan ${secret}` });
    if (text === "write public") return call("files.write", { path: "plan.md", content: "Ada public plan" });
    if (text === "preview undo") return call("workspace.undo", { preview: true });
    if (text === "undo") return call("workspace.undo", {});
    if (text === "read plan") return call("files.read", { path: "plan.md" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();
  await app.trunks.say(ada.id, "write private"); // in Ada's own Trunk Chat, which Bo never joins
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "write public", sessionId });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  let after = lastEvent(app);
  await app.runtime.run({ prompt: "preview undo", sessionId });
  const [preview] = outcomesSince(app, after, "workspace.undo");
  assert.doesNotMatch(preview, new RegExp(secret), "Bo's preview shows none of Ada's bytes");
  assert.match(preview, /"change":null/, "nothing of Bo's own to undo here");
  after = lastEvent(app);
  await app.runtime.run({ prompt: "undo", sessionId });
  await app.runtime.run({ prompt: "read plan", sessionId });
  const [undone] = outcomesSince(app, after, "workspace.undo");
  assert.doesNotMatch(undone, new RegExp(secret), "nor does the undo itself");
  assert.match(undone, /nothing to undo/);
  assert.doesNotMatch(outcomesSince(app, after, "files.read").join(""), new RegExp(secret), "nothing of Ada's was written into Bo's folder");
});

test("workspace.redo in a conversation the owner re-chose never hands one Trunk another Trunk's kept bytes", async (t) => {
  const later = "SECRETLATER5521";
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write first") return call("files.write", { path: "plan.md", content: "Ada first plan" });
    if (text === "write later") return call("files.write", { path: "plan.md", content: `Ada later plan ${later}` });
    if (text === "undo") return call("workspace.undo", {});
    if (text === "preview redo") return call("workspace.redo", { preview: true });
    if (text === "redo") return call("workspace.redo", {});
    if (text === "read plan") return call("files.read", { path: "plan.md" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  for (const prompt of ["write first", "write later", "undo"]) await app.runtime.run({ prompt, sessionId });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  const after = lastEvent(app);
  for (const prompt of ["preview redo", "redo", "read plan"]) await app.runtime.run({ prompt, sessionId });
  const [preview, redo] = outcomesSince(app, after, "workspace.redo");
  for (const text of [preview, redo]) assert.doesNotMatch(text, new RegExp(later), "Bo's redo shows none of Ada's bytes");
  assert.match(preview, /"change":null/, "Ada's undo is not Bo's to redo");
  assert.match(redo, /nothing to put back/);
  assert.doesNotMatch(outcomesSince(app, after, "files.read").join(""), new RegExp(later), "nothing of Ada's was written into Bo's folder");
});

test("a Trunk's specialist asked to save a shared fact keeps it to that Trunk, as the Trunk itself does", async (t) => {
  const { app, ada, bo, say } = await twoTrunks(t);
  const after = lastEvent(app);
  await say(ada, `handoff: share Launch code ${secret}`);
  const saved = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes(secret));
  assert.ok(saved, outcomesSince(app, after, "memory.put").join("\n"));
  assert.notEqual(saved.data.scope, "shared", "never shared");
  assert.match(saved.data.scope, new RegExp(`^agent:trunk:${ada.id}:`), "Ada's researcher's own");
  const before = lastEvent(app);
  await say(bo, "handoff: recall launch code");
  assert.equal(outcomesSince(app, before, "memory.search")[0], "[]");
});

for (const [who, first] of [["another Trunk's", "Ada"], ["the owner's", "owner"]])
  test(`a conversation the owner re-chose never shows the next Trunk ${who} remembered facts`, async (t) => {
    const secretSnap = "SECRETSNAP8812";
    const { app, provider } = await fixture(t, [({ last }) => (last?.role === "user" && last.content === "remember"
      ? call("memory.put", { text: `Snap code ${secretSnap}`, source: "Ada" }) : null),
    ({ last }) => (last?.role === "tool" ? "Done." : null)]);
    on(app);
    const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
    for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write"] });
    await app.trunks.introduced();
    let sessionId, next;
    if (first === "Ada") {
      await app.trunks.say(ada.id, "remember"); // saved in Ada's own Trunk Chat
      ({ sessionId } = app.trunks.startConversation({ trunkId: ada.id }));
      next = bo;
    } else {
      await app.registry.execute("memory.put", { text: `Snap code ${secretSnap}`, source: "the owner" }, app.runtime.context());
      sessionId = (await app.runtime.run({ prompt: "hello" })).sessionId; // the owner's own conversation
      next = ada;
    }
    await app.runtime.run({ prompt: "hello", sessionId });
    assert.match(JSON.stringify(provider.requests.at(-1).messages), new RegExp(secretSnap), "the first speaker is shown its own fact");
    app.trunks.conversations.choose(sessionId, { trunkId: next.id });
    await app.runtime.run({ prompt: "hello again", sessionId });
    assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).messages), new RegExp(secretSnap), `${next.name} is not shown it`);
  });

test("the reviewer of a Trunk's answer sees only what that Trunk remembers, and hands back nothing else", async (t) => {
  const { saveOrchestrationSettings } = await import("../dist/orchestration.js");
  const seen = [];
  const { app, provider } = await fixture(t, [({ system, last }) => {
    if (!/You review a finished answer/.test(system)) return null;
    seen.push(String(last?.content ?? ""));
    // A reviewer that quotes what it was shown, so anything it saw would reach the Trunk's own model too.
    return seen.length === 1 ? JSON.stringify({ verdict: "revise", fixes: [`mention: ${seen[0].replace(/\s+/g, " ").slice(0, 1500)}`] })
      : JSON.stringify({ verdict: "accept", fixes: [] });
  }, ({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  await app.trunks.say(bo.id, "remember zebra Bo BOSECRET7714");
  await app.trunks.say(ada.id, "remember zebra Ada ADAOWN5150");
  saveOrchestrationSettings(app.store, app.runtime.owner, { verify: true });
  seen.length = 0;
  const before = provider.requests.length;
  // A new conversation with Ada, so her snapshot is taken now that the facts exist.
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "how is the zebra", sessionId });
  assert.ok(seen.length >= 1, "the reviewer looked at Ada's answer");
  assert.doesNotMatch(seen[0], /OWNERPRIV3391|BOSECRET7714/, "the reviewer is shown only Ada's memory");
  assert.match(seen[0], /ADAOWN5150/, "including Ada's own fact");
  const handed = provider.requests.slice(before).filter((request) => !/You review a finished answer/.test(request.messages.map((m) => m.content).join("\n")));
  assert.doesNotMatch(JSON.stringify(handed.map((request) => request.messages)), /OWNERPRIV3391|BOSECRET7714/, "nor does Ada's own model get it back");
});

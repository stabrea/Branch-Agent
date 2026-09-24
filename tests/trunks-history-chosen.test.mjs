/**
 * Q133 (Mac mini b8516c0): a conversation the owner chooses who answers in is a Trunk's to look back on only
 * while that Trunk is the one chosen. Before this, one answer there left a Trunk reading everything said in it
 * for good: what the owner said after taking it back, and what another Trunk said after it was handed over.
 * Real Trunk turns, a scripted model and the real history tools throughout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

const lastRun = (app, sessionId) => app.store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId).id;
function outcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return JSON.stringify(done.data.result);
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  return failed ? `REFUSED ${failed.data.error}` : "NEVER RAN";
}

async function setup(t) {
  const asked = {};
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "").trim();
    if (text.startsWith("search ")) return call("history.search", { query: text.slice(7) });
    if (text === "read it") return call("history.read", asked.read);
    if (text === "tree it") return call("sessions.tree", { sessionId: asked.tree });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["history.read"] });
  await app.trunks.introduced();
  /** A tool call in a Trunk's own chat; what it gave back. */
  const use = async (trunk, text, name) => {
    await app.trunks.say(trunk.id, text);
    return outcome(app, lastRun(app, app.trunks.records.find(trunk.id).chatSessionId), name); // its chat now, after a retire too
  };
  const said = (sessionId, text) => app.store.sqlite.prepare(
    "SELECT source_id FROM messages WHERE session_id=? AND json_extract(body,'$.content') LIKE ? ORDER BY id DESC LIMIT 1").get(sessionId, `%${text}%`)?.source_id;
  return { app, ada, bo, use, asked, said };
}

test("Q133: a Trunk the owner takes a conversation back from reads nothing said there afterwards", async (t) => {
  const { app, ada, use, asked, said } = await setup(t);
  const first = await app.runtime.run({ prompt: "OWNERBEFORE9901 quillmoor, the owner's own", onTextDelta: () => undefined });
  const sessionId = app.store.run(first.id).sessionId;
  app.trunks.conversations.choose(sessionId, { trunkId: ada.id });
  await app.runtime.run({ prompt: "Ada, quillmoor question", sessionId, onTextDelta: () => undefined });
  // While Ada is the one answering there, the conversation is hers to look back on (the control).
  assert.match(await use(ada, "search quillmoor", "history.search"), new RegExp(sessionId), "Ada reads it while she answers there");
  asked.tree = sessionId;
  assert.doesNotMatch(await use(ada, "tree it", "sessions.tree"), /REFUSED/, "and sees its shape");
  app.trunks.conversations.choose(sessionId, { trunkId: null }); // the owner takes it back
  await app.runtime.run({ prompt: "OWNERAFTER9903 quillmoor secret, after Ada left", sessionId, onTextDelta: () => undefined });
  assert.doesNotMatch(await use(ada, "search OWNERAFTER9903", "history.search"), /OWNERAFTER9903/, "by search");
  asked.read = { sessionId, messageId: said(sessionId, "OWNERAFTER9903") };
  assert.match(await use(ada, "read it", "history.read"), /REFUSED .*not found/, "nor by its id");
  assert.match(await use(ada, "tree it", "sessions.tree"), /REFUSED .*not found/, "nor its shape (every canAccessSession check)");
  // The owner's own look back still finds it.
  const owners = await app.registry.execute("history.search", { query: "OWNERAFTER9903" }, app.runtime.context());
  assert.equal(owners.results.some((row) => row.sessionId === sessionId), true);
  // Handed back to Ada, it is hers to read again, all of it: her turns there carry the whole conversation anyway.
  app.trunks.conversations.choose(sessionId, { trunkId: ada.id });
  assert.match(await use(ada, "search OWNERAFTER9903", "history.search"), /OWNERAFTER9903/);
});

test("Q133: a conversation handed from Ada to Bo is Bo's to read, and no longer Ada's", async (t) => {
  const { app, ada, bo, use } = await setup(t);
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "ADAPART7711 marrowfen for Ada", sessionId, onTextDelta: () => undefined });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  await app.runtime.run({ prompt: "BOPART7712 marrowfen for Bo now", sessionId, onTextDelta: () => undefined });
  assert.doesNotMatch(await use(ada, "search BOPART7712", "history.search"), /BOPART7712/, "Ada no longer reads it");
  assert.match(await use(bo, "search marrowfen", "history.search"), /BOPART7712/, "Bo, who answers there now, does");
});

test("Q133: a Trunk's own earlier chat stays its own to look back on", async (t) => {
  const { app, ada, bo, use } = await setup(t);
  await app.trunks.say(ada.id, "ADACHAT7721 fenwick is on my list");
  app.trunks.retireChat(ada.id); // she carries on in a fresh chat; the earlier one is still hers (a search skips the one it is in)
  assert.match(await use(ada, "search fenwick", "history.search"), /ADACHAT7721/);
  assert.doesNotMatch(await use(bo, "search fenwick", "history.search"), /ADACHAT7721/);
});

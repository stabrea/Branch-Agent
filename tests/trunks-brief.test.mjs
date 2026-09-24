/**
 * Q134 (NAS 4d24972, Legion 22b5c71): the morning brief gathers the owner's own schedules, failing tasks,
 * documents, watches and "remind" memories, and is sent to the owner's chat. A Trunk (in its own turn, or in
 * work it set going) and a delegated specialist are refused every brief tool, as the to-do list refuses them.
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

test("Q134: a Trunk is refused the owner's morning brief: to read it, to send it, to hear it and to change it", async (t) => {
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const match = /^tool (\S+) (.*)$/s.exec(String(last.content ?? ""));
    return match ? call(match[1], JSON.parse(match[2])) : null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["brief.read", "brief.manage", "channels.send", "personal.read"] });
  await app.trunks.introduced();
  await app.personal.setMode("spoken-brief", { mode: "on" }); // so the spoken brief's two tools exist
  const owner = app.runtime.context();
  await app.registry.execute("schedules.create", { prompt: "OWNERSCHED8801 call the bank", kind: "task",
    dueAt: new Date(Date.now() + 3600000).toISOString() }, owner);
  await app.registry.execute("memory.put", { text: "remind me OWNERREMIND8802 about the lease", source: "the owner" }, owner);
  // The control: the owner's own brief holds both.
  const own = await app.registry.execute("brief.preview", {}, owner);
  assert.match(own.markdown, /OWNERSCHED8801/);
  assert.match(own.markdown, /OWNERREMIND8802/);
  const use = async (name, args) => {
    await app.trunks.say(ada.id, `tool ${name} ${JSON.stringify(args)}`);
    return outcome(app, lastRun(app, ada.chatSessionId), name);
  };
  const briefs = () => app.store.runs(app.runtime.owner).filter((run) => run.prompt === "Morning brief").length;
  const before = { settings: JSON.stringify(app.brief.settings(app.runtime.owner)), sent: briefs() };
  for (const [name, args] of [["brief.preview", {}], ["brief.send", {}], ["brief.configure", { enabled: true, dailyAt: "05:00" }],
    // Every other tool that carries the brief: sent to a chat, or read aloud (and sent) with the owner's day.
    ["channels.digest", { channel: "telegram", chatId: "1" }], ["brief.spoken", {}], ["brief.send_voice", {}]]) {
    const answer = await use(name, args);
    assert.match(answer, /REFUSED .*morning brief is the owner's/, `${name} is refused to Ada`);
    assert.doesNotMatch(answer, /OWNERSCHED8801|OWNERREMIND8802/);
  }
  assert.equal(JSON.stringify(app.brief.settings(app.runtime.owner)), before.settings, "the owner's brief settings are unchanged");
  assert.equal(briefs(), before.sent, "no brief was sent");
  // A specialist the owner's task delegates to (`agent` set, no Trunk) is refused as well (NAS fa889df).
  await assert.rejects(app.registry.execute("brief.preview", {}, { ...app.runtime.context(), agent: "researcher" }),
    /morning brief is the owner's/);
  // Work Ada set going without a turn of its own (a workflow's tool step) is hers too.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  await assert.rejects(withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.registry.execute("brief.preview", {}, app.runtime.context())), /morning brief is the owner's/);
});

/**
 * Q48 and Q49: every change the settings kit makes is written down as a structured record (which
 * setting, before, after, who, which way, when); an undo puts back exactly the recorded before-values
 * through the same pins and rules, or refuses as a whole; and "why is this on?" answers from those
 * records only. Everything runs on its own data folder; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { settingsKitApi, SettingsKitError } from "../dist/settings-kit/api.js";
import { settingsHistory } from "../dist/settings-kit/history.js";
import { exportSettings } from "../dist/settings-kit/transfer.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { startServer } from "../dist/server.js";
import { choosePreset } from "../dist/terminal-commands.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-history-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const deps = { store: app.store, owner, workspace: join(root, "workspace"), appVersion: "test" };
  const ask = (method, path, body) => settingsKitApi(deps, method, path, async () => body);
  const values = async () => Object.fromEntries((await ask("GET", "/api/settings-kit")).settings
    .flatMap((spec) => spec.fields.map((field) => [`${spec.key}.${field.field}`, field.value])));
  /** Applies a preset, every change ticked, and returns the result. */
  const preset = async (name) => {
    const plan = { source: "preset", preset: name };
    const { changes } = await ask("POST", "/api/settings-kit/preview", plan);
    return ask("POST", "/api/settings-kit/apply", { plan, accept: changes.map((change) => change.id), confirmLoosening: true });
  };
  const refused = (status, pattern) => (error) => error instanceof SettingsKitError && error.status === status && pattern.test(error.message);
  return { root, app, owner, ask, values, preset, refused };
}

test("a preset's many changes are recorded, and undo puts back exactly the before-values", async (t) => {
  const { app, owner, ask, values, preset, refused } = await fixture(t);
  const before = await values();
  const done = await preset("private");
  assert.ok(done.applied.length > 2, `the preset changed only ${done.applied.length} settings`);
  const [record] = (await ask("GET", "/api/settings-kit/history")).records;
  assert.equal(record.id, done.record);
  assert.equal(record.writer, "owner-in-window");
  assert.equal(record.source, "preset");
  assert.equal(record.detail, "Private and local");
  assert.ok(!Number.isNaN(Date.parse(record.at)));
  assert.deepEqual(record.changes.map((entry) => entry.setting).sort(), done.applied.map((change) => change.id).sort());
  for (const entry of record.changes) assert.equal(entry.before, before[entry.setting], `${entry.setting} before`);
  const after = await values();
  for (const entry of record.changes) assert.equal(entry.after, after[entry.setting], `${entry.setting} after`);

  const undone = await ask("POST", "/api/settings-kit/undo", { record: record.id, confirmLoosening: true });
  assert.equal(undone.applied.length, record.changes.length);
  assert.deepEqual(await values(), before, "every setting is back exactly as it was");
  const records = settingsHistory(app.store, owner);
  const undoRecord = records.at(-1);
  assert.equal(undoRecord.source, "undo");
  assert.equal(undoRecord.undoes, record.id);
  assert.equal(records.find((entry) => entry.id === record.id).undoneBy, undoRecord.id);
  assert.ok(app.store.audit.list(owner, { limit: 5 }).some((entry) => /undo of a change/.test(entry.subject)), "the undo is audited like any change");
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: record.id, confirmLoosening: true }), refused(409, /already undone/));
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: "nope", confirmLoosening: true }), refused(404, /no such change/));
});

test("an undo that would make Branch less careful is refused without the separate yes, and writes nothing", async (t) => {
  const { ask, values, preset, refused } = await fixture(t);
  const done = await preset("private");
  const changed = await values();
  // The private preset turns things off; turning them back on is the less careful direction.
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: false }), refused(409, /less careful/));
  assert.deepEqual(await values(), changed, "a refused undo changed something");
});

test("an undo is refused as a whole while one of its settings is pinned, or changed again since", async (t) => {
  const { ask, values, preset, refused } = await fixture(t);
  const done = await preset("private");
  const changed = await values();
  const [first] = done.applied;
  await ask("POST", "/api/settings-kit/pins", { key: first.key, field: first.field, pinned: true });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: true }), refused(409, /pinned/));
  assert.deepEqual(await values(), changed, "a refused undo put back the settings that were not pinned");
  await ask("POST", "/api/settings-kit/pins", { key: first.key, field: first.field, pinned: false });

  // One of its settings moved again by one switch: the record no longer describes what is there.
  await ask("POST", "/api/settings-kit/apply", { plan: { source: "set", key: first.key, field: first.field, value: first.from },
    accept: [first.id], confirmLoosening: true });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: done.record, confirmLoosening: true }),
    refused(409, new RegExp(`${first.id.replace(/[.]/g, "\\.")} was changed again later`)));
});

test("why is this on: a default, a talked change, an import, and a change nothing recorded", async (t) => {
  const { app, owner, ask } = await fixture(t);
  const why = (setting) => ask("GET", `/api/settings-kit/why/${setting}`);

  const untouched = await why("fly-core.mode");
  assert.equal(untouched.kind, "starting-value");
  assert.equal(untouched.record, null);
  assert.match(untouched.words, /how it starts\. No change to it was recorded/);

  const run = app.store.createRun(owner, "turn on the learning core");
  app.store.event(run.id, "run.started", { source: "owner" });
  const context = app.runtime.context({ runId: run.id, source: "owner" });
  await app.registry.execute("settings.change", { changes: [{ setting: "fly-core.mode", value: "on" }] }, context);
  const talked = await why("fly-core.mode");
  assert.equal(talked.kind, "recorded");
  assert.equal(talked.value, "on");
  assert.equal(talked.record.writer, "conversation");
  assert.equal(talked.record.source, "talk");
  assert.equal(talked.record.runId, run.id);
  assert.equal(talked.record.sessionId, run.sessionId);
  assert.deepEqual([talked.record.before, talked.record.after], ["off", "on"]);
  assert.match(talked.words, /a conversation/);

  const file = exportSettings(app.store, owner, "test");
  file.settings.voice.autoReadAloud = !file.settings.voice.autoReadAloud;
  const plan = { source: "import", file: JSON.stringify(file) };
  const { changes } = await ask("POST", "/api/settings-kit/preview", plan);
  assert.deepEqual(changes.map((change) => change.id), ["voice.autoReadAloud"]);
  await ask("POST", "/api/settings-kit/apply", { plan, accept: ["voice.autoReadAloud"], confirmLoosening: false });
  const imported = await why("voice.autoReadAloud");
  assert.equal(imported.kind, "recorded");
  assert.equal(imported.record.source, "import");
  assert.equal(imported.record.writer, "owner-in-window");
  assert.match(imported.words, /a settings file you brought in/);

  // The voice card saves around the kit and keeps no record: the answer says so rather than
  // naming the import as the one who set it.
  saveVoiceSettings(app.store, owner, { autoReadAloud: !imported.value });
  const since = await why("voice.autoReadAloud");
  assert.equal(since.kind, "changed-since");
  assert.match(since.words, /changed again since by something that keeps no record/);

  await assert.rejects(() => why("not-a-setting.mode"), (error) => error instanceof SettingsKitError && error.status === 404);
});

test("a setting changed only by something that keeps no record says nothing was recorded", async (t) => {
  const { app, owner, ask } = await fixture(t);
  const { value } = await ask("GET", "/api/settings-kit/why/voice.autoReadAloud");
  saveVoiceSettings(app.store, owner, { autoReadAloud: !value });
  const answer = await ask("GET", "/api/settings-kit/why/voice.autoReadAloud");
  assert.equal(answer.kind, "not-recorded");
  assert.equal(answer.record, null);
  assert.match(answer.words, /Nothing was recorded about who or what set it/);
});

test("undoing a change is refused when a later recorded change touched the same setting, even back to the same value", async (t) => {
  const { ask, values, refused } = await fixture(t);
  const flip = async (value) => (await ask("POST", "/api/settings-kit/apply", {
    plan: { source: "set", key: "fly-core", field: "mode", value }, accept: ["fly-core.mode"], confirmLoosening: true })).record;
  const r1 = await flip("on"), r2 = await flip("off"), r3 = await flip("on");
  // The value is what r1 made it, but only because r3 made it so: undoing r1 would silently undo r3.
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: r1, confirmLoosening: true }),
    refused(409, /fly-core[.]mode was changed again later .*Undo the later change first/));
  assert.equal((await values())["fly-core.mode"], "on", "a refused undo changed something");
  // Newest first still works, one step at a time, because each undone change cancels with its undo.
  for (const id of [r3, r2, r1]) await ask("POST", "/api/settings-kit/undo", { record: id, confirmLoosening: true });
  assert.equal((await values())["fly-core.mode"], "off");
});

test("undoing a change to a setting Branch no longer has says so, not that it changed again", async (t) => {
  const { app, owner, ask, refused } = await fixture(t);
  app.store.save("settings", owner, "settings-history", { records: [{ id: "old-one", at: new Date().toISOString(),
    writer: "owner-in-window", source: "switch", detail: "gone-setting.mode", changes: [{ setting: "gone-setting.mode", before: "off", after: "on" }] }] });
  await assert.rejects(() => ask("POST", "/api/settings-kit/undo", { record: "old-one", confirmLoosening: true }),
    refused(409, /gone-setting[.]mode is no longer a setting Branch has/));
});

test("the cards that save around the kit, and /preset, are recorded, so why names the right source", async (t) => {
  const { root, app, ask } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } });
    assert.equal(answer.status, 200, `${path}: ${await answer.clone().text()}`);
  };
  const why = (setting) => ask("GET", `/api/settings-kit/why/${setting}`);
  const byCard = async (setting, detail) => {
    const answer = await why(setting);
    assert.equal(answer.kind, "recorded", `${setting}: ${answer.words}`);
    assert.equal(answer.record.writer, "owner-in-window", setting);
    assert.equal(answer.record.source, "card", setting);
    assert.equal(answer.record.detail, detail, setting);
    assert.match(answer.words, /its own card in Settings/);
  };
  await post("/api/policy", { preset: "read-only" });
  await byCard("policy.preset", "policy");
  await post("/api/voice/wake", { mode: "on" });
  await byCard("wake-word.mode", "wake-word");
  const { value: aloud } = await why("voice.autoReadAloud");
  await post("/api/voice/settings", { autoReadAloud: !aloud });
  await byCard("voice.autoReadAloud", "voice");
  await post("/api/os-sandbox", { mode: "on", network: "limited", keySites: {}, unreadable: [] });
  await byCard("os-sandbox.network", "os-sandbox");
  await post("/api/retention", { enabled: true, keepDays: 30, megabytes: 1, exportBeforeDeleting: true });
  await byCard("retention.keepDays", "retention");

  choosePreset(app.runtime, "workspace");
  const typed = await why("policy.preset");
  assert.equal(typed.kind, "recorded");
  assert.equal(typed.value, "workspace");
  assert.equal(typed.record.writer, "owner-by-command");
  assert.equal(typed.record.source, "command");
  assert.equal(typed.record.detail, "/preset workspace");
  assert.deepEqual([typed.record.before, typed.record.after], ["read-only", "workspace"]);
  // A recorded card change is an ordinary change: it can be undone like any other.
  await ask("POST", "/api/settings-kit/undo", { record: typed.record.id, confirmLoosening: true });
  assert.equal((await why("policy.preset")).value, "read-only");
});

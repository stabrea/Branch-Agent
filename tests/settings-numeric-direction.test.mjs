import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { acceptValue, applyWithPins, changesFor, loosens } from "../dist/settings-kit/changes.js";
import { settingsCatalogue, specFor } from "../dist/settings-kit/catalogue.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { presets } from "../dist/settings-kit/presets.js";
import { discardTemp } from "./temp-dir.mjs";

const numeric = [
  ["wake-word", "sureness", 80, 50, true, "guard"],
  ["live-dictation", "silenceSeconds", 4, 30, true, "reach"],
  ["retention", "keepDays", 0, 3650, false, "plain"],
  ["comfort-mcp", "startupTimeoutSeconds", 10, 300, false, "plain"],
];

for (const [key, name, from, to, expected, direction] of numeric) {
  test(`${key}.${name}: numeric direction, inverse and equality agree with the catalogue`, () => {
    const spec = specFor(key), field = spec.fields.find((entry) => entry.field === name);
    assert.equal(field.guard, direction);
    assert.equal(loosens(field, from, to, spec), expected);
    assert.equal(loosens(field, to, from, spec), false);
    assert.equal(loosens(field, from, from, spec), false);
    for (const invalid of [NaN, Infinity, "50", field.kind.min - 1, field.kind.max + 1, from + 0.5])
      assert.equal(acceptValue(field, invalid), undefined, `${key}: invalid number accepted`);
  });
}

test("every numeric setting is classified, while nonnumeric directions stay intact", () => {
  const ids = settingsCatalogue.flatMap((spec) => spec.fields
    .filter((field) => field.kind.type === "number").map((field) => `${spec.key}.${field.field}`));
  assert.deepEqual(ids.sort(), numeric.map(([key, field]) => `${key}.${field}`).sort());
  const check = (key, name, from, to, expected) => {
    const spec = specFor(key), field = spec.fields.find((entry) => entry.field === name);
    assert.equal(loosens(field, from, to, spec), expected);
  };
  check("wake-word", "mode", "off", "on", true);
  check("loop_guard", "mode", "on", "off", true);
  check("chat-permissions", "extras", false, true, true);
  check("policy", "preset", "ask-before-changes", "off", true);
  const field = specFor("retention").fields.find((entry) => entry.field === "keepDays");
  assert.equal(loosens(field, 1, 2, { key: "permission-limits" }), true, "unknown safety-shaped plain fields still fail closed");
});

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-numeric-settings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const context = app.runtime.context({ source: "owner" });
  const deps = { store: app.store, owner, workspace: app.runtime.workspace, appVersion: "test" };
  const api = (route, body) => settingsKitApi(deps, "POST", `/api/settings-kit/${route}`, async () => body);
  const tool = (name, args) => app.registry.execute(name, args, context);
  const value = async (id) => (await tool("settings.list", { search: id })).shown[0].value;
  return { app, owner, api, tool, value };
}

test("numeric loosening cannot use settings.change, while tightening can", async (t) => {
  const { tool, value } = await fixture(t);
  for (const [key, field, from, to] of numeric.slice(0, 2)) {
    const id = `${key}.${field}`, args = { changes: [{ setting: id, value: to }] };
    const row = (await tool("settings.list", { search: id })).shown[0];
    assert.match(row.lessCareful, key === "wake-word" ? /turning it down/ : /turning it up/);
    await assert.rejects(tool("settings.change", args), /less careful.*settings\.loosen/s);
    assert.equal(await value(id), from, "refused tool changed nothing");
    assert.equal((await tool("settings.loosen", args)).changed.length, 1);
    assert.equal(await value(id), to);
    const tighter = { changes: [{ setting: id, value: from }] };
    await assert.rejects(tool("settings.loosen", tighter), /None of these makes Branch less careful/);
    assert.equal((await tool("settings.change", tighter)).changed.length, 1);
    assert.equal(await value(id), from);
    assert.deepEqual((await tool("settings.change", tighter)).changed, [], "same value is a no-op");
  }
});

const settingsFile = (settings) => JSON.stringify({ format: "branch-settings", version: 1,
  appVersion: "test", exportedAt: "2026-09-23T00:00:00.000Z", settings });

for (const source of ["set", "import", "reset"]) {
  test(`${source}: numeric preview requires separate confirmation and leaves refused values unchanged`, async (t) => {
    const { app, owner, api, value } = await fixture(t);
    for (const [key, field, initial, loose] of numeric.slice(0, 2)) {
      const id = `${key}.${field}`;
      const from = source === "reset" ? (key === "wake-word" ? 99 : 1) : initial;
      const to = source === "reset" ? initial : loose;
      app.store.save("settings", owner, key, { [field]: from });
      const plan = source === "reset" ? { source, key } : source === "set" ? { source, key, field, value: to }
        : { source, file: settingsFile({ [key]: { [field]: to } }) };
      const preview = await api("preview", plan);
      assert.deepEqual(preview.changes.map((change) => [change.id, change.from, change.to, change.loosens]), [[id, from, to, true]]);
      const choice = { plan, accept: [id], confirmLoosening: false };
      await assert.rejects(api("apply", choice), /less careful/);
      assert.equal(await value(id), from);
      assert.equal((await api("apply", { ...choice, confirmLoosening: true })).applied.length, 1);
      assert.equal(await value(id), to);
    }
  });
}

test("numeric pins survive tools and file/reset proposals even with loosening confirmed", async (t) => {
  const { app, owner, api, tool, value } = await fixture(t);
  app.store.save("settings", owner, "wake-word", { sureness: 99 });
  await api("pins", { key: "wake-word", field: "sureness", pinned: true });
  for (const plan of [{ source: "reset", key: "wake-word" },
    { source: "import", file: settingsFile({ "wake-word": { sureness: 50 } }) }]) {
    const result = await api("apply", { plan, accept: ["wake-word.sureness"], confirmLoosening: true });
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
  }
  const result = await tool("settings.loosen", { changes: [{ setting: "wake-word.sureness", value: 50 }] });
  assert.equal(result.changed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(await value("wake-word.sureness"), 99);
});

test("preset shared apply path classifies numeric fixture proposals without adding a shipped preset", async (t) => {
  const { app, owner, value } = await fixture(t);
  const ids = new Set(numeric.map(([key, field]) => `${key}.${field}`));
  assert.ok(presets.every((preset) => preset.sets.every((entry) => !ids.has(`${entry.key}.${entry.field}`))),
    "real presets now contain numeric proposals; add their acceptance cases");
  const fixtureProposals = numeric.slice(0, 2).map(([key, field, , to]) => ({ key, field, value: to }));
  const { changes } = changesFor(app.store, owner, fixtureProposals);
  const choice = { accept: changes.map((change) => change.id), confirmLoosening: false, why: "numeric preset-path fixture" };
  assert.throws(() => applyWithPins(app.store, owner, changes, choice), /less careful/);
  assert.equal(await value("wake-word.sureness"), 80);
  assert.equal(await value("live-dictation.silenceSeconds"), 4);
  assert.equal(applyWithPins(app.store, owner, changes, { ...choice, confirmLoosening: true }).applied.length, 2);
});

test("numeric loosening through a conversation asks each time and cannot remember its approval", async (t) => {
  let calls = 0, threshold = 50;
  const provider = { name: "scripted", async complete() {
    return calls++ === 0 ? { content: "", toolCalls: [{ id: "numeric-change", name: "settings.loosen",
      arguments: JSON.stringify({ changes: [{ setting: "wake-word.sureness", value: threshold }] }) }] }
      : { content: "Finished.", toolCalls: [] };
  } };
  const { app, owner, value } = await fixture(t, provider);
  savePolicy(app.store, owner, { preset: "off" });
  const ask = (sessionId) => {
    calls = 0;
    return app.runtime.run({ prompt: "Change the wake confidence", ...(sessionId ? { sessionId } : {}) });
  };
  const paused = await ask();
  assert.equal(paused.status, "needs_input", paused.output);
  assert.equal(await value("wake-word.sureness"), 80);
  assert.equal(app.runtime.approvals.questionFor(paused.sessionId).remember, "never");
  assert.throws(() => app.runtime.approve(paused.sessionId, "allow", "session"), /once|kept|remember|time/i);
  app.runtime.approve(paused.sessionId, "allow", "never");
  // A yes for 50 is not a yes for another numeric value, even in the same conversation.
  threshold = 60;
  const changedCall = await ask(paused.sessionId);
  assert.equal(changedCall.status, "needs_input", changedCall.output);
  assert.equal(await value("wake-word.sureness"), 80);
  app.runtime.approve(paused.sessionId, "allow", "never");
  assert.equal((await ask(paused.sessionId)).status, "completed");
  assert.equal(await value("wake-word.sureness"), 60);
  app.store.save("settings", owner, "wake-word", { sureness: 80 });
  assert.equal((await ask(paused.sessionId)).status, "needs_input");
  assert.equal(await value("wake-word.sureness"), 80);
});

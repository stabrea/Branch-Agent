import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { settingsCatalogue, specFor } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor, currentValue } from "../dist/settings-kit/changes.js";
import { settingsKitWriters } from "../dist/settings-kit/writers.js";
import { setLockdown } from "../dist/lockdown.js";
import { readPolicy } from "../dist/policy.js";
import { reviewerSettings } from "../dist/approval-reviewer.js";
import { loopGuardMode } from "../dist/loop-guard.js";
import { folderTrustMode } from "../dist/folder-trust.js";
import { securityCheckSettings } from "../dist/security-audit/settings.js";
import { wallSettings } from "../dist/sandbox.js";
import { safetyMode } from "../dist/safety-extras/settings.js";
import { boardMode } from "../dist/flows-boards/settings.js";
import { reachMode, savedReachMode } from "../dist/reach/settings.js";
import { askMode } from "../dist/asks/settings.js";
import { readDesktopSettings } from "../dist/integrations/desktop-config.js";
import { readKeychainSettings } from "../dist/vault-sources.js";
import { readVaultAutofillSettings } from "../dist/vault-autofill.js";
import { mediaProgramsSettings } from "../dist/media-programs.js";
import { speechEngineSettings } from "../dist/speech-engines.js";
import { executionMetricsSettings } from "../dist/execution-metrics.js";
import { usageLimitsSettings } from "../dist/usage-limits.js";
import { listenSettings } from "../dist/listen-address.js";
import { moveInMode } from "../dist/migrate/switch.js";
import { memoryHistorySettings } from "../dist/memory-git.js";
import { pullRequestHookSettings } from "../dist/pr-hook.js";
import { skillInstallMode } from "../dist/skill-installs.js";
import { workspaceEditorSettings } from "../dist/workspace-editor-api.js";
import { readChatPermissionSettings } from "../dist/channels/chat-permissions.js";
import { wakeWordSettings } from "../dist/voice-wake.js";
import { dictationSettings } from "../dist/voice-dictation.js";
import { localModelsMode } from "../dist/local-jobs.js";
import { usageReportSettings } from "../dist/usage-report.js";
import { eventLoopSettings } from "../dist/event-loop-watch.js";
import { recordingSettings } from "../dist/run-recording.js";
import { promptLibrarySettings } from "../dist/prompt-library.js";
import { commandSettings } from "../dist/commands/settings.js";
import { flyCoreSettings } from "../dist/fly-core/settings.js";
import { goalUndoSettings } from "../dist/goal-mode.js";
import { reflectionSettings } from "../dist/reflection/settings.js";
import { contextFileSettings } from "../dist/context-files.js";
import { retentionSettings } from "../dist/retention.js";
import { readComfort } from "../dist/comfort/settings.js";
import { voiceSettings } from "../dist/voice.js";
import { saveReviewerSettings } from "../dist/approval-reviewer.js";
import { saveReflectionSettings } from "../dist/reflection/settings.js";

/*
 * Q65: the settings kit reads and writes every setting through the app's own parse. A record the app would
 * not accept is shown as what the app really runs, and a change made from the kit cannot bring an ignored
 * field or mode back to life.
 */

const mode = (reader) => (store, owner) => ({ mode: reader(store, owner) });
const part = (reader, name) => mode((store, owner) => reader(store, owner, name));

/** Every catalogue setting whose module reads it through a strict schema, and that module's own reader. */
const strictReaders = {
  policy: readPolicy,
  approval_reviewer: reviewerSettings,
  loop_guard: mode(loopGuardMode),
  folder_trust_mode: mode(folderTrustMode),
  "security-check": securityCheckSettings,
  "os-sandbox": wallSettings,
  "desktop-control": readDesktopSettings,
  "keychain-entries": readKeychainSettings,
  "vault-autofill": readVaultAutofillSettings,
  "media-programs": mediaProgramsSettings,
  "speech-engines": speechEngineSettings,
  "execution-metrics": executionMetricsSettings,
  "usage-limits": usageLimitsSettings,
  "listen-address": listenSettings,
  "move-in-switch": mode(moveInMode),
  "memory-history": memoryHistorySettings,
  "pull-request-hook": pullRequestHookSettings,
  "skill-installs": mode((store, owner) => skillInstallMode({ store, runtime: { owner } })),
  "workspace-editor": workspaceEditorSettings,
  "chat-permissions": readChatPermissionSettings,
  "wake-word": wakeWordSettings,
  "live-dictation": dictationSettings,
  "local-models": mode(localModelsMode),
  "usage-report": usageReportSettings,
  "event-loop-watch": eventLoopSettings,
  "run-recording": recordingSettings,
  "prompt-library": promptLibrarySettings,
  "command-catalog": commandSettings,
  "fly-core": flyCoreSettings,
  "goal-undo": goalUndoSettings,
  reflection: reflectionSettings,
  "context-files": contextFileSettings,
  retention: retentionSettings,
  ...Object.fromEntries(["command-scan", "progress-judge", "activity-chain", "tool-scripts", "wasm-add-ons", "history-repair"]
    .map((name) => [`safety-${name}`, part(safetyMode, name)])),
  ...Object.fromEntries(["recipe-checks", "widgets", "install-requests", "time-travel", "kanban", "waiting-line", "focus"]
    .map((name) => [`flowboards-${name}`, part(boardMode, name)])),
  ...Object.fromEntries(["machines", "remote-trunks", "background-screen", "video", "relay", "send", "platform-pause",
    "agent-git", "skill-bundles", "usb", "notes", "arena"].map((name) => [`reach-${name}`, part(savedReachMode, name)])),
  ...Object.fromEntries(["analytics", "answer-engine", "runtimes", "nodes", "project-board"]
    .map((name) => [`asks-${name}`, part(askMode, name)])),
  ...Object.fromEntries(["keys", "display", "notify", "files", "mcp"]
    .map((card) => [`comfort-${card}`, (store, owner) => readComfort(store, owner, card)])),
};

/**
 * Strict settings whose module stops on a record it cannot read rather than starting again from its first
 * values. The kit shows the starting values and refuses a change, so nothing in the record comes back.
 */
const refusingReaders = { voice: voiceSettings };

/** The settings whose module does not throw a whole record away, so the kit's own field-by-field reading already matches it. */
const notStrict = {
  "sdk-kit": "read field by field (src/sdk-kit.ts, sdkKitMode)",
  "local-runner-install": "a loose record, read field by field (src/local-one-button.ts)",
  "local-runner-place": "a loose record, read field by field (src/local-one-button.ts)",
  adapt: "a loose record, read field by field (src/adapt/settings.ts)",
};

/** Records that do not refuse an unknown field are made unreadable another way. */
const unreadableExtra = { "local-models": { enabled: "yes" } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-kit-parse-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, owner: app.runtime.owner };
}

const readPath = (data, field) => field.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), data);
function setPath(data, field, value) {
  const [head, ...rest] = field.split(".");
  return { ...data, [head]: rest.length ? setPath(data[head] ?? {}, rest.join("."), value) : value };
}

/** A value the field can hold that is not `from` (its starting value unless said): the less careful end, where there is one. */
function raised(field, from = field.initial) {
  const kind = field.kind;
  if (kind.type === "switch") return ["on", "when-needed", "off"].find((position) => position !== from);
  if (kind.type === "yes-no") return !from;
  if (kind.type === "choice") return [...kind.options].reverse().find((option) => option !== from);
  return from === kind.max ? kind.min : kind.max;
}

/**
 * A record the app would not accept. With several fields, the first holds the wrong kind of value and the
 * others are raised, so a raw write of the first would make the record readable and bring the others back.
 * With one field, it is raised and the record carries something the schema refuses.
 */
function unreadable(spec) {
  const [first, ...others] = spec.fields;
  if (!others.length) return { ...setPath({}, first.field, raised(first)), ...(unreadableExtra[spec.key] ?? { q65Unknown: 1 }) };
  return others.reduce((data, field) => setPath(data, field.field, raised(field)), setPath({}, first.field, { wrong: "kind" }));
}

const inForce = (reader, store, owner, field) => readPath(reader(store, owner), field.field) ?? field.initial;
const strictSpecs = () => settingsCatalogue.filter((spec) => strictReaders[spec.key]);

test("every catalogue setting is either read through its module's strict reader or named as read field by field", async (t) => {
  const { app } = await fixture(t);
  const writers = settingsKitWriters(app);
  for (const spec of settingsCatalogue)
    assert.ok(strictReaders[spec.key] || refusingReaders[spec.key] || notStrict[spec.key], `${spec.key}: say which reader the app uses, and whether it is strict`);
  for (const key of [...Object.keys(strictReaders), ...Object.keys(refusingReaders)]) {
    const spec = specFor(key);
    assert.ok(spec, `${key} is in the catalogue`);
    assert.equal(typeof spec.read, "function", `${key}: a strict setting must be read through its module (a read hook)`);
    assert.ok(typeof spec.write === "function" || writers[key], `${key}: a strict setting must be written through its module, not merged raw`);
  }
});

test("an unreadable record shows what the app has in force, not what lies in the record", async (t) => {
  const { store, owner } = await fixture(t);
  for (const spec of strictSpecs()) {
    store.save("settings", owner, spec.key, unreadable(spec));
    for (const field of spec.fields)
      assert.deepEqual(currentValue(store, owner, spec, field), inForce(strictReaders[spec.key], store, owner, field),
        `${spec.key}.${field.field} should show what the app reads`);
  }
});

test("a kit write of one field cannot bring back another field or mode the app was ignoring", async (t) => {
  const { app, store, owner } = await fixture(t);
  const writers = settingsKitWriters(app);
  for (const spec of strictSpecs()) {
    const reader = strictReaders[spec.key];
    store.save("settings", owner, spec.key, unreadable(spec));
    const before = Object.fromEntries(spec.fields.map((field) => [field.field, inForce(reader, store, owner, field)]));
    const [first, ...others] = spec.fields;
    // Moved away from what is in force (the wall reads a damaged record as "on", not as where it starts).
    const to = raised(first, before[first.field]);
    const { changes } = changesFor(store, owner, [{ key: spec.key, field: first.field, value: to }]);
    applyChanges(store, owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true, why: "test", writers });
    const raw = store.get("settings", owner, spec.key)?.data ?? {};
    assert.deepEqual(inForce(reader, store, owner, first), to, `${spec.key}.${first.field}: the change is in force`);
    assert.deepEqual(readPath(raw, first.field), to, `${spec.key}.${first.field}: the change is what is saved`);
    for (const field of others) {
      assert.deepEqual(inForce(reader, store, owner, field), before[field.field], `${spec.key}.${field.field}: an ignored value stays ignored`);
      assert.deepEqual(readPath(raw, field.field) ?? field.initial, before[field.field], `${spec.key}.${field.field}: the saved record agrees with the app`);
    }
  }
});

test("while Lockdown is on, the kit shows the owner's own saved switch, not Lockdown's view of it", async (t) => {
  const { store, owner } = await fixture(t);
  store.save("settings", owner, "reach-machines", { mode: "on" });
  store.save("settings", owner, "listen-address", { where: "private-network" });
  store.save("settings", owner, "wake-word", { mode: "on" });
  setLockdown(store, owner, { on: true });
  // Lockdown really is on: the app itself reads each as off while it lasts.
  assert.equal(reachMode(store, owner, "machines"), "off");
  assert.equal(listenSettings(store, owner).where, "this-computer");
  assert.equal(wakeWordSettings(store, owner).mode, "off");
  const shown = (key, field) => currentValue(store, owner, specFor(key), specFor(key).fields.find((entry) => entry.field === field));
  assert.equal(shown("reach-machines", "mode"), "on");
  assert.equal(shown("listen-address", "where"), "private-network");
  assert.equal(shown("wake-word", "mode"), "on");
});

const all = (changes) => ({ accept: changes.map((change) => change.id), confirmLoosening: true, why: "test" });
const voiceField = (field) => specFor("voice").fields.find((entry) => entry.field === field);
const brokenVoice = { systemVoice: "on", autoReadAloud: "yes", keepAudioOnThisComputer: true, replyWithVoiceOnChannels: true };

test("voice: an unreadable record shows the starting values, and reading it does not stop the kit", async (t) => {
  const { store, owner } = await fixture(t);
  store.save("settings", owner, "voice", brokenVoice);
  assert.throws(() => voiceSettings(store, owner), "the app itself cannot read this record");
  for (const field of specFor("voice").fields)
    assert.equal(currentValue(store, owner, specFor("voice"), field), field.initial, `voice.${field.field} shows its starting value`);
});

test("voice: a kit write to an unreadable record is refused, and the record is left exactly as it was", async (t) => {
  const { app, store, owner } = await fixture(t);
  store.save("settings", owner, "voice", brokenVoice);
  const { changes } = changesFor(store, owner, [{ key: "voice", field: "autoReadAloud", value: true }]);
  assert.equal(changes.length, 1);
  assert.throws(() => applyChanges(store, owner, changes, { ...all(changes), writers: settingsKitWriters(app) }), /cannot be read, so nothing was changed/);
  assert.deepEqual(store.get("settings", owner, "voice").data, brokenVoice);
  // A readable record is still changed through the voice card's own save.
  store.save("settings", owner, "voice", {});
  const again = changesFor(store, owner, [{ key: "voice", field: "autoReadAloud", value: true }]).changes;
  applyChanges(store, owner, again, all(again));
  assert.equal(voiceSettings(store, owner).autoReadAloud, true);
  assert.equal(currentValue(store, owner, specFor("voice"), voiceField("autoReadAloud")), true);
});

test("a kit write of one field keeps every other field of a readable record, catalogued or not", async (t) => {
  const { app, store, owner } = await fixture(t);
  const writers = settingsKitWriters(app);
  // The fields the kit does not show, saved through each card's own save so any copy kept in memory agrees.
  saveReviewerSettings(store, owner, { mode: "off", rules: "x", preset: "strict", maxTokens: 3000 });
  saveReflectionSettings(store, owner, { reflection: "off", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  const write = (key, field, value) => {
    const { changes } = changesFor(store, owner, [{ key, field, value }]);
    applyChanges(store, owner, changes, { ...all(changes), writers });
  };
  write("approval_reviewer", "mode", "on");
  assert.deepEqual(reviewerSettings(store, owner), { mode: "on", rules: "x", preset: "strict", maxTokens: 3000 });
  assert.deepEqual(store.get("settings", owner, "approval_reviewer").data, { mode: "on", rules: "x", preset: "strict", maxTokens: 3000 });
  write("reflection", "reflection", "on");
  assert.deepEqual(reflectionSettings(store, owner), { reflection: "on", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  assert.deepEqual(store.get("settings", owner, "reflection").data, { reflection: "on", everyTurns: 50, newSkills: "on", retireAfterDays: 90 });
  // Every strict setting with more than one field: the others, raised away from where they start, stay put.
  const readers = { ...strictReaders, voice: voiceSettings };
  for (const spec of settingsCatalogue.filter((entry) => readers[entry.key] && entry.fields.length > 1)) {
    const reader = readers[spec.key];
    store.save("settings", owner, spec.key, spec.fields.reduce((data, field) => setPath(data, field.field, raised(field)), {}));
    const before = Object.fromEntries(spec.fields.map((field) => [field.field, inForce(reader, store, owner, field)]));
    const [first, ...others] = spec.fields;
    write(spec.key, first.field, raised(first, before[first.field]));
    for (const field of others)
      assert.deepEqual(inForce(reader, store, owner, field), before[field.field], `${spec.key}.${field.field}: kept when ${first.field} was written`);
  }
});

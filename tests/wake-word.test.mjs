/**
 * mac7/wake-pins: the word that starts a turn.
 *
 * Nothing here opens a microphone, plays a sound, or runs a real program: the spotter is always
 * reached through a runner handed in by the test, and the sound is a few bytes made up here. The
 * four things the owner was promised are each a test: nothing is recorded before the word is heard,
 * no sound leaves this computer, the listener is refused while the switch is off, and it is refused
 * under Lockdown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveVoiceSettings } from "../dist/voice.js";
import {
  askSpotter, isTheWord, listenForWake, saveWakeWordSettings, wakeRefusal, wakeSpotter, wakeWordSettings, wakeWordState,
} from "../dist/voice-wake.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-word-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, store: app.store, owner: "local" };
}

/** A spotter that answers whatever the test says, and writes down every call it was given. */
function fakeRunner(answers) {
  const calls = [];
  return {
    calls,
    runner: async (file, args, input) => {
      calls.push({ file, args: [...args], bytes: input.length });
      const next = answers.shift() ?? "";
      return { code: 0, stdout: next, stderr: "" };
    },
  };
}

const chunks = async function* (count) {
  for (let index = 0; index < count; index += 1) yield { sound: new Uint8Array([1, 2, 3, index]), seconds: 2 };
};

test("W1 it ships off, and while it is off nothing listens at all", async (t) => {
  const { store, owner } = await fixture(t);
  assert.deepEqual(wakeWordSettings(store, owner), { mode: "off", word: "", sureness: 80, windowSeconds: 2 });
  const { runner, calls } = fakeRunner(["branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(3));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 0, "a window of sound was looked at while the switch was off");
  assert.match(heard.refusal, /switched off/);
  assert.deepEqual(calls, [], "the spotter was asked something while the switch was off");
});

test("W2 nothing is recorded before the word is heard: no file is written, and each window is dropped", async (t) => {
  const { store, owner, root } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const before = await readdir(root, { recursive: true });
  // Four windows of sound, none of them the word: the listener looks at each and keeps nothing.
  const { runner, calls } = fakeRunner(["", "the weather", "nothing at all", ""]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(4));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 4);
  assert.deepEqual(await readdir(root, { recursive: true }), before, "a file appeared while it was listening");
  // The sound was handed to the spotter on its standard input; no file name is ever an argument.
  for (const call of calls) {
    assert.equal(call.bytes, 4, "a window bigger than the one that arrived was held");
    assert.ok(!call.args.some((argument) => argument.includes(root)), `the sound was written somewhere: ${call.args.join(" ")}`);
  }
});

test("W3 the word is heard, once, and the listener stops there", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "Branch" });
  const { runner, calls } = fakeRunner(["", "hey Branch!", "should never be asked"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(3));
  assert.deepEqual(heard, { heard: true, refusal: null, windowsTried: 2 });
  assert.equal(calls.length, 2, "it kept listening after it had heard the word");
  assert.ok(isTheWord("Hey, Branch.", "branch"), "punctuation and capitals stopped the word being recognised");
  assert.ok(!isTheWord("nothing like it", "branch"), "a sentence without the word counted as the word");
});

test("W4 no sound leaves this computer: nothing is fetched, and no service is ever the spotter", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the wake word reached the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const { runner, calls } = fakeRunner(["", "branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(2));
  assert.equal(heard.heard, true);
  // Every spotter this app will ever use is a program on this computer, never an address.
  for (const platform of ["win32", "darwin", "linux"]) {
    const spotter = wakeSpotter({ localSpeechExecutable: "", localSpeechModel: "", localSpeechKind: "whisper-cpp" },
      { mode: "on", word: "branch", sureness: 80, windowSeconds: 2 }, platform);
    if (spotter.command) assert.ok(!/^https?:/i.test(spotter.command.file), `${platform} would call out`);
  }
  assert.ok(calls.every((call) => !/^https?:/i.test(call.file)));
});

test("W5 it is refused under Lockdown, whatever the switch says", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  assert.equal(wakeRefusal(store, owner, "win32"), null);
  setLockdown(store, owner, { on: true });
  assert.equal(wakeWordSettings(store, owner).mode, "off", "Lockdown did not switch listening off");
  assert.match(wakeRefusal(store, owner, "win32"), /Lockdown is on/);
  const { runner, calls } = fakeRunner(["branch"]);
  const heard = await listenForWake({ store, owner, runner, platform: "win32" }, chunks(2));
  assert.equal(heard.heard, false);
  assert.equal(heard.windowsTried, 0);
  assert.deepEqual(calls, [], "it listened while Lockdown was on");
  setLockdown(store, owner, { on: false });
  assert.equal(wakeRefusal(store, owner, "win32"), null, "turning Lockdown off did not put the switch back");
});

test("W6 what each computer would really do, and the ones that say so and stay off", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const none = { localSpeechExecutable: "", localSpeechModel: "", localSpeechKind: "whisper-cpp" };
  const wake = wakeWordSettings(store, owner);

  const windows = wakeSpotter(none, wake, "win32");
  assert.equal(windows.available, true);
  assert.match(windows.how, /Windows' own speech recognition/);
  assert.equal(windows.command.file, "powershell.exe");
  assert.ok(windows.command.args.includes("branch"), "the word is passed as an argument, never pasted into the script");
  assert.match(windows.command.args.join(" "), /System\.Speech/);

  for (const platform of ["darwin", "linux"]) {
    const spotter = wakeSpotter(none, wake, platform);
    assert.equal(spotter.available, false, `${platform} claimed a spotter it does not have`);
    assert.equal(spotter.command, null);
    assert.match(spotter.how, /stays off/);
    assert.match(spotter.how, /never done/);
    assert.equal(wakeRefusal(store, owner, platform), spotter.how, `${platform} refuses in different words from the card`);
  }

  // A speech program the owner already set up here is used on any computer, and only that.
  saveVoiceSettings(store, owner, { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/whisper/tiny.bin" });
  for (const platform of ["darwin", "linux", "win32"]) {
    const spotter = wakeSpotter({ localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/whisper/tiny.bin", localSpeechKind: "whisper-cpp" }, wake, platform);
    assert.equal(spotter.available, true);
    assert.equal(spotter.command.file, "/opt/whisper/main");
  }
  assert.equal(wakeWordState(store, owner, "darwin").refusal, null, "the owner's own speech program was not used");
});

test("W7 a spotter with nothing to run is asked nothing, and a failed run is never the word", async () => {
  const { runner, calls } = fakeRunner(["branch"]);
  assert.deepEqual(await askSpotter(runner, { available: false, how: "", command: null }, "branch", new Uint8Array(2)),
    { heard: false, text: "" });
  assert.deepEqual(calls, []);
  const failing = async () => ({ code: 1, stdout: "branch", stderr: "no model" });
  assert.deepEqual(await askSpotter(failing, { available: true, how: "", command: { file: "x", args: [] } }, "branch", new Uint8Array(2)),
    { heard: false, text: "" });
});

test("W8 the switch and how sure it must be are in the catalogue; the word itself never is", async () => {
  const { classify, specFor } = await import("../dist/settings-kit/catalogue.js");
  assert.equal(classify("wake-word", "mode"), "less-careful-when-raised");
  assert.equal(classify("wake-word", "sureness"), "less-careful-when-lowered");
  // Nothing brought in from a preset or a settings file may ever choose what this computer listens for.
  assert.equal(classify("wake-word", "word"), "blocked");
  assert.deepEqual(specFor("wake-word").fields.map((field) => field.field), ["mode", "sureness"]);
  assert.equal(specFor("wake-word").home, "settings:voice");
});

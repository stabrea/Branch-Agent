/**
 * mac7/wake-mic: the microphone wired to the word that starts a turn.
 *
 * Nothing here opens a microphone, plays a sound, runs a real program or writes a file. The two
 * places Branch would touch the outside world — the recorder and the spotter — are handed in as
 * fakes, through the same options `src/index.ts` fills with the real ones, so what is proved here
 * is the real wiring rather than a copy of it. Whether a recorder is on this computer is a fake
 * answer too, so no test depends on what happens to be installed on the machine running it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { saveWakeWordSettings, startWakeWord, windowBytes } from "../dist/voice-wake.js";

/** A recorder that never exists unless a test says it does. */
const has = (...names) => (name) => names.includes(name);

/**
 * A microphone that is not a microphone: it counts how often one window would have been recorded,
 * remembers exactly what would have been run, and lets go the moment its window is over — which is
 * what "the microphone is released" means here, because the real recorder is one program per window.
 */
function fakeMicrophone(sound = new Uint8Array([1, 2, 3, 4])) {
  const mic = { windows: 0, openNow: 0, mostOpenAtOnce: 0, ran: [], everAborted: false };
  const capture = async (command, windowSeconds, signal) => {
    mic.windows += 1;
    mic.ran.push({ file: command.file, args: [...command.args], windowSeconds });
    mic.openNow += 1;
    mic.mostOpenAtOnce = Math.max(mic.mostOpenAtOnce, mic.openNow);
    try {
      if (signal.aborted) { mic.everAborted = true; return new Uint8Array(0); }
      await new Promise((settle) => setTimeout(settle, 1));
      return sound;
    } finally { mic.openNow -= 1; }
  };
  return { mic, capture };
}

/** A spotter that answers whatever the test says, for ever, and writes down every window it saw. */
function fakeSpotter(...answers) {
  const seen = [];
  const runner = async (file, args, input) => {
    seen.push({ file, args: [...args], bytes: input.length });
    return { code: 0, stdout: answers[Math.min(seen.length - 1, answers.length - 1)] ?? "", stderr: "" };
  };
  return { seen, runner };
}

const until = async (check, what) => {
  for (let tries = 0; tries < 500; tries += 1) {
    if (check()) return;
    await new Promise((settle) => setTimeout(settle, 10));
  }
  throw new Error(`waited too long: ${what}`);
};

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-mic-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // Linux ships no word-spotter of its own, so the owner's speech program is what would spot the
  // word there. It is never run: the spotter is a fake handed in by each test.
  saveVoiceSettings(app.store, "local", { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/m.bin" });
  return { app, root, store: app.store, owner: "local" };
}

/** A listener on a Linux box with arecord really on it, driven by fakes and nothing else. */
function listener(store, owner, parts, onHeard = () => {}) {
  return startWakeWord({ store, owner, platform: "linux", present: has("arecord"),
    runner: parts.runner, capture: parts.capture, onHeard });
}

test("M1 the listener starts only when the switch is on, and nothing is recorded before it is", async (t) => {
  const { store, owner } = await fixture(t);
  const microphone = fakeMicrophone(), spotter = fakeSpotter("");
  const wake = listener(store, owner, { ...microphone, ...spotter });
  t.after(() => wake.stop());
  // Off, which is how it ships: no window was recorded and the spotter was never asked anything.
  assert.equal(wake.listening, false);
  assert.equal(microphone.mic.windows, 0, "a window was recorded while the switch was off");
  assert.deepEqual(spotter.seen, []);

  // A word on its own is not enough either: the switch is still off.
  saveWakeWordSettings(store, owner, { word: "branch" });
  wake.refresh();
  assert.equal(wake.listening, false);
  assert.equal(microphone.mic.windows, 0);

  saveWakeWordSettings(store, owner, { mode: "on" });
  wake.refresh();
  assert.equal(wake.listening, true);
  await until(() => microphone.mic.windows >= 3, "the microphone was never asked for a window");
  // One window at a time, for ever: the recorder is a program per window, so nothing accumulates.
  assert.equal(microphone.mic.mostOpenAtOnce, 1, "more than one window of sound was being recorded at once");
  assert.equal(microphone.mic.ran[0].file, "arecord");
  assert.equal(microphone.mic.ran[0].windowSeconds, 2);
  await wake.stop();
});

test("M2 a window with no word in it is dropped, and no file is ever written", async (t) => {
  const { store, owner, root } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const microphone = fakeMicrophone(), spotter = fakeSpotter("the weather", "nothing at all", "");
  const before = await readdir(root, { recursive: true });
  const heard = [];
  const wake = listener(store, owner, { ...microphone, ...spotter }, (text) => heard.push(text));
  t.after(() => wake.stop());
  await until(() => spotter.seen.length >= 4, "the spotter was never asked about a window");
  await wake.stop();

  assert.deepEqual(heard, [], "a turn was started without the word being heard");
  assert.deepEqual(await readdir(root, { recursive: true }), before, "a file appeared while it was listening");
  for (const window of spotter.seen) {
    assert.equal(window.bytes, 4, "more than the window that arrived was handed to the spotter");
    // The sound is handed over on standard input; no file name is ever an argument, to either program.
    assert.ok(!window.args.some((argument) => argument.includes(root)), window.args.join(" "));
  }
  for (const run of microphone.mic.ran) {
    assert.ok(!run.args.some((argument) => argument.includes(root)), run.args.join(" "));
    assert.ok(run.args.includes("-"), "the recorder was not writing to standard output");
  }
  // However long a recorder runs, one window is all it can hand over.
  assert.equal(windowBytes(2), 16000 * 2 * 2 + 4096);
});

test("M3 no sound leaves this computer while it listens", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the wake word reached the network"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const microphone = fakeMicrophone(), spotter = fakeSpotter("");
  const wake = listener(store, owner, { ...microphone, ...spotter });
  t.after(() => wake.stop());
  await until(() => spotter.seen.length >= 3, "nothing was listened to");
  await wake.stop();
  // Every program either part would run is a program on this computer, never an address.
  for (const run of [...microphone.mic.ran, ...spotter.seen]) assert.ok(!/^https?:/i.test(run.file), run.file);
});

test("M4 Lockdown stops it within one window, and the microphone is let go of", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const microphone = fakeMicrophone(), spotter = fakeSpotter("");
  const wake = listener(store, owner, { ...microphone, ...spotter });
  t.after(() => wake.stop());
  await until(() => wake.listening && microphone.mic.windows >= 2, "it never started");

  // Turned on from anywhere at all — the app, the command line, another window. The listener asks
  // again before every window rather than being told, so all of them stop it.
  setLockdown(store, owner, { on: true });
  await until(() => !wake.listening, "Lockdown did not stop the listener");
  const stopped = microphone.mic.windows;
  await new Promise((settle) => setTimeout(settle, 60));
  assert.equal(microphone.mic.windows, stopped, "it kept recording after Lockdown came on");
  assert.equal(microphone.mic.openNow, 0, "the microphone was still held after Lockdown came on");
});

test("M5 turning the switch off releases the capture, and closing the app does too", async (t) => {
  const { app, store, owner } = await fixture(t, {
    wake: { platform: "linux", present: has("arecord"), ...fakeSpotter(""), ...fakeMicrophone() },
  });
  // The app owns the listener, and the card reads whether it is listening from that listener.
  assert.equal(app.wake.listening, false, "it was listening before the switch was ever turned on");
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  app.wake.refresh();
  assert.equal(app.wake.listening, true);

  saveWakeWordSettings(store, owner, { mode: "off" });
  app.wake.refresh();
  await until(() => !app.wake.listening, "the switch going off did not stop the listener");

  // And on again, so that closing the app is what stops it the second time.
  saveWakeWordSettings(store, owner, { mode: "on" });
  app.wake.refresh();
  assert.equal(app.wake.listening, true);
  await app.close();
  assert.equal(app.wake.listening, false, "closing Branch left the listener holding the microphone");
});

test("M6 the turn the word starts carries no permission a typed one would not", async (t) => {
  const write = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: "notes/a.txt", content: "hi" }) };
  const provider = { name: "scripted", async complete() { return { content: "", toolCalls: [write] }; } };
  const microphone = fakeMicrophone(), spotter = fakeSpotter("branch, write a note");
  const { app, store, owner } = await fixture(t, {
    provider, wake: { platform: "linux", present: has("arecord"), runner: spotter.runner, capture: microphone.capture },
  });
  // Everything a task might change is asked about, exactly as the owner's own settings would have it.
  savePolicy(store, owner, { preset: "custom", rules: [{ tool: "*", decision: "ask" }] });

  // First the ordinary way in: the same words typed into the box.
  const typed = await app.runtime.run({ prompt: "branch, write a note" });
  assert.equal(typed.status, "needs_input", "a typed turn was not asked about at all, so there is nothing to compare");
  const typedQuestion = app.runtime.approvals.waiting(typed.sessionId)[0];
  assert.equal(typedQuestion.tool, "files.write");

  // Now the same words heard. The word starts the turn and grants nothing: the very same question.
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  app.wake.refresh();
  await until(() => app.runtime.approvals.waiting().length > 1, "the heard turn never asked anything");
  await app.wake.stop();
  const heardQuestion = app.runtime.approvals.waiting().find((question) => question.sessionId !== typed.sessionId);
  assert.ok(heardQuestion, "the turn the word started never reached the gate at all");
  // The proof is the gate firing, not the absence of a flag: the same tool, asked in the same
  // words, offered the same thing to remember, from the same kind of source.
  assert.equal(heardQuestion.tool, "files.write", "the heard turn skipped the question the typed one was asked");
  assert.equal(heardQuestion.question, typedQuestion.question);
  assert.equal(heardQuestion.label, typedQuestion.label);
  assert.equal(heardQuestion.target, typedQuestion.target);
  assert.equal(heardQuestion.source, "owner", "the heard turn came in as something other than the owner's own");
  assert.equal(heardQuestion.source, typedQuestion.source);
  assert.equal(heardQuestion.remember, typedQuestion.remember);
  // And it really stops there: a turn that had been granted something would have gone ahead.
  await until(() => app.store.run(heardQuestion.runId).status === "needs_input", "the heard turn never stopped to ask");
  assert.equal(app.store.run(heardQuestion.runId).status, "needs_input");
  // Nothing was written, by either turn: both are still waiting to be asked.
  await assert.rejects(readdir(join(app.runtime.workspace, "notes")), /ENOENT/);
});

/**
 * mac7/wake-mac: the word that starts a turn, listening on a Mac.
 *
 * macOS ships no recorder a program can ask, so Branch uses one the owner installed themselves —
 * sox (`rec`) or ffmpeg — and says so. Nothing here opens a microphone, records anything, plays a
 * sound, runs a real program or writes a file: the recorder and the spotter are both fakes handed
 * in through the same options `src/index.ts` fills with the real ones, and whether a program is on
 * this computer is a fake answer too, so no test depends on what is installed on the machine
 * running it. What a real `rec` would do with these arguments is stated in the brief's report and
 * is the one thing no test here can prove, because proving it would mean recording.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { saveWakeWordSettings, startWakeWord, wakeParts, wakeRefusal, wakeWordView } from "../dist/voice-wake.js";
import { wakeCaptureRunner } from "../dist/voice-wake-host.js";

/** A program is on this computer only when a test says it is. */
const has = (...names) => (name) => names.includes(name);
const never = () => false;

/** What `rec` is really asked for: one channel, sixteen thousand samples a second, two bytes each. */
const recArguments = ["-q", "-c", "1", "-r", "16000", "-b", "16", "-e", "signed-integer", "-t", "wav", "-",
  "trim", "0", "2"];

/**
 * A microphone that is not a microphone: it counts the windows, remembers what would have been run,
 * and lets go the moment its window is over — which is what "the microphone is released" means here,
 * because the real recorder is one program per window and ending it is what releases the device.
 */
function fakeMicrophone(sound = new Uint8Array([1, 2, 3, 4])) {
  const mic = { windows: 0, openNow: 0, mostOpenAtOnce: 0, ran: [] };
  const capture = async (command, windowSeconds, signal) => {
    mic.windows += 1;
    mic.ran.push({ file: command.file, args: [...command.args], windowSeconds });
    mic.openNow += 1;
    mic.mostOpenAtOnce = Math.max(mic.mostOpenAtOnce, mic.openNow);
    try {
      if (signal.aborted) return new Uint8Array(0);
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
  const root = await mkdtemp(join(tmpdir(), "branch-wake-mac-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // macOS ships nothing that spots a word either, so the owner's own speech program is what does it
  // on a Mac, exactly as on Linux. It is never run: the spotter is a fake handed in by each test.
  saveVoiceSettings(app.store, "local", { localSpeechExecutable: "/opt/whisper/main", localSpeechModel: "/opt/m.bin" });
  return { app, root, store: app.store, owner: "local" };
}

/** A listener on a Mac with `rec` really on it, driven by fakes and nothing else. */
function listener(store, owner, parts, onHeard = () => {}) {
  return startWakeWord({ store, owner, platform: "darwin", present: has("rec"),
    runner: parts.runner, capture: parts.capture, onHeard });
}

test("K1 a Mac with sox on it really listens, with the arguments sox is really given", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });

  // What would run, before anything runs: `rec` is sox with the microphone already chosen.
  const { capture } = wakeParts(store, owner, "darwin", has("rec"));
  assert.equal(capture.available, true, "a Mac with sox on it still said it cannot listen");
  assert.equal(capture.kind, "recorder");
  assert.equal(capture.command.file, "rec");
  assert.deepEqual(capture.command.args, recArguments);
  assert.equal(wakeRefusal(store, owner, "darwin", has("rec")), null, "a Mac with sox on it was refused");

  // And the listener really starts, one window at a time, for ever.
  const microphone = fakeMicrophone(), spotter = fakeSpotter("");
  const wake = listener(store, owner, { ...microphone, ...spotter });
  t.after(() => wake.stop());
  assert.equal(wake.listening, true, "the switch was on, a word was chosen, sox was here, and nothing listened");
  await until(() => microphone.mic.windows >= 3, "the microphone was never asked for a window");
  assert.equal(microphone.mic.mostOpenAtOnce, 1, "more than one window of sound was being recorded at once");
  assert.deepEqual(microphone.mic.ran[0], { file: "rec", args: recArguments, windowSeconds: 2 });
  await wake.stop();
});

test("K2 sox without `rec`, and ffmpeg, are each asked for one window and nothing else", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });

  // `rec` is preferred where both are here; where only `sox` is, `-d` is what chooses the microphone.
  assert.equal(wakeParts(store, owner, "darwin", has("rec", "sox", "ffmpeg")).capture.command.file, "rec");
  const sox = wakeParts(store, owner, "darwin", has("sox", "ffmpeg")).capture.command;
  assert.equal(sox.file, "sox");
  assert.deepEqual(sox.args, ["-d", ...recArguments]);

  // ffmpeg is the last resort, and is held to one window by `-t` as well as by the count of bytes.
  const ffmpeg = wakeParts(store, owner, "darwin", has("ffmpeg")).capture.command;
  assert.equal(ffmpeg.file, "ffmpeg");
  assert.deepEqual(ffmpeg.args, ["-hide_banner", "-loglevel", "quiet", "-nostdin", "-f", "avfoundation", "-i",
    ":default", "-t", "2", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-"]);

  // Every one of them writes to standard output, and none of them is ever handed the owner's word.
  for (const command of [sox, ffmpeg, wakeParts(store, owner, "darwin", has("rec")).capture.command]) {
    assert.ok(command.args.includes("-"), `${command.file} was not writing to standard output`);
    assert.equal(command.args.includes("branch"), false, `${command.file} was handed the word`);
  }
});

test("K3 a Mac with no recording program says so, says which one to install, and stays off", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });

  const { capture } = wakeParts(store, owner, "darwin", never);
  assert.equal(capture.available, false, "a Mac with nothing on it claimed it could listen");
  assert.equal(capture.command, null, "a program was going to be run on a Mac that has none");
  assert.match(capture.how, /brew install sox/, "the card never says what could be installed");
  assert.match(capture.how, /will not install one of its own/, "the card does not say Branch installs nothing");
  assert.equal(wakeRefusal(store, owner, "darwin", never), capture.how,
    "the Mac refuses in different words from the ones on the card");

  // The card: it cannot listen, it is not listening, and the reason is the one sentence.
  const card = wakeWordView(store, owner, "darwin", true, false, never);
  assert.equal(card.canListen, false);
  assert.equal(card.listening, false);
  assert.match(card.capture.how, /brew install sox/);
  // The program's own path is a thing of this computer's; only the sentence travels.
  assert.deepEqual(Object.keys(card.capture).sort(), ["available", "how"]);

  // And nothing listens: the switch is on, a word is chosen, and no window is ever recorded.
  const microphone = fakeMicrophone(), spotter = fakeSpotter("branch");
  const wake = startWakeWord({ store, owner, platform: "darwin", present: never,
    runner: spotter.runner, capture: microphone.capture, onHeard: () => {} });
  t.after(() => wake.stop());
  assert.equal(wake.listening, false, "a Mac with no recording program held the microphone open");
  await new Promise((settle) => setTimeout(settle, 40));
  assert.equal(microphone.mic.windows, 0, "a window was recorded on a Mac that cannot record");
  await wake.stop();
});

test("K4 the card warns about the macOS permission before the switch is ever turned on", async (t) => {
  const { store, owner } = await fixture(t);
  // Off, as it ships, and with no word: what the owner reads before they decide anything.
  const card = wakeWordView(store, owner, "darwin", true, false, has("rec"));
  assert.equal(card.settings.mode, "off");
  assert.match(card.capture.how, /macOS itself will ask/, "the card does not warn about the system's own question");
  assert.match(card.capture.how, /yours to accept or refuse/, "the card does not say whose question it is");
  assert.match(card.capture.how, /Branch cannot answer it for you/, "the card suggests Branch could answer it");
  assert.match(card.capture.how, /^rec,/, "the card does not say which recording program it found");
  assert.match(card.capture.how, /let go of every window/, "the card drops the promise about releasing the microphone");
});

test("K5 a window with no word in it is dropped, and no file is ever written", async (t) => {
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
  for (const window of spotter.seen)
    assert.equal(window.bytes, 4, "more than the window that arrived was handed to the spotter");
  // No file name is ever an argument, to either program: the sound goes over standard output and in
  // on standard input, and the one window held is dropped whether the word was in it or not.
  for (const run of [...spotter.seen, ...microphone.mic.ran])
    assert.ok(!run.args.some((argument) => argument.includes(root)), run.args.join(" "));
});

test("K6 Lockdown, the switch going off and closing Branch each let go of the microphone", async (t) => {
  const { app, store, owner } = await fixture(t, {
    wake: { platform: "darwin", present: has("rec"), ...fakeSpotter(""), ...fakeMicrophone() },
  });
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  app.wake.refresh();
  assert.equal(app.wake.listening, true, "a Mac with sox on it did not start listening");

  // Lockdown, turned on from anywhere at all: the listener asks again before every window.
  setLockdown(store, owner, { on: true });
  await until(() => !app.wake.listening, "Lockdown did not stop the listener on a Mac");
  setLockdown(store, owner, { on: false });
  app.wake.refresh();
  assert.equal(app.wake.listening, true);

  // The switch itself.
  saveWakeWordSettings(store, owner, { mode: "off" });
  app.wake.refresh();
  await until(() => !app.wake.listening, "the switch going off did not stop the listener on a Mac");

  // And closing Branch, which is the last thing that could leave the microphone held.
  saveWakeWordSettings(store, owner, { mode: "on" });
  app.wake.refresh();
  assert.equal(app.wake.listening, true);
  await app.close();
  assert.equal(app.wake.listening, false, "closing Branch left the listener holding the microphone on a Mac");
});

test("K7 on a Mac too, the turn the word starts carries no permission a typed one would not", async (t) => {
  const write = { id: "c1", name: "files.write", arguments: JSON.stringify({ path: "notes/a.txt", content: "hi" }) };
  const provider = { name: "scripted", async complete() { return { content: "", toolCalls: [write] }; } };
  const microphone = fakeMicrophone(), spotter = fakeSpotter("branch, write a note");
  const { app, store, owner } = await fixture(t, {
    provider, wake: { platform: "darwin", present: has("rec"), runner: spotter.runner, capture: microphone.capture },
  });
  savePolicy(store, owner, { preset: "custom", rules: [{ tool: "*", decision: "ask" }] });

  const typed = await app.runtime.run({ prompt: "branch, write a note" });
  assert.equal(typed.status, "needs_input", "a typed turn was not asked about at all, so there is nothing to compare");
  const typedQuestion = app.runtime.approvals.waiting(typed.sessionId)[0];

  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  app.wake.refresh();
  await until(() => app.runtime.approvals.waiting().length > 1, "the heard turn never asked anything");
  await app.wake.stop();
  const heardQuestion = app.runtime.approvals.waiting().find((question) => question.sessionId !== typed.sessionId);
  assert.ok(heardQuestion, "the turn the word started never reached the gate at all");
  // The same tool, asked in the same words, from the same kind of source: hearing the word grants nothing.
  assert.equal(heardQuestion.tool, "files.write", "the heard turn skipped the question the typed one was asked");
  assert.equal(heardQuestion.question, typedQuestion.question);
  assert.equal(heardQuestion.label, typedQuestion.label);
  assert.equal(heardQuestion.target, typedQuestion.target);
  assert.equal(heardQuestion.source, "owner", "the heard turn came in as something other than the owner's own");
  assert.equal(heardQuestion.remember, typedQuestion.remember);
  await until(() => app.store.run(heardQuestion.runId).status === "needs_input", "the heard turn never stopped to ask");
  await assert.rejects(readdir(join(app.runtime.workspace, "notes")), /ENOENT/);
});

/* ---------- integration review (adversarial pass): the Mac path under attack ---------- */

test("K8 while macOS is still asking for the microphone, the blocked window cannot spin", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  // Until the owner answers macOS's own permission question, the recorder is refused the device: it
  // writes nothing and ends at once. Nothing paces the loop then — the recorder's own `trim 0 2`
  // never gets to run — so this used to come round as fast as the loop could turn, starting a fresh
  // recorder every time and asking the spotter about silence.
  const mic = { windows: 0 };
  const capture = async () => {
    mic.windows += 1;
    await new Promise((settle) => setImmediate(settle)); // lets a timer run, so this test can fail rather than hang
    return new Uint8Array(0);
  };
  const spotter = fakeSpotter("");
  const wake = listener(store, owner, { capture, runner: spotter.runner });
  t.after(() => wake.stop());
  await until(() => mic.windows >= 1, "the recorder was never started");
  const after = mic.windows;
  await new Promise((settle) => setTimeout(settle, 250));
  assert.ok(mic.windows - after <= 2,
    `a blocked microphone was asked ${mic.windows - after} times in a quarter of a second`);
  // A window that carried no sound is not a window: the spotter is not asked about silence, so
  // nothing is run over and over either.
  assert.deepEqual(spotter.seen, [], "the spotter was asked about a window that carried no sound");
  // And it does not read as a failure: it is still listening, and it will hear the word the moment
  // the owner says yes to macOS.
  assert.equal(wake.listening, true, "a Mac waiting for the owner to answer macOS looked like a failure");
  await wake.stop();
});

test("K9 every Mac recorder is bounded by its own length as well as by the count of bytes", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch", windowSeconds: 3 });
  // Each of the three is asked for one window and told, in its own words, to stop after it. The
  // count of bytes in src/voice-wake-host.ts is the second bound and applies to all three alike.
  const bounds = {
    rec: (args) => args.join(" ").includes("trim 0 3"),
    sox: (args) => args[0] === "-d" && args.join(" ").includes("trim 0 3"),
    ffmpeg: (args) => args[args.indexOf("-t") + 1] === "3",
  };
  for (const [name, bounded] of Object.entries(bounds)) {
    const { capture } = wakeParts(store, owner, "darwin", has(name));
    assert.equal(capture.command.file, name, `a Mac with only ${name} on it reached for something else`);
    assert.ok(bounded(capture.command.args), `${name} was not told to stop after one window: ${capture.command.args.join(" ")}`);
    // Never a shell string, never a file name, and never the owner's word.
    assert.ok(Array.isArray(capture.command.args), `${name} was given something other than an argument array`);
    for (const argument of capture.command.args) {
      assert.equal(typeof argument, "string");
      assert.ok(!/[;&|`$><]/.test(argument), `${name} was given something a shell would read: ${argument}`);
    }
    assert.equal(capture.command.args.includes("branch"), false, `${name} was handed the owner's word`);
    assert.equal(capture.command.args.some((a) => a.endsWith(".wav")), false, `${name} was given a file to write`);
  }
});

test("K10 the card says plainly that Branch runs the first such program on the search path", async (t) => {
  const { store, owner } = await fixture(t);
  // Branch does not check what `rec` is: it runs the first program of that name on the owner's own
  // search path. A directory anybody can write to, early on that path, would therefore decide what
  // runs — so the card has to say so rather than let "which you installed yourself" imply a check
  // that is not made. The containment that is real is stated too: no shell, and no environment.
  const view = wakeWordView(store, owner, "darwin", true, false, has("rec"));
  assert.match(view.capture.how, /first program called rec on your search path/,
    `the card implied a check Branch does not make: ${view.capture.how}`);
  assert.match(view.capture.how, /macOS/, "the card did not warn about the macOS permission question");
  // The full path of the program is the owner's own business and never travels.
  assert.equal(JSON.stringify(view).includes("/usr/"), false, "a program's full path travelled to the card");
});

test("K11 a Mac really runs its recorder now, and reaps it", { skip: process.platform === "win32" }, async (t) => {
  const { chmod, writeFile, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "branch-wake-mac-host-"));
  t.after(async () => { await discardTemp(root); });
  const { wakeCaptureRunner } = await import("../dist/voice-wake-host.js");
  const pidFile = join(root, "pid");
  const program = join(root, "rec");
  // A fake `rec` that pours out sound and never stops, exactly as the real one would if its `trim`
  // were ignored. A Mac used to be refused here outright; it is not any more, so the promise that
  // the program is ended every window has to be kept on a Mac too.
  await writeFile(program, `#!/bin/sh\necho $$ > ${pidFile}\nwhile :; do dd if=/dev/zero bs=65536 count=16 2>/dev/null; done\n`);
  await chmod(program, 0o755);
  const sound = await wakeCaptureRunner()({ file: program, args: [] }, 2, new AbortController().signal);
  const { windowBytes } = await import("../dist/voice-wake.js");
  assert.ok(sound.length <= windowBytes(2), `held ${sound.length} bytes, more than one window's ${windowBytes(2)}`);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone, which is the point */ } });
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } },
    "the Mac's recorder was still running after its window was over");
});

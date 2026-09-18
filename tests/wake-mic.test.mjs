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
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { saveWakeWordSettings, startWakeWord, wakeParts, wakeRefusal, wakeWordSettings, wakeWordState, windowBytes } from "../dist/voice-wake.js";
// Integration review (adversarial pass): the real runner, driven against fake programs in a
// temporary folder. It is the only part of Branch that would start a recorder, so the promises
// about killing and reaping one cannot be proved through a fake that stands in for it.
import { wakeCaptureRunner } from "../dist/voice-wake-host.js";
import { startServer } from "../dist/server.js";

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

test("M7 Windows really listens: its own engine opens the microphone, and the word is never in the script", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  // `never` everywhere: Windows ships no recorder, and none is looked for.
  const never = () => false;

  // The speech program the fixture set up could spot the word, but nothing on Windows could record
  // sound to give it, so Windows' own engine is what listens — the one that opens the microphone.
  for (const label of ["with a speech program of the owner's", "without one"]) {
    if (label === "without one") saveVoiceSettings(store, owner, { localSpeechExecutable: "", localSpeechModel: "" });
    const { spotter, capture } = wakeParts(store, owner, "win32", never);
    const script = spotter.command.args.join(" ");
    assert.equal(capture.kind, "spotter-listens", `${label}: Windows went looking for a recorder`);
    assert.equal(capture.command, null, `${label}: a recorder was going to be run on Windows`);
    assert.equal(spotter.command.file, "powershell.exe", label);
    assert.match(script, /SetInputToDefaultAudioDevice/, `${label}: the engine was left waiting on standard input`);
    assert.match(script, /Recognize\(\[TimeSpan\]/, `${label}: the engine was not held to one window`);
    assert.equal(script.includes("OpenStandardInput"), false, label);
    // The word and the window are values the program reads, never text inside the command.
    assert.equal(spotter.command.args.includes("branch"), false, `${label}: the word was on the command line`);
    assert.deepEqual(Object.keys(spotter.command.env).sort(),
      ["BRANCH_WAKE_SURENESS", "BRANCH_WAKE_WINDOW", "BRANCH_WAKE_WORD"], label);
    assert.equal(spotter.command.env.BRANCH_WAKE_WORD, "branch", label);
    assert.equal(spotter.command.env.BRANCH_WAKE_WINDOW, "2", label);
    assert.equal(wakeRefusal(store, owner, "win32", never), null, `${label}: Windows refused to listen`);
  }
});

test("M8 \"when needed\" says it is not wired up rather than listening all the time", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "when-needed", word: "branch" });
  const microphone = fakeMicrophone(), spotter = fakeSpotter("branch");
  const wake = listener(store, owner, { ...microphone, ...spotter });
  t.after(() => wake.stop());
  // The card promises that this setting listens only while a conversation is open on the screen,
  // and nothing tells the listener that; it holds nothing open rather than break the promise.
  assert.equal(wake.listening, false, "\"when needed\" held the microphone open the whole time");
  assert.equal(microphone.mic.windows, 0);
  assert.match(wakeRefusal(store, owner, "linux", has("arecord")), /not wired up yet/);
  await wake.stop();
});

/* ---------- integration review (adversarial pass): the promises under attack ---------- */

/**
 * A recorder that fails the way a real one does when it is not there, when the sound card is taken
 * away, or when the machine wakes from sleep with the device gone: the promise is rejected.
 */
const brokenMicrophone = (why = "no such device") => {
  const tries = { count: 0 };
  // The one real pause: it lets a timer run, so a test watching this can fail rather than hang if
  // the loop ever goes back to spinning. It is not what stops the spin; the listener is.
  return { tries, capture: async () => {
    tries.count += 1;
    await new Promise((settle) => setImmediate(settle));
    throw new Error(why);
  } };
};

test("M9 a recorder that fails loses one window, and never stops the app or hammers the device", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  // Node's test runner fails this test if the listener leaves a rejection nobody handled, which is
  // exactly what a recorder dying under it used to do: the loop's promise is only ever awaited by
  // stop(), so a throw on the way in went nowhere until the process noticed.
  const broken = brokenMicrophone(), spotter = fakeSpotter("");
  const wake = listener(store, owner, { capture: broken.capture, runner: spotter.runner });
  t.after(() => wake.stop());
  await until(() => broken.tries.count >= 1, "the recorder was never asked for a window");
  // A recorder can come back — the machine woke from sleep, a microphone was plugged back in — so
  // the window is lost and tried again rather than the listener giving up and going quiet until
  // some setting happens to be saved. What it must never do is hammer the dead device.
  const after = broken.tries.count;
  await new Promise((settle) => setTimeout(settle, 250));
  assert.ok(broken.tries.count - after <= 2,
    `a recorder that fails was retried ${broken.tries.count - after} times in a quarter of a second`);
  await wake.stop();
  // Stopping really stops it, however broken the recorder was.
  const stopped = broken.tries.count;
  await new Promise((settle) => setTimeout(settle, 120));
  assert.equal(broken.tries.count, stopped, "a failed recorder kept being asked after the listener stopped");
});

test("M10 a spotter that fails at once cannot spin, on the one computer that opens its own microphone", async (t) => {
  const { store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  // Windows' own engine opens the microphone itself, so no recorder paces the loop: nothing but the
  // spotter's own run does. A spotter that fails the instant it starts (no PowerShell, a policy that
  // blocks it, no microphone) therefore used to be started again as fast as the loop could turn.
  const runs = { count: 0 };
  // The one real pause, so a timer can run and this test can fail rather than hang the whole suite
  // if the loop ever spins again. It is not what paces the loop; the listener is.
  const runner = async () => {
    runs.count += 1;
    await new Promise((settle) => setImmediate(settle));
    return { code: 1, stdout: "", stderr: "boom" };
  };
  const wake = startWakeWord({ store, owner, platform: "win32", present: has(),
    runner, capture: async () => new Uint8Array(0), onHeard: () => {} });
  t.after(() => wake.stop());
  await until(() => runs.count >= 1, "the spotter was never asked");
  await new Promise((settle) => setTimeout(settle, 250));
  assert.ok(runs.count < 25, `a spotter that fails at once was run ${runs.count} times in a quarter of a second`);
  await wake.stop();
});

/**
 * The app's own listener, the one src/index.ts owns and wires to the lock — driven through the very
 * option createBranch fills with the real recorder and the real spotter, so what is under test is
 * the wiring itself rather than a second listener built beside it.
 */
async function appListener(t, answers = [""]) {
  const microphone = fakeMicrophone(), spotter = fakeSpotter(...answers);
  const { app, store, owner } = await fixture(t, { wake: {
    runner: spotter.runner, capture: microphone.capture, present: has("arecord"), platform: "linux" } });
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  app.wake.refresh();
  return { app, store, owner, microphone, spotter, wake: app.wake };
}

test("M11 unlocking Branch starts listening again, without a settings save", async (t) => {
  const { app, microphone, wake } = await appListener(t);
  await until(() => wake.listening, "the listener never started");
  app.sessionLock.lock();
  await until(() => wake.listening === false, "locking Branch did not let go of the microphone");
  const whileLocked = microphone.mic.windows;
  await new Promise((settle) => setTimeout(settle, 80));
  assert.equal(microphone.mic.windows, whileLocked, "a window was recorded while Branch was locked");
  // The owner unlocks from their own app. Nothing else should be needed to hear the word again:
  // before this it stayed silent until some setting happened to be saved.
  app.sessionLock.unlock();
  await until(() => wake.listening, "unlocking Branch left the wake word silent");
  await wake.stop();
});

test("M12 a locked Branch does not reopen the microphone when a setting is saved", async (t) => {
  const { app, store, owner, microphone, wake } = await appListener(t);
  await until(() => wake.listening, "the listener never started");
  app.sessionLock.lock();
  await until(() => wake.listening === false, "locking Branch did not let go of the microphone");
  const whileLocked = microphone.mic.windows;
  // Saving the card, a settings file or a preset calls refresh(). While Branch is locked that must
  // not be a way back to the microphone: the lock is a state, not a one-off push.
  saveWakeWordSettings(store, owner, { sureness: 90 });
  wake.refresh();
  assert.equal(wake.listening, false, "a settings save reopened the microphone on a locked Branch");
  await new Promise((settle) => setTimeout(settle, 80));
  assert.equal(microphone.mic.windows, whileLocked, "a locked Branch recorded a window after a settings save");
  await wake.stop();
});

/* ---------- the real recorder runner, against fake programs and never a microphone ---------- */

/**
 * A program written for this test and nothing else. It is a shell script in a temporary folder: it
 * is not a recorder, it opens nothing, and it is only ever asked to do what a recorder that
 * misbehaves would do. Skipped on Windows, which has no shell to run it with — and no recorder
 * either, so there is nothing there for this runner to do.
 */
async function fakeProgram(root, name, script) {
  const file = join(root, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

/** True while a process is still there. `kill(pid, 0)` asks without sending anything. */
const stillThere = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const notWindows = { skip: process.platform === "win32" ? "no shell to write a fake recorder with" : false };

test("M13 a recorder that will not stop is cut off at one window's bytes, and the program is ended", notWindows, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-host-"));
  t.after(async () => { await discardTemp(root); });
  const pidFile = join(root, "pid");
  // Pours out far more than one window and never ends by itself: exactly the recorder the card
  // promises cannot hold the microphone open or pile sound up in memory.
  const program = await fakeProgram(root, "endless",
    `echo $$ > ${pidFile}\nwhile :; do dd if=/dev/zero bs=65536 count=16 2>/dev/null; done`);
  const runner = wakeCaptureRunner("linux");
  const sound = await runner({ file: program, args: [] }, 2, new AbortController().signal);
  // One window of sound and not a byte more, however much the program wrote.
  assert.ok(sound.length <= windowBytes(2), `held ${sound.length} bytes, more than one window's ${windowBytes(2)}`);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, "the fake recorder never said which process it was");
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone, which is the point */ } });
  // The program that had the microphone is ended, not left running behind the answer.
  await until(() => !stillThere(pid), "the recorder was still running after its window was over");
});

test("M14 a recorder that ignores being asked to stop is ended for good", notWindows, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-host-"));
  t.after(async () => { await discardTemp(root); });
  const pidFile = join(root, "pid");
  // Turns a deaf ear to SIGTERM and holds on. Nothing may keep the microphone by refusing to go.
  const program = await fakeProgram(root, "stubborn",
    `trap '' TERM\necho $$ > ${pidFile}\nsleep 20`);
  const runner = wakeCaptureRunner("linux");
  const sound = await runner({ file: program, args: [] }, 1, new AbortController().signal);
  assert.equal(sound.length, 0, "a recorder that wrote nothing somehow produced sound");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone, which is the point */ } });
  // It is asked first and ended for good a moment later, well before its own twenty seconds.
  await until(() => !stillThere(pid), "a recorder that ignored SIGTERM was left holding the microphone");
});

test("M15 a recorder that ends early is not waited for, and leaves nothing behind", notWindows, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-host-"));
  t.after(async () => { await discardTemp(root); });
  const program = await fakeProgram(root, "quitter", "exit 0");
  const runner = wakeCaptureRunner("linux");
  const started = Date.now();
  const sound = await runner({ file: program, args: [] }, 5, new AbortController().signal);
  // It came back on the program ending rather than sitting out the whole five-second window.
  assert.ok(Date.now() - started < 3000, "a recorder that ended at once still held the window open");
  assert.equal(sound.length, 0);
});

test("M16 a recorder that is not there fails the window rather than hanging", notWindows, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-host-"));
  t.after(async () => { await discardTemp(root); });
  const runner = wakeCaptureRunner("linux");
  await assert.rejects(
    () => runner({ file: join(root, "not-here"), args: [] }, 1, new AbortController().signal),
    "a recorder that does not exist was not reported as a failure");
});

test("M17 this Mac is never asked to record, whatever it is handed", async () => {
  // The second lock on the same door: even if something got past the refusal, the runner on a Mac
  // starts no program at all. The card's "this Mac cannot listen" is kept here as well as there.
  await assert.rejects(() => wakeCaptureRunner("darwin")({ file: "arecord", args: [] }, 1, new AbortController().signal),
    /no recorder/i);
});

/* ---------- who may set it, and what the card promises ---------- */

test("M18 nobody but the owner can switch listening on, through any door", async (t) => {
  const { app, root, store, owner } = await fixture(t);
  saveWakeWordSettings(store, owner, { mode: "off", word: "branch" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const profile = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: profile.id, pin: "2468" });
  const post = (path, body) => fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body) });
  // The card's own door.
  assert.equal((await post("/api/voice/wake", { mode: "on" })).ok, false,
    "somebody else on this computer switched the microphone on");
  // And the door mac7/wake-mic opened: a settings file or a preset now starts and stops the
  // listener, so it must be refused the same way rather than being a way round the card.
  assert.equal((await post("/api/settings-kit/apply",
    { plan: { source: "set", key: "wake-word", field: "mode", value: "on" }, accept: [] })).ok, false,
    "a preset switched the microphone on for somebody who is not the owner");
  assert.equal(wakeWordSettings(store, owner).mode, "off", "the switch moved after every door was refused");
});

test("M19 the card's word about this Mac is the word the code keeps", async (t) => {
  const { store, owner } = await fixture(t);
  // The owner saves it On, on a Mac, with a speech program of their own set up: the strongest case
  // the card has to survive. Whatever the switch says, nothing listens and the sentence says why.
  saveWakeWordSettings(store, owner, { mode: "on", word: "branch" });
  const state = wakeWordState(store, owner, "darwin", false, has("arecord", "parecord", "sox", "rec", "ffmpeg"));
  assert.equal(state.canListen, false, "a Mac said it could listen for a word");
  assert.ok(state.refusal, "a Mac with the switch on gave no reason why nothing is listening");
  const microphone = fakeMicrophone(), spotter = fakeSpotter("branch");
  const wake = startWakeWord({ store, owner, platform: "darwin", present: has("arecord", "parecord"),
    runner: spotter.runner, capture: microphone.capture, onHeard: () => {} });
  t.after(() => wake.stop());
  assert.equal(wake.listening, false, "a Mac started listening for a word");
  assert.equal(microphone.mic.windows, 0, "a Mac recorded a window of sound");
  await wake.stop();
});

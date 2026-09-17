import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import {
  Speech, findOnPath as findsOnPath, parseEspeakVoices, parseSayVoices, systemVoiceArgs, systemVoiceProgram,
} from "../dist/voice-tts.js";
import { locateCommand, spawnCli } from "../dist/credential-cli.js";
import {
  KeychainSecrets, keychainCommand, keychainRefusal, saveKeychainSettings, secretProviderContract, spawnSecretCommand,
} from "../dist/vault-sources.js";
import {
  OsPermissions, capabilitiesFor, capabilityCheck, consentReaderFor, linuxSession, macSettingsLinks, probeReader,
} from "../dist/os-permissions.js";

/**
 * Wave mac1: reading aloud, passwords and the permissions page on a Mac and on Linux. Every program
 * here is a stand-in: a function, or a small script in a temporary folder. Nothing speaks, nothing
 * asks the real Keychain, and nothing puts a question on the screen.
 */
const posix = process.platform !== "win32";
const openPolicy = () => new NetworkPolicy({ allowPrivateAddresses: true });

async function temp(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => discardTemp(root));
  return root;
}
async function fixture(t) {
  const root = await temp(t, "branch-posix-os-");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(() => app.close());
  return app;
}
/** A shell script that stands in for a program, made runnable. */
async function fakeProgram(folder, name, body) {
  const path = join(folder, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

/* ---------------------------------------------------------------- reading aloud */

// The shape `say -v '?'` prints on macOS: a padded name, the language, then a sample sentence.
const sayVoices = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Bad News            en_US    # Hello! My name is Bad News.",
  "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
  "Grandma (Français (France)) fr_FR    # Bonjour, je m’appelle Grandma.",
  "Samantha            en_US    # Hello! My name is Samantha.",
  "",
].join("\n");
// The shape `espeak-ng --voices` prints: a heading, then columns.
const espeakVoices = [
  "Pty Language       Age/Gender VoiceName          File                 Other Languages",
  " 5  af              --/M      Afrikaans          gmw/af",
  " 2  en-gb           --/M      English_(Great_Britain) gmw/en               (en 2)",
  " 2  en-us           --/M      English_(America)  gmw/en-US            (en-r 5)(en 3)",
].join("\n");

test("the system voice is found per computer, and a Linux box with only spd-say is told why it cannot be used", () => {
  const only = (names) => (name) => (names[name] ?? null);
  assert.deepEqual(systemVoiceProgram("darwin", only({ say: "/usr/bin/say" })), { kind: "say", executable: "/usr/bin/say" });
  assert.deepEqual(systemVoiceProgram("linux", only({ "espeak-ng": "/usr/bin/espeak-ng", "spd-say": "/usr/bin/spd-say" })),
    { kind: "espeak-ng", executable: "/usr/bin/espeak-ng" });
  assert.match(systemVoiceProgram("linux", only({ "spd-say": "/usr/bin/spd-say" })), /spd-say, which can only speak through the loudspeaker/);
  assert.match(systemVoiceProgram("linux", only({})), /There is no system voice on this computer/);
  assert.match(systemVoiceProgram("freebsd", only({ say: "/x" })), /There is no system voice on this computer/);

  assert.deepEqual(systemVoiceArgs("say", { textPath: "/t/speech.txt", outPath: "/t/speech.wav", voice: "Samantha", speed: 1.2 }),
    ["--file-format=WAVE", "--data-format=LEI16@22050", "-o", "/t/speech.wav", "-r", "210", "-v", "Samantha", "-f", "/t/speech.txt"]);
  assert.deepEqual(systemVoiceArgs("espeak-ng", { textPath: "/t/speech.txt", outPath: "/t/speech.wav", voice: "", speed: 0.5 }),
    ["-w", "/t/speech.wav", "-s", "88", "-f", "/t/speech.txt"]);

  assert.deepEqual(parseSayVoices(sayVoices), ["Albert", "Bad News", "Eddy (English (UK))", "Grandma (Français (France))", "Samantha"]);
  assert.deepEqual(parseEspeakVoices(espeakVoices), ["Afrikaans", "English_(Great_Britain)", "English_(America)"]);
  assert.deepEqual(parseSayVoices("nothing useful"), []);
});

for (const [platform, program, name] of [["darwin", "say", "/usr/bin/say"], ["linux", "espeak-ng", "/usr/bin/espeak-ng"]]) {
  test(`reading aloud on ${platform} starts ${program} with a list of arguments and the words in a file`, async () => {
    const nasty = "-o /etc/passwd $(say pwned) `whoami` 'quoted' \"double\"";
    const started = [];
    const speech = new Speech(openPolicy(), fetch, async (file, args) => {
      started.push({ file, args });
      if (args.includes("?") || args.includes("--voices")) return program === "say" ? sayVoices : espeakVoices;
      // Stand in for the voice: check the words arrived as a file, then write the sound.
      const words = await readFile(args[args.indexOf("-f") + 1], "utf8");
      assert.equal(words, nasty, "the words arrive unchanged, as a file");
      await writeFile(args[args.indexOf(program === "say" ? "-o" : "-w") + 1], Buffer.from("RIFFfake"));
      return "";
    }, { platform, locate: (wanted) => (wanted === program ? name : null) });
    const spoken = await speech.speak({ text: nasty, voice: "Samantha", speed: 1 }, { kind: "windows" });
    assert.equal(Buffer.from(spoken.bytes).toString(), "RIFFfake");
    assert.equal(spoken.mediaType, "audio/wav");
    assert.equal(spoken.route, "windows", "the saved route name is kept");
    assert.equal(spoken.cost.amount, 0);
    assert.equal(started[0].file, name);
    for (const argument of started[0].args) assert.ok(!argument.includes("pwned"), "no part of the reply is an argument");
    const leftover = await readFile(started[0].args[started[0].args.indexOf("-f") + 1], "utf8").catch(() => "");
    assert.equal(leftover, "", "the temporary folder is removed afterwards");

    await assert.rejects(speech.speak({ text: "hi", voice: "-o /tmp/x", speed: 1 }, { kind: "windows" }), /not the name of a voice/);
    const voices = await speech.windowsVoices();
    assert.ok(voices.length >= 3, `${platform} lists its own voices`);
    assert.deepEqual(started.at(-1).args, program === "say" ? ["-v", "?"] : ["--voices"]);
  });
}

test("with no system voice, reading aloud says so and nothing is started", async () => {
  const started = [];
  const speech = new Speech(openPolicy(), fetch, async (file) => { started.push(file); return ""; },
    { platform: "linux", locate: () => null });
  await assert.rejects(speech.speak({ text: "hello", voice: "", speed: 1 }, { kind: "windows" }), /no system voice on this computer/);
  assert.deepEqual(await speech.windowsVoices(), []);
  const silent = new Speech(openPolicy(), fetch, async () => "", { platform: "darwin", locate: () => "/usr/bin/say" });
  await assert.rejects(silent.speak({ text: "hello", voice: "", speed: 1 }, { kind: "windows" }), /say produced no sound/);
  assert.deepEqual(started, []);
});

test("this Linux computer's own answer about a system voice is honest", { skip: process.platform !== "linux" }, async () => {
  // Only the search path is looked at; the stand-in runner refuses to start anything at all.
  const speech = new Speech(openPolicy(), fetch, async () => { throw new Error("nothing may be started in this test"); });
  const found = systemVoiceProgram("linux", (name) => findsOnPath(name));
  if (typeof found === "string") {
    await assert.rejects(speech.speak({ text: "hello", voice: "", speed: 1 }, { kind: "windows" }), /no system voice|spd-say/);
    assert.deepEqual(await speech.windowsVoices(), []);
  } else {
    await assert.rejects(speech.speak({ text: "hello", voice: "", speed: 1 }, { kind: "windows" }), /nothing may be started/);
  }
});

/* ---------------------------------------------------------------- password managers */

test("Bitwarden and 1Password are found by their bare names on a Mac or Linux search path", { skip: !posix }, async (t) => {
  const root = await temp(t, "branch-posix-cli-");
  const bin = join(root, "bin");
  await mkdir(bin);
  const bw = await fakeProgram(bin, "bw", 'printf "%s|" "$@"; printf "pw-from-fake-bw"');
  await fakeProgram(bin, "op.exe", "echo wrong");
  assert.equal(locateCommand("bw", "darwin", { PATH: `/nonexistent:${bin}` }), bw);
  assert.equal(locateCommand("op", "linux", { PATH: bin }), null, "a Windows name is not a program here");
  assert.equal(locateCommand("bw", "linux", { PATH: "" }), null);
  assert.equal(locateCommand(bw, "linux", { PATH: "" }), bw, "a full path is used as given");

  const previous = process.env.PATH;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  t.after(() => { process.env.PATH = previous; });
  const outcome = await spawnCli("bw", ["--nointeraction", "--raw", "get", "password", "GitHub Deploy"], 5000);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.stdout, "--nointeraction|--raw|get|password|GitHub Deploy|pw-from-fake-bw", "arguments arrive one by one, spaces and all");
  const missing = await spawnCli("op", ["read", "op://x"], 5000);
  assert.equal(missing.missing, true);
});

/* ---------------------------------------------------------------- the Keychain */

test("the Keychain is read only for entries the owner listed, through security find-generic-password -w", async (t) => {
  const app = await fixture(t);
  const calls = [];
  const runner = async (executable, args) => { calls.push({ executable, args }); return { code: 0, stdout: "kc-secret-5a6b\n", stderr: "" }; };
  const keychain = new KeychainSecrets(app.store, "local", app.store.secrets.scrubber, runner, "darwin");
  assert.equal(keychain.scheme, "keychain");
  assert.ok(secretProviderContract().some((entry) => entry.scheme === "keychain"));
  assert.equal(keychain.available(), false, "off until the owner turns it on");

  await assert.rejects(keychain.fill({ a: "secret://keychain/github" }, { purpose: "t" }), /not set up to read from your Keychain/);
  saveKeychainSettings(app.store, "local", { enabled: true, entries: [{ name: "github", service: "github.com", account: "me@example.com" }] });
  assert.equal(keychain.available(), true);
  await assert.rejects(keychain.fill("secret://keychain/bank", { purpose: "t" }), /no Keychain entry called "bank"/);
  assert.equal(calls.length, 0, "nothing is asked for an entry nobody listed");

  const filled = await keychain.fill({ header: "token secret://keychain/github", keep: 3 }, { purpose: "a test" });
  assert.deepEqual(filled, { header: "token kc-secret-5a6b", keep: 3 });
  assert.deepEqual(calls, [{ executable: "/usr/bin/security", args: ["find-generic-password", "-s", "github.com", "-a", "me@example.com", "-w"] }]);
  assert.match(app.store.secrets.scrubber.text("it was kc-secret-5a6b"), /\[secret keychain:github\]/);
  const written = app.store.audit.list("local").filter((row) => row.action === "secret.used");
  assert.ok(written.some((row) => row.subject === "secret://keychain/github" && row.outcome === "handed over"));
  assert.ok(!JSON.stringify(written).includes("kc-secret-5a6b"));
  assert.throws(() => saveKeychainSettings(app.store, "local", { entries: [{ name: "x", service: "-s evil" }] }), /cannot start with a dash/);

  const elsewhere = new KeychainSecrets(app.store, "local", app.store.secrets.scrubber, runner, "linux");
  assert.equal(elsewhere.available(), false);
  await assert.rejects(elsewhere.fill("secret://keychain/github", { purpose: "t" }), /this is not a Mac/);
});

test("the Keychain's refusals are plain sentences", () => {
  const entry = { name: "github", service: "github.com", note: "" };
  assert.deepEqual(keychainCommand(entry).args, ["find-generic-password", "-s", "github.com", "-w"]);
  assert.match(keychainRefusal(entry, { code: 44, stdout: "", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }),
    /There is no Keychain item for "github.com"/);
  assert.match(keychainRefusal(entry, { code: 51, stdout: "", stderr: "User interaction is not allowed." }), /locked, or the request/);
  assert.match(keychainRefusal(entry, { code: 1, stdout: "", stderr: "" }), /would not hand that over/);
  assert.match(keychainRefusal(entry, { code: 0, stdout: "\n", stderr: "" }), /has no password saved/);
  assert.match(keychainRefusal(entry, { code: null, stdout: "", stderr: "", missing: true }), /no Keychain command/);
  assert.equal(keychainRefusal(entry, { code: 0, stdout: "value", stderr: "" }), null);
});

test("a stand-in security program is run for real and the whole locker path works", { skip: !posix }, async (t) => {
  const app = await fixture(t);
  const root = await temp(t, "branch-posix-kc-");
  const security = await fakeProgram(root, "security",
    'if [ "$1" = find-generic-password ] && [ "$3" = "deploy host" ] && [ "$4" = -w ]; then echo "kc-deploy-77"; else echo "The specified item could not be found in the keychain." >&2; exit 44; fi');
  const keychain = new KeychainSecrets(app.store, "local", app.store.secrets.scrubber, spawnSecretCommand, "darwin", security);
  // The app registers its own Keychain source, which would ask the real Keychain: swap in the stand-in.
  const sources = app.store.secrets.sources;
  const registered = sources.findIndex((source) => source.scheme === "keychain");
  assert.ok(registered >= 0);
  sources.splice(registered, 1, keychain);
  assert.ok(!sources.some((source) => source.scheme === "keychain" && source !== keychain));
  saveKeychainSettings(app.store, "local", { enabled: true, entries: [{ name: "deploy", service: "deploy host" }, { name: "gone", service: "nothing" }] });
  await app.store.locker.set("local", "default", "API_KEY", "locker-9");
  const filled = await app.store.secrets.fill("local", "default",
    { a: "secret://keychain/deploy", b: "secret://default/API_KEY" }, { purpose: "both" });
  assert.deepEqual(filled, { a: "kc-deploy-77", b: "locker-9" });
  await assert.rejects(keychain.read("secret://keychain/gone", { purpose: "t" }), /no Keychain item for "nothing"|would not hand that over/);
});

test("the running app reads the Keychain through the same locker as every other source", async (t) => {
  const app = await fixture(t);
  assert.ok(app.store.secrets.sources.some((source) => source.scheme === "keychain"), "registered when the app starts");
  // Switched off, so a keychain reference is a plain refusal rather than a question for the locker.
  await assert.rejects(app.store.secrets.fill("local", "default", "secret://keychain/github", { purpose: "t" }),
    /not set up to read from your Keychain|this is not a Mac/);
});

/* ---------------------------------------------------------------- the permissions page */

test("a Mac's permissions page explains each switch with the link to its page, and asks the Mac nothing", async () => {
  assert.deepEqual(capabilitiesFor("darwin"), ["microphone", "camera", "screen", "accessibility"]);
  assert.deepEqual(capabilitiesFor("win32"), ["microphone", "camera", "screen"]);
  const asked = [];
  const permissions = new OsPermissions(consentReaderFor("darwin"), 1000, "darwin");
  const reader = probeReader(async () => { asked.push("probe"); return 3; }, consentReaderFor("darwin"), "darwin");
  assert.equal(await reader("screen"), "unknown");
  assert.deepEqual(asked, [], "the Mac is never probed, so no question goes up on its screen");
  const page = await permissions.all();
  assert.deepEqual(page.map((entry) => entry.capability), ["microphone", "camera", "screen", "accessibility"]);
  for (const entry of page) {
    assert.equal(entry.allowed, true, "not knowing never blocks");
    assert.equal(entry.message, "");
    assert.equal(entry.settingsLink, macSettingsLinks[entry.capability]);
    assert.match(entry.settingsLink, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
    assert.match(entry.explanation, /System Settings, Privacy & Security, /);
  }
  assert.match(page[2].explanation, /Screen & System Audio Recording/);
  assert.match(page[3].explanation, /press keys and click in other apps/);
  const refused = capabilityCheck("accessibility", "refused", "darwin");
  assert.equal(refused.allowed, false);
  assert.match(refused.message, /Your Mac is not letting Branch press keys/);
  assert.equal(capabilityCheck("microphone", "allowed", "darwin").settingsLink, "");
});

test("Linux says which desktop features depend on the session", async () => {
  assert.equal(linuxSession({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }), "wayland");
  assert.equal(linuxSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }), "x11");
  assert.equal(linuxSession({ DISPLAY: ":99" }), "x11", "Xvfb sets only DISPLAY");
  assert.equal(linuxSession({}), "none");

  const wayland = { XDG_SESSION_TYPE: "wayland" };
  assert.equal(await consentReaderFor("linux", wayland)("screen"), "refused");
  assert.equal(await consentReaderFor("linux", wayland)("microphone"), "unknown");
  const check = capabilityCheck("screen", "refused", "linux", wayland);
  assert.equal(check.allowed, false);
  assert.match(check.message, /Wayland, which does not let one program type or click/);
  assert.equal(check.settingsLink, "");
  assert.match(capabilityCheck("screen", "unknown", "linux", { DISPLAY: ":0" }).explanation, /X11.*xdotool/);
  assert.match(capabilityCheck("screen", "refused", "linux", {}).message, /no desktop session here/);
  assert.match(capabilityCheck("microphone", "unknown", "linux", {}).explanation, /no single switch for the microphone/);

  // With no session the screen is refused before anything is tried; with X11 it is probed.
  const tried = [];
  const none = probeReader(async () => { tried.push("none"); }, consentReaderFor("linux", {}), "linux");
  assert.equal(await none("screen"), "refused");
  const x11 = probeReader(async () => { tried.push("x11"); return 2; }, consentReaderFor("linux", { DISPLAY: ":0" }), "linux");
  assert.equal(await x11("screen"), "allowed");
  assert.deepEqual(tried, ["x11"]);
  const page = await new OsPermissions(consentReaderFor("linux", {}), 1000, "linux").all();
  assert.deepEqual(page.map((entry) => entry.capability), ["microphone", "camera", "screen"]);
});

// Not on Windows: there the real registry and the real window list would be asked.
test("the permissions route answers with an explanation for every switch on this computer", { skip: !posix }, async (t) => {
  const app = await fixture(t);
  const page = await app.osPermissions.all();
  assert.deepEqual(page.map((entry) => entry.capability), capabilitiesFor(process.platform));
  for (const entry of page) assert.ok(entry.explanation.length > 20, `${entry.capability} is explained`);
});

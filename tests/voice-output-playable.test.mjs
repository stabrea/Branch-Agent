import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ToolRegistry } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { VoiceService, registerVoice } from "../dist/voice-service.js";
import { saveVoiceSettings } from "../dist/voice.js";
import { readWav, writeWav } from "../dist/media-audio.js";
import { spokenDurationSeconds } from "../dist/voice-output-audio.js";

/**
 * FQ-surfaces.voice-output's remaining gap: every voice fixture so far has been a few stand-in
 * bytes with a media type attached, and nothing ever opened them. These tests build a real WAV
 * sound file — an actual sine tone, sample by sample, the same way the trimming feature's own
 * `writeWav` would — and then decode it back with the app's own `readWav`, the same reader a saved
 * recording is opened with, so a real generated audio file is genuinely played open, not counted.
 */
const openPolicy = () => new NetworkPolicy({ allowPrivateAddresses: true });

/** A short, real, playable mono WAV: a 440 Hz tone, not silence and not a stub. */
function realTone(seconds = 0.25, sampleRate = 8000) {
  const frames = Math.round(seconds * sampleRate);
  const samples = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    samples.writeInt16LE(value, i * 2);
  }
  const wav = writeWav({ channels: 1, sampleRate, bitsPerSample: 16, blockAlign: 2 }, samples);
  return { wav, samples, sampleRate, frames, seconds: frames / sampleRate };
}

test("a real generated WAV file is actually decoded, sample for sample, not just counted in bytes", () => {
  const { wav, samples, sampleRate, seconds } = realTone();
  const sound = readWav(Buffer.from(wav));
  assert.equal(sound.sampleRate, sampleRate);
  assert.equal(sound.channels, 1);
  assert.equal(sound.bitsPerSample, 16);
  assert.equal(sound.samples.length, samples.length);
  assert.equal(Buffer.compare(sound.samples, samples), 0, "the decoded samples are exactly what was written");
  assert.ok(Math.abs(sound.seconds - seconds) < 1e-9);

  // Reading the samples themselves, not trusting the header: this is a real tone, not silence.
  let peak = 0;
  for (let i = 0; i + 1 < sound.samples.length; i += 2) peak = Math.max(peak, Math.abs(sound.samples.readInt16LE(i)));
  assert.ok(peak > 10000, "the decoded samples actually carry a tone");
});

test("spokenDurationSeconds opens real spoken WAV audio, and leaves stand-in bytes alone", () => {
  const { wav, seconds } = realTone(0.5, 8000);
  assert.equal(spokenDurationSeconds(wav, "audio/wav"), Math.round(seconds * 100) / 100);
  assert.equal(spokenDurationSeconds(wav, "AUDIO/WAV"), Math.round(seconds * 100) / 100, "the media type is read without case sensitivity");
  // A squeezed format, and yesterday's stand-in bytes: neither is guessed at, both come back null.
  assert.equal(spokenDurationSeconds(new Uint8Array([0xff, 0xfb, 0x10, 0x00]), "audio/mpeg"), null);
  assert.equal(spokenDurationSeconds(Buffer.from("RIFF"), "audio/wav"), null, "bytes too short to be a real WAV file are recognised, not counted anyway");
});

test("voice.say hands back a spoken duration read from the real sound, not a placeholder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-out-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });

  const { wav, seconds } = realTone(0.4, 8000);
  const registry = new ToolRegistry();
  const voice = new VoiceService(app.store, app.runtime.models, openPolicy(), fetch, {
    platform: "win32",
    // Stand-in for PowerShell, exactly as the existing SAPI tests do it, but writing a real tone
    // instead of the four-byte "RIFF" stub — so what comes back can actually be opened.
    runProgram: async (_file, args) => {
      const folder = dirname(args[args.length - 1]);
      await writeFile(join(folder, "speech.wav"), wav);
      return "";
    },
  });
  registerVoice(registry, voice, app.store);
  // voice.spoken events carry a foreign key to a real run row, so one is created first, the same
  // way the app itself always would before a tool ever runs.
  const run = app.store.createRun(app.runtime.owner, "say something");
  const context = app.runtime.context({ runId: run.id });

  saveVoiceSettings(app.store, app.runtime.owner, { ttsRoute: "windows", systemVoice: "on" });
  const said = await registry.execute("voice.say", { text: "hello there", voice: "", speed: 1 }, context);
  assert.equal(said.route, "windows");
  assert.equal(said.mediaType, "audio/wav");
  const expected = Math.round(seconds * 100) / 100;
  assert.equal(said.seconds, expected, "the tool reports the sound's real length, decoded from the file, not null");
});

test("POST /api/voice/speak serves bytes that decode to the real audio it generated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-voice-http-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { server.close(); await app.close(); await discardTemp(root); });

  const { wav, seconds } = realTone(0.3, 8000);
  // Stand in for the provider round trip: the route under test is the HTTP handler itself, which
  // this proves actually serves real, decodable sound, not a fixture summarised by its length.
  app.voice.speak = async () => ({
    bytes: new Uint8Array(wav), mediaType: "audio/wav", route: "windows", voice: "Test Voice",
    cost: { amount: 0, currency: "USD", confidence: "free", note: "nothing was charged in this test" },
  });

  const response = await fetch(server.url + "/api/voice/speak", {
    method: "POST",
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" },
    body: JSON.stringify({ text: "hello from the route" }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  const served = Buffer.from(await response.arrayBuffer());
  const decoded = readWav(served);
  const expected = Math.round(seconds * 100) / 100;
  assert.ok(Math.abs(decoded.seconds - seconds) < 1e-9, "the served bytes decode to the real file, not a truncated or re-encoded copy");
  assert.equal(response.headers.get("x-voice-seconds"), String(expected), "the route reports the real duration it decoded from what it served");
});

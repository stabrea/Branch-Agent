/**
 * FQ-surfaces.generation: the remaining gap was that nothing actually decoded the picture and the
 * video that generation saves — `media.info` read an MP4's headers without decoding its content, and
 * the video-generation tests reached for stand-in bytes rather than a file that truly opens as a
 * movie. This file drives the real generation adapters (image and video) end to end with fakes for
 * the outside service only, then genuinely decodes what was saved: a picture's real pixel data
 * (inflated and unfiltered, not merely its header), and a video's real movie structure (`moov`,
 * `mvhd`, at least one `trak`), and shows that a file which only opens the right way and then trails
 * into unrelated bytes — what a header-only check lets through — is refused by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { crc32, deflateSync } from "node:zlib";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { OpenAIProvider } from "../dist/providers.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Budget } from "../dist/contracts.js";
import { decodeMp4, decodePng } from "../dist/media-decode.js";
import { makeVideo } from "../dist/reach/video.js";
import { saveReachMode } from "../dist/reach/settings.js";

const owner = "local";

async function scratchApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-media-decode-"));
  const provider = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
function context(app) {
  return {
    owner, workspace: app.runtime.workspace, runId: "decoderun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.read", "media.write"]), depth: 0,
  };
}
/** The media tools wired to a fake picture service rather than a real provider. */
function mediaFor(app, endpoint) {
  const media = new MediaTools(app.store, app.files, app.runtime.models, new NetworkPolicy({ allowPrivateAddresses: true }), fetch);
  media.artifacts = app.artifacts;
  app.runtime.models.register({ id: "test", name: "Test connection", provider: new OpenAIProvider({ endpoint, model: "gpt-4o", apiKey: "sk-test" }), model: "test-model" });
  app.runtime.models.configure(owner, { activePreset: "test", fallbackOrder: [], cooldownMs: 0, reasoning: null });
  return media;
}
async function fakeImageService(t, onePixel) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: onePixel.toString("base64") }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A PNG chunk: its length field counts only its data (unlike an MP4 box's, which counts itself too). */
const pngChunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
};
/** An MP4 box: its size field counts its own 8-byte header plus its data. */
const mp4Box = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};

/** A real, freshly encoded PNG: `width`x`height`, every pixel the same RGBA colour, no filtering. */
function realPng(width, height, [r, g, b, a]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per sample
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from([r, g, b, a])))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = deflateSync(raw);
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}
/** A real, structurally complete MP4: ftyp, moov with mvhd and one trak, and mdat with real bytes. */
function realMp4(seconds, sample) {
  const mvhd = Buffer.alloc(20);
  mvhd.writeUInt32BE(600, 12); // time scale: 600 ticks a second
  mvhd.writeUInt32BE(600 * seconds, 16);
  const trak = mp4Box("trak", Buffer.alloc(4));
  return Buffer.concat([
    mp4Box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.from([0, 0, 2, 0])])),
    mp4Box("moov", Buffer.concat([mp4Box("mvhd", mvhd), trak])),
    mp4Box("mdat", sample),
  ]);
}
/** What a service sending only stand-in header bytes looks like: no real movie inside. */
const headerOnlyBytes = () => Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("more video")]);

test("the picture media.image saves genuinely decodes: real pixels, not just a header", async (t) => {
  const { app } = await scratchApp(t);
  const source = realPng(3, 2, [10, 200, 30, 255]);
  const endpoint = await fakeImageService(t, source);
  const media = mediaFor(app, endpoint);
  const made = await media.image({ prompt: "a small green square", size: "512x512", save: "square.png" }, context(app));
  assert.equal(made.mediaType, "image/png");

  // Decoding the exact bytes generation saved, not the fixture kept in this test.
  const savedBytes = await readFile(join(app.runtime.workspace, made.savedAs));
  const decoded = decodePng(savedBytes);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 4);
  // Every one of the six pixels' real, unfiltered bytes, not merely the file's declared size.
  for (let i = 0; i < decoded.pixels.length; i += 4)
    assert.deepEqual([...decoded.pixels.subarray(i, i + 4)], [10, 200, 30, 255], `pixel at byte ${i} decoded wrong`);

  const info = await media.info({ path: made.savedAs });
  assert.equal(info.format, "png");
  assert.equal(info.width, 3);
  assert.equal(info.height, 2);
  assert.equal(info.decoded, true);

  assert.throws(() => decodePng(Buffer.from("not a picture at all")), /Not a PNG/);
  const corrupted = Buffer.from(source);
  corrupted[corrupted.length - 6] ^= 0xff; // flip a byte inside the last chunk's checksum
  assert.throws(() => decodePng(corrupted), /checksum does not match/);
});

test("the video makeVideo saves genuinely decodes its real movie structure, and stand-in header bytes are refused", async (t) => {
  const { app, root } = await scratchApp(t);
  saveReachMode(app.store, owner, "video", { mode: "on" });
  const sample = Buffer.from("nine real seconds of picture data, not a stand-in");
  const source = realMp4(9, sample);
  const states = ["queued", "in_progress", "completed"];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/videos")) return new Response(JSON.stringify({ id: "video_1", status: "queued" }), { headers: { "content-type": "application/json" } });
    if (u.endsWith("/content")) return new Response(source);
    return new Response(JSON.stringify({ id: "video_1", status: states.shift() }), { headers: { "content-type": "application/json" } });
  };
  const deps = { fetcher, secret: async () => "sk-test", files: app.files, sleep: async () => undefined, now: () => new Date("2026-09-23T09:00:00Z") };
  const made = await makeVideo(app.store, owner, deps, { prompt: "a nine second clip" }, AbortSignal.timeout(5000));

  const savedBytes = await readFile(join(root, "workspace", made.path));
  assert.deepEqual(savedBytes, source, "the exact bytes the service sent are what was saved");
  const decoded = decodeMp4(savedBytes);
  assert.equal(decoded.brand, "isom");
  assert.equal(decoded.tracks, 1);
  assert.equal(decoded.seconds, 9);

  // What a header-only check lets through: something that opens like an MP4 and then is not one.
  assert.throws(() => decodeMp4(headerOnlyBytes()), /No moov box/);
  assert.throws(() => decodeMp4(Buffer.from("not a video at all, just words")), /No ftyp box/);
  const noTrack = Buffer.concat([
    mp4Box("ftyp", Buffer.concat([Buffer.from("isom", "latin1"), Buffer.alloc(4)])),
    mp4Box("moov", mp4Box("mvhd", Buffer.alloc(20))),
    mp4Box("mdat", sample),
  ]);
  assert.throws(() => decodeMp4(noTrack), /carries no trak/);
});

/**
 * FQ-surfaces.generation: the remaining gap was that nothing actually decoded the picture that
 * generation saves. This file drives the real image generation adapter end to end with a fake for the
 * outside service only, then genuinely decodes what was saved: its real pixel data, inflated and
 * unfiltered, not merely its header. A small file that unpacks into far more than its own size says
 * is refused without being unpacked. A video is only read from its headers, and `media.info` makes
 * no claim to have decoded one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { crc32, createDeflate, deflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { OpenAIProvider } from "../dist/providers.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Budget } from "../dist/contracts.js";
import { decodePng } from "../dist/media-decode.js";
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
/** An MP4 laid out the usual way: ftyp, moov with mvhd and one trak, and mdat with some bytes. */
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
/** The media tools with no model behind them: enough for media.info, which calls none. */
const plainMedia = (app) => new MediaTools(app.store, app.files, app.runtime.models, new NetworkPolicy({ allowPrivateAddresses: true }), fetch);

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

test("media.info reads a saved video from its headers and makes no claim to have decoded it", async (t) => {
  const { app, root } = await scratchApp(t);
  saveReachMode(app.store, owner, "video", { mode: "on" });
  const source = realMp4(9, Buffer.from("nine seconds of picture data"));
  const states = ["queued", "in_progress", "completed"];
  const fetcher = async (url) => {
    const u = String(url);
    if (u.endsWith("/v1/videos")) return new Response(JSON.stringify({ id: "video_1", status: "queued" }), { headers: { "content-type": "application/json" } });
    if (u.endsWith("/content")) return new Response(source);
    return new Response(JSON.stringify({ id: "video_1", status: states.shift() }), { headers: { "content-type": "application/json" } });
  };
  const deps = { fetcher, secret: async () => "sk-test", files: app.files, sleep: async () => undefined, now: () => new Date("2026-09-23T09:00:00Z") };
  const made = await makeVideo(app.store, owner, deps, { prompt: "a nine second clip" }, AbortSignal.timeout(5000));
  assert.deepEqual(await readFile(join(root, "workspace", made.path)), source, "the exact bytes the service sent are what was saved");

  const info = await plainMedia(app).info({ path: made.path });
  assert.equal(info.format, "mp4");
  assert.equal(info.seconds, 9);
  assert.equal(info.tracks, 1);
  assert.ok(!("decoded" in info), `an MP4 is not decoded here, yet media.info said ${JSON.stringify(info)}`);
  assert.match(info.note, /^Read from the file's own headers\./, "the note says it was read from headers, not decoded");
  const described = app.registry.descriptions(new Set(app.registry.permissions())).find((tool) => tool.name === "media.info");
  assert.ok(described, "media.info is registered");
  assert.doesNotMatch(described.description, /movie structure|genuinely decoded/i);
});

/** Paeth's predictor, written out again here so the fixture does not borrow the decoder's own. */
function paethOf(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** An RGB PNG whose every row uses filter 4 (Paeth), over a gradient steep enough that it picks `b`. */
function paethPng(width, height) {
  const channels = 3;
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let ch = 0; ch < channels; ch++)
    pixels[y * stride + x * channels + ch] = (x * 3 + y * 50 + ch * 7) & 0xff;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride + 1);
    row[0] = 4;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const a = i >= channels ? pixels[at - channels] : 0;
      const b = y > 0 ? pixels[at - stride] : 0;
      const c = y > 0 && i >= channels ? pixels[at - stride - channels] : 0;
      row[i + 1] = (pixels[at] - paethOf(a, b, c)) & 0xff;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0))]);
  return { png, pixels };
}
test("a Paeth-filtered PNG decodes back to its exact pixels, and media.info says it was decoded", async (t) => {
  const { app } = await scratchApp(t);
  const { png, pixels } = paethPng(5, 4);
  assert.deepEqual([...decodePng(png).pixels], [...pixels]);
  await writeFile(join(app.runtime.workspace, "gradient.png"), png);
  const info = await plainMedia(app).info({ path: "gradient.png" });
  assert.equal(info.format, "png");
  assert.equal(info.width, 5);
  assert.equal(info.height, 4);
  assert.equal(info.channels, 3);
  assert.equal(info.decoded, true);
});

test("media.info on a PNG with a broken checksum gives the picture's own reason", async (t) => {
  const { app } = await scratchApp(t);
  const broken = realPng(2, 2, [1, 2, 3, 255]);
  broken[broken.length - 6] ^= 0xff; // a byte inside the last chunk's checksum
  await writeFile(join(app.runtime.workspace, "broken.png"), broken);
  await assert.rejects(plainMedia(app).info({ path: "broken.png" }), (error) => {
    assert.match(error.message, /checksum does not match/);
    assert.doesNotMatch(error.message, /Only MP4 video and WAV/);
    return true;
  });
});

/** Zeros deflated a megabyte at a time, so the test itself never holds them all at once. */
async function deflatedZeros(megabytes) {
  const deflate = createDeflate({ level: 9 });
  const out = [];
  deflate.on("data", (chunk) => out.push(chunk));
  const done = new Promise((resolve, reject) => { deflate.on("end", resolve); deflate.on("error", reject); });
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < megabytes; i++) if (!deflate.write(zeros)) await new Promise((resolve) => deflate.once("drain", resolve));
  deflate.end();
  await done;
  return Buffer.concat(out);
}
test("a tiny PNG whose pixel data unpacks into 128 MB is refused quickly, without unpacking it", async () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; // one 8-bit RGBA pixel: five bytes once unpacked
  const bomb = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", await deflatedZeros(128)), pngChunk("IEND", Buffer.alloc(0))]);
  assert.ok(bomb.length < 256 * 1024, `the file itself is small (${bomb.length} bytes)`);
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  assert.throws(() => decodePng(bomb), /unpacks to more than the 5 bytes its own size says/);
  const took = performance.now() - started;
  const grew = process.memoryUsage().rss - rssBefore;
  assert.ok(took < 1000, `refusing it took ${Math.round(took)} ms`);
  assert.ok(grew < 48 * 1024 * 1024, `refusing it grew memory by ${Math.round(grew / 1e6)} MB`);

  const huge = Buffer.from(ihdr);
  huge.writeUInt32BE(100000, 0);
  huge.writeUInt32BE(100000, 4);
  const giant = Buffer.concat([signature, pngChunk("IHDR", huge), pngChunk("IDAT", deflateSync(Buffer.alloc(8))), pngChunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(giant), /claims to be 100000x100000/);
});

test("a tiny PNG with IHDR claiming 16384x4097 RGBA is refused by name before inflating, as it exceeds the ~64 MB unpacked-size cap", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16384, 0);
  ihdr.writeUInt32BE(4097, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // not interlaced
  const unpackedSize = (16384 * 4 + 1) * 4097; // stride * height, with 1 byte filter per row
  assert.ok(unpackedSize > 4096 * 4096 * 4 + 4096, "PNG exceeds max unpacked size");
  // Use a minimal valid zlib stream (empty data)
  const minimalZlib = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const png = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", minimalZlib), pngChunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(png), /would unpack to.*more than the.*decoded here/);
});

test("a tiny Adam7-interlaced PNG with valid structure is refused by name", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 1; // interlaced (Adam7)
  // Create a minimal valid zlib stream
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([255, 0, 0, 255])))]);
  const raw = Buffer.concat(Array.from({ length: 8 }, () => row));
  const idat = deflateSync(raw);
  const png = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
  assert.throws(() => decodePng(png), /interlaced PNG is not supported/);
});

test("the unpacked-size cap sits exactly at a 4096x4096 RGBA picture: one column more is refused by name before inflating", () => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const claiming = (width, height) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, not interlaced
    return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.alloc(0))), pngChunk("IEND", Buffer.alloc(0))]);
  };
  // (4096 * 4 + 1) * 4096 = 67112960 bytes is the most decoded here, so a 4096x4096 claim gets past the cap and fails
  // only on its empty pixel data...
  assert.throws(() => decodePng(claiming(4096, 4096)), /decompressed picture is 0 bytes, not the 67112960 its own size says/);
  // ...while one column more, (4097 * 4 + 1) * 4096 = 67129344 bytes, is refused by the cap itself. Raising, lowering
  // or removing the cap changes one of these two messages.
  assert.throws(() => decodePng(claiming(4097, 4096)), /would unpack to 67129344 bytes, more than the 67112960 decoded here/);
});

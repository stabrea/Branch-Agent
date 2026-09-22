import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { MediaTools } from "../dist/media.js";
import { mediaInfo } from "../dist/media-video.js";
import { makeVideo, saveVideoSettings } from "../dist/reach/video.js";
import { saveReachMode } from "../dist/reach/settings.js";
import { OpenAIProvider } from "../dist/providers.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Budget } from "../dist/contracts.js";

/**
 * surfaces.generation: a picture and a video that were made are real files, and this test opens both.
 *
 * The row stayed partial for a plain reason: the picture fixture was a single pixel nobody ever
 * decoded, and the video fixture was twenty-six bytes beginning with "ftypisom" — enough to look like
 * an MP4 to a check that only reads the first box. Neither proved a person could open what Branch
 * saved.
 *
 * Here the stand-in services answer with files this test builds properly: a four-by-three PNG, really
 * compressed, and an MP4 with a movie header, a video track and its sample table. The test then opens
 * what Branch saved: the PNG is uncompressed back to its exact pixels, and the video is walked box by
 * box, down to the chunk offset pointing at the first sample inside `mdat`. Branch's own reader is
 * asked as well, so the file is readable by the app and not only by this test.
 *
 * Nothing leaves this computer: both services are little local HTTP servers.
 */

const owner = "local";

/* ---------- a real PNG, made here ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Eight-bit colour, three bytes a pixel, every row written plainly (filter 0). */
function realPng(width, height, colourAt) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // the leading 0 is "this row is stored as it is"
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colourAt(x, y);
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
/** Opens a PNG: the chunks with their check numbers, then the pixels themselves. */
function openPng(file) {
  const bytes = Buffer.from(file);
  assert.ok(bytes.subarray(0, 8).equals(PNG_MAGIC), "it begins the way a PNG begins");
  let at = 8, header = null, pressed = [];
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString("ascii");
    const data = bytes.subarray(at + 8, at + 8 + size);
    assert.equal(bytes.readUInt32BE(at + 8 + size), crc32(bytes.subarray(at + 4, at + 8 + size)),
      `the ${type} part's check number is right`);
    if (type === "IHDR") header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      depth: data[8], colour: data[9], interlace: data[12] };
    if (type === "IDAT") pressed.push(data);
    at += 12 + size;
  }
  assert.ok(header, "it says how big it is");
  assert.equal(header.depth, 8); assert.equal(header.colour, 2); assert.equal(header.interlace, 0);
  const flat = inflateSync(Buffer.concat(pressed));
  const stride = 1 + header.width * 3;
  assert.equal(flat.length, stride * header.height, "every row is there once uncompressed");
  const pixel = (x, y) => {
    assert.equal(flat[y * stride], 0, "the row is stored as it is");
    const at = y * stride + 1 + x * 3;
    return [flat[at], flat[at + 1], flat[at + 2]];
  };
  return { ...header, pixel };
}

/* ---------- a real MP4, made here ---------- */

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, body]);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);
const TIMESCALE = 1000, SAMPLES = 4, SAMPLE_BYTES = 256, WIDTH = 640, HEIGHT = 480;
const DURATION = TIMESCALE * SAMPLES; // one sample a second

function sampleTable(chunkOffset) {
  const avc1 = box("avc1", Buffer.alloc(6), u16(1), u16(0), u16(0), Buffer.alloc(12),
    u16(WIDTH), u16(HEIGHT), u32(0x00480000), u32(0x00480000), u32(0), u16(1), Buffer.alloc(32), u16(0x0018), Buffer.from([0xff, 0xff]));
  return box("stbl",
    box("stsd", u32(0), u32(1), avc1),
    box("stts", u32(0), u32(1), u32(SAMPLES), u32(TIMESCALE)),
    box("stsc", u32(0), u32(1), u32(1), u32(SAMPLES), u32(1)),
    box("stsz", u32(0), u32(SAMPLE_BYTES), u32(SAMPLES)),
    box("stco", u32(0), u32(1), u32(chunkOffset)));
}
function movie(chunkOffset) {
  const mvhd = box("mvhd", u32(0), u32(0), u32(0), u32(TIMESCALE), u32(DURATION),
    u32(0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  const tkhd = box("tkhd", Buffer.from([0, 0, 0, 7]), u32(0), u32(0), u32(1), u32(0), u32(DURATION),
    Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(WIDTH << 16), u32(HEIGHT << 16));
  const mdia = box("mdia",
    box("mdhd", u32(0), u32(0), u32(0), u32(TIMESCALE), u32(DURATION), u16(0x55c4), u16(0)),
    box("hdlr", u32(0), u32(0), Buffer.from("vide", "ascii"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "ascii")),
    box("minf",
      box("vmhd", Buffer.from([0, 0, 0, 1]), u16(0), Buffer.alloc(6)),
      box("dinf", box("dref", u32(0), u32(1), box("url ", Buffer.from([0, 0, 0, 1])))),
      sampleTable(chunkOffset)));
  return box("moov", mvhd, box("trak", tkhd, mdia));
}
/** ftyp, then the movie, then the sound and picture data the sample table points into. */
function realMp4() {
  const ftyp = box("ftyp", Buffer.from("isom", "ascii"), u32(0x200),
    Buffer.from("isomiso2avc1mp41", "ascii"));
  const media = Buffer.alloc(SAMPLES * SAMPLE_BYTES);
  for (let i = 0; i < media.length; i++) media[i] = (i * 7) % 251;
  // The chunk offset is where the samples really are, so it can only be written once the sizes are known.
  const offset = ftyp.length + movie(0).length + 8;
  return { file: Buffer.concat([ftyp, movie(offset), box("mdat", media)]), media, offset };
}
/** Walks an MP4 the way a player does: every box by name, and the boxes inside it. */
function walk(bytes, limit = 64) {
  const found = [];
  let at = 0;
  while (at + 8 <= bytes.length && found.length < limit) {
    const size = bytes.readUInt32BE(at), type = bytes.subarray(at + 4, at + 8).toString("ascii");
    assert.ok(size >= 8 && at + size <= bytes.length, `the ${type} box says a size that fits`);
    found.push({ type, at, size, body: bytes.subarray(at + 8, at + size) });
    at += size;
  }
  return found;
}
const find = (boxes, type) => boxes.find((one) => one.type === type);
function openMp4(file) {
  const bytes = Buffer.from(file);
  const top = walk(bytes);
  const ftyp = find(top, "ftyp"), moov = find(top, "moov"), mdat = find(top, "mdat");
  assert.ok(ftyp && moov && mdat, "it has its kind, its movie and its data");
  const inMoov = walk(moov.body);
  const mvhd = find(inMoov, "mvhd").body;
  const trak = find(inMoov, "trak");
  const mdia = walk(walk(trak.body).find((one) => one.type === "mdia").body);
  const handler = find(mdia, "hdlr").body.subarray(8, 12).toString("ascii");
  const stbl = walk(walk(find(mdia, "minf").body).find((one) => one.type === "stbl").body);
  const entry = walk(find(stbl, "stsd").body.subarray(8))[0];
  const stsz = find(stbl, "stsz").body, stco = find(stbl, "stco").body;
  return {
    brand: ftyp.body.subarray(0, 4).toString("ascii"),
    timescale: mvhd.readUInt32BE(12), duration: mvhd.readUInt32BE(16),
    seconds: mvhd.readUInt32BE(16) / mvhd.readUInt32BE(12),
    tracks: inMoov.filter((one) => one.type === "trak").length,
    handler, codec: entry.type, width: entry.body.readUInt16BE(24), height: entry.body.readUInt16BE(26),
    sampleBytes: stsz.readUInt32BE(4), samples: stsz.readUInt32BE(8),
    chunkOffset: stco.readUInt32BE(8), mdatAt: mdat.at + 8, mdat: mdat.body,
  };
}

/* ---------- the two services, and Branch ---------- */

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-generation-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}
async function pictureService(t, png) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("a picture that was made is a real picture, opened down to its pixels", async (t) => {
  const { app, workspace } = await fixture(t);
  // Four by three, a red corner and a green stripe, so the pixels can be told apart.
  const sent = realPng(4, 3, (x, y) => (y === 1 ? [0, 200, 0] : x === 0 ? [200, 0, 0] : [10, 20, 30]));
  const endpoint = await pictureService(t, sent);
  const media = new MediaTools(app.store, app.files, app.runtime.models,
    new NetworkPolicy({ allowPrivateAddresses: true }), fetch);
  media.artifacts = app.artifacts;
  app.runtime.models.register({ id: "test", name: "Test connection",
    provider: new OpenAIProvider({ endpoint, model: "gpt-4o", apiKey: "sk-test" }), model: "test-model" });
  app.runtime.models.configure(owner, { activePreset: "test", fallbackOrder: [], cooldownMs: 0, reasoning: null });

  const made = await media.image({ prompt: "an oak tree", size: "512x512", save: "tree.png" }, {
    owner, workspace: app.runtime.workspace, runId: "genrun", signal: AbortSignal.timeout(20000),
    budget: new Budget(), permissions: new Set(["media.read", "media.write"]), depth: 0,
  });

  assert.equal(made.mediaType, "image/png");
  for (const file of [made.path, join(workspace, "media", "tree.png")]) {
    const picture = openPng(await readFile(file));
    assert.equal(picture.width, 4, `${file} is four pixels across`);
    assert.equal(picture.height, 3);
    assert.deepEqual(picture.pixel(0, 0), [200, 0, 0], "the red corner survived");
    assert.deepEqual(picture.pixel(2, 1), [0, 200, 0], "and the green stripe");
    assert.deepEqual(picture.pixel(3, 2), [10, 20, 30]);
  }
});

test("a video that was made is a real film: its movie header, its track and its samples", async (t) => {
  const { app, root } = await fixture(t);
  const { file, media, offset } = realMp4();
  saveReachMode(app.store, owner, "video", { mode: "on" });
  const states = ["queued", "in_progress", "completed"];
  const deps = {
    fetcher: async (url) => {
      if (String(url).endsWith("/v1/videos")) return Response.json({ id: "video_1", status: "queued" });
      if (String(url).endsWith("/content")) return new Response(file);
      return Response.json({ id: "video_1", status: states.shift() });
    },
    secret: async () => "sk-test-123", files: app.files, sleep: async () => undefined,
    now: () => new Date("2026-09-22T10:00:00Z"),
  };
  const made = await makeVideo(app.store, owner, deps, { prompt: "an oak in the wind", seconds: 4 }, AbortSignal.timeout(20000));
  const saved = await readFile(join(root, "workspace", made.path));

  const film = openMp4(saved);
  assert.equal(film.brand, "isom", "a plain MP4 every player knows");
  assert.equal(film.timescale, TIMESCALE);
  assert.equal(film.seconds, SAMPLES, "four seconds, as its own movie header says");
  assert.equal(film.tracks, 1);
  assert.equal(film.handler, "vide", "and the track really holds pictures");
  assert.equal(film.codec, "avc1");
  assert.equal(film.width, WIDTH);
  assert.equal(film.height, HEIGHT);
  assert.equal(film.samples, SAMPLES);
  assert.equal(film.sampleBytes * film.samples, film.mdat.length, "the sample table adds up to the data");
  assert.equal(film.chunkOffset, offset, "the table points at where the samples are");
  assert.equal(film.chunkOffset, film.mdatAt, "which is the start of the data itself");
  assert.ok(saved.subarray(film.chunkOffset, film.chunkOffset + 8).equals(media.subarray(0, 8)),
    "and the first sample really is there");
});

test("Branch's own reader opens the saved video, and says what it is", async (t) => {
  const { app, root } = await fixture(t);
  const { file } = realMp4();
  saveReachMode(app.store, owner, "video", { mode: "on" });
  saveVideoSettings(app.store, owner, { service: "openai" });
  const states = ["completed"];
  const deps = {
    fetcher: async (url) => {
      if (String(url).endsWith("/v1/videos")) return Response.json({ id: "video_2", status: "queued" });
      if (String(url).endsWith("/content")) return new Response(file);
      return Response.json({ id: "video_2", status: states.shift() ?? "completed" });
    },
    secret: async () => "sk-test-123", files: app.files, sleep: async () => undefined,
    now: () => new Date("2026-09-22T11:00:00Z"),
  };
  const made = await makeVideo(app.store, owner, deps, { prompt: "an oak at dusk", seconds: 4 }, AbortSignal.timeout(20000));

  const read = mediaInfo(await readFile(join(root, "workspace", made.path)));
  assert.equal(read.format, "mp4");
  assert.equal(read.brand, "isom");
  assert.equal(read.seconds, SAMPLES, "the length Branch shows is the film's own");
  assert.equal(read.tracks, 1, "and it found the track");
});

test("the stand-in bytes the old fixtures used would not open", () => {
  const pretend = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom"), Buffer.alloc(4), Buffer.from("more video")]);
  // It falls over on the first box, which is as far as anything reading it honestly gets.
  assert.throws(() => openMp4(pretend), /says a size that fits|its kind, its movie and its data/);
  const info = mediaInfo(pretend);
  assert.equal(info.seconds, null, "Branch cannot say how long it is");
  assert.equal(info.tracks, 0, "because there is no track in it");
});

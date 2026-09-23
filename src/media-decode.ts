import { crc32, inflateSync } from "node:zlib";
import { mp4Boxes } from "./media-video.js";

/**
 * FQ-surfaces.generation: proving a saved picture or video is really the thing it claims to be, not
 * only that it starts with the right bytes. `media.info` (src/media.ts) already read an MP4 or a
 * WAV file's own headers without decoding any content; this file adds a real decode on top of that
 * for both a saved picture and a saved video, using nothing beyond what Node already ships.
 */

const channelsFor: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels: number;
  /** The fully unfiltered pixel bytes, row after row, `channels` samples per pixel. */
  pixels: Buffer;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/**
 * A real PNG decode: every chunk's checksum is checked, the compressed pixel stream is inflated
 * (with Node's own zlib, the same bytes a real viewer would inflate), and every scanline is
 * unfiltered back to plain samples. Only the common 8-bit-per-sample case is decoded; anything else
 * is refused by name rather than guessed at.
 */
export function decodePng(file: Buffer): DecodedPng {
  if (file.length < 8 || !file.subarray(0, 8).equals(pngSignature)) throw new Error("Not a PNG picture: its first eight bytes are wrong.");
  let at = 8;
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  const idat: Buffer[] = [];
  while (at + 12 <= file.length) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const start = at + 8;
    if (length < 0 || start + length + 4 > file.length) throw new Error(`The ${type || "next"} chunk runs past the end of the file.`);
    const body = file.subarray(start, start + length);
    const storedCrc = file.readUInt32BE(start + length);
    if ((crc32(file.subarray(at + 4, start + length)) >>> 0) !== (storedCrc >>> 0)) throw new Error(`The ${type} chunk's checksum does not match its bytes.`);
    if (type === "IHDR") {
      if (body.length < 13) throw new Error("IHDR is too short to say the picture's size.");
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body.readUInt8(8), colorType: body.readUInt8(9) };
      if (ihdr.width <= 0 || ihdr.height <= 0) throw new Error("IHDR claims a picture with no width or height.");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") { at = start + length + 4; break; }
    at = start + length + 4;
  }
  if (!ihdr) throw new Error("No IHDR chunk: this is not a real PNG.");
  if (!idat.length) throw new Error("No pixel data (IDAT) in this PNG.");
  if (ihdr.bitDepth !== 8) throw new Error(`Only 8-bit PNGs are decoded here, not ${ihdr.bitDepth}-bit.`);
  const channels = channelsFor[ihdr.colorType];
  if (!channels) throw new Error(`Unknown PNG colour type ${ihdr.colorType}.`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * channels;
  const expected = (stride + 1) * ihdr.height;
  if (raw.length !== expected) throw new Error(`The decompressed picture is ${raw.length} bytes, not the ${expected} its own size says it should be.`);
  const pixels = Buffer.alloc(stride * ihdr.height);
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < ihdr.height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = pixels.subarray(y * stride, y * stride + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prevRow[x]!;
      const c = x >= channels ? prevRow[x - channels]! : 0;
      const sample = row[x]!;
      let value: number;
      if (filter === 0) value = sample;
      else if (filter === 1) value = sample + a;
      else if (filter === 2) value = sample + b;
      else if (filter === 3) value = sample + Math.floor((a + b) / 2);
      else if (filter === 4) value = sample + paeth(a, b, c);
      else throw new Error(`Unknown PNG filter type ${filter} on row ${y}.`);
      out[x] = value & 0xff;
    }
    prevRow = out;
  }
  return { width: ihdr.width, height: ihdr.height, bitDepth: ihdr.bitDepth, colorType: ihdr.colorType, channels, pixels };
}

export interface DecodedMp4 {
  brand: string;
  tracks: number;
  seconds: number | null;
}
function movieDuration(mvhd: Buffer): number | null {
  if (mvhd.length < 4) return null;
  const version = mvhd.readUInt8(0);
  if (version === 1) {
    if (mvhd.length < 32) return null;
    const scale = mvhd.readUInt32BE(20), duration = Number(mvhd.readBigUInt64BE(24));
    return scale ? duration / scale : null;
  }
  if (mvhd.length < 20) return null;
  const scale = mvhd.readUInt32BE(12), duration = mvhd.readUInt32BE(16);
  return scale ? duration / scale : null;
}
/**
 * A real MP4 structural decode: not only the four-letter type the file opens with, but a walk down
 * into `moov` for a genuine movie header and at least one real track, and a check that `mdat` really
 * carries media bytes. A file that opens the right way and then trails off into unrelated bytes —
 * what a plain header check lets through — is refused here by name.
 */
export function decodeMp4(file: Buffer): DecodedMp4 {
  const top = mp4Boxes(file);
  const ftyp = top.find((b) => b.type === "ftyp");
  if (!ftyp || ftyp.body.length < 4) throw new Error("No ftyp box: this does not open the way an MP4 does.");
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("No moov box: this MP4 carries no movie structure to decode.");
  const mdat = top.find((b) => b.type === "mdat");
  if (!mdat || mdat.body.length === 0) throw new Error("No mdat box carrying any media bytes.");
  const inside = mp4Boxes(moov.body);
  const mvhd = inside.find((b) => b.type === "mvhd");
  if (!mvhd) throw new Error("moov carries no mvhd: no real movie header to decode.");
  const tracks = inside.filter((b) => b.type === "trak");
  if (!tracks.length) throw new Error("moov carries no trak: no real track to decode.");
  const seconds = movieDuration(mvhd.body);
  return { brand: ftyp.body.toString("latin1", 0, 4), tracks: tracks.length, seconds: seconds === null ? null : Number(seconds.toFixed(3)) };
}

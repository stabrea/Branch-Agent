import { crc32, inflateSync } from "node:zlib";

/**
 * FQ-surfaces.generation: proving a saved picture is really a picture, not only that it starts with
 * the right bytes. `media.info` (src/media.ts) reads an MP4 or a WAV file's own headers; this file
 * adds a real PNG decode on top of that, using nothing beyond what Node already ships. Video is not
 * decoded here.
 */

const channelsFor: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** The widest or tallest picture decoded here: well past anything a picture service returns. */
const maximumSide = 16384;
/** The most unfiltered pixel bytes one picture may inflate to (a 4096x4096 RGBA picture). */
const maximumPixelBytes = 4096 * 4096 * 4 + 4096;

export interface DecodedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels: number;
  /** The fully unfiltered pixel bytes, row after row, `channels` samples per pixel. */
  pixels: Buffer;
}
/** Inflate at most `limit` bytes: a small file that unpacks into far more is refused, not unpacked. */
function inflateBounded(data: Buffer, limit: number): Buffer {
  try {
    return inflateSync(data, { maxOutputLength: limit });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      throw new Error(`The picture's compressed pixel data unpacks to more than the ${limit} bytes its own size says it should be.`);
    throw error;
  }
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
  let ihdr: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
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
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body.readUInt8(8), colorType: body.readUInt8(9), interlace: body.readUInt8(12) };
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
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG is not supported");
  if (ihdr.width > maximumSide || ihdr.height > maximumSide)
    throw new Error(`This picture claims to be ${ihdr.width}x${ihdr.height}; pictures over ${maximumSide} on a side are not decoded here.`);
  const stride = ihdr.width * channels;
  const expected = (stride + 1) * ihdr.height;
  if (expected > maximumPixelBytes)
    throw new Error(`This picture would unpack to ${expected} bytes, more than the ${maximumPixelBytes} decoded here.`);
  const raw = inflateBounded(Buffer.concat(idat), expected);
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

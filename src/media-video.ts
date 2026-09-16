import { readWav } from "./media-audio.js";

/**
 * What this app can honestly say about a video. There is no video generation, and no way to pull
 * still frames out of an MP4 with what Node brings on its own — that needs a decoder this app does
 * not ship. So the assistant is given the facts written in the file's own headers instead, which
 * is enough to reason about length and shape, and told plainly where the limit is.
 */
export const videoLimits =
  "This app does not make videos and cannot pull still frames out of one; that needs a video decoder it does not ship. It can read a video's length and tracks from the file's own headers.";

export interface MediaInfo {
  format: "mp4" | "wav";
  bytes: number;
  /** How long the recording runs, or null when the file does not say. */
  seconds: number | null;
  /** The four-letter kind written at the head of an MP4, for example "isom" or "mp42". */
  brand?: string;
  /** How many separate tracks (picture, sound, subtitles) the file carries. */
  tracks?: number;
  channels?: number;
  sampleRate?: number;
  note: string;
}
const fourcc = (buffer: Buffer, at: number): string => buffer.toString("latin1", at, at + 4);
interface Box {
  type: string;
  body: Buffer;
}
/** Walks the boxes an MP4 is built from at one level, stopping at anything that does not add up. */
export function mp4Boxes(buffer: Buffer, limit = 200): Box[] {
  const boxes: Box[] = [];
  let at = 0;
  while (at + 8 <= buffer.length && boxes.length < limit) {
    let size = buffer.readUInt32BE(at);
    const type = fourcc(buffer, at + 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = buffer.length - at;
    if (size < header || at + size > buffer.length) break;
    boxes.push({ type, body: buffer.subarray(at + header, at + size) });
    at += size;
  }
  return boxes;
}
/** Length and time scale out of an MP4's movie header, whichever of its two shapes it uses. */
function movieHeader(mvhd: Buffer): { seconds: number | null } {
  if (mvhd.length < 4) return { seconds: null };
  const version = mvhd.readUInt8(0);
  if (version === 1) {
    if (mvhd.length < 32) return { seconds: null };
    const scale = mvhd.readUInt32BE(20), duration = Number(mvhd.readBigUInt64BE(24));
    return { seconds: scale ? duration / scale : null };
  }
  if (mvhd.length < 20) return { seconds: null };
  const scale = mvhd.readUInt32BE(12), duration = mvhd.readUInt32BE(16);
  return { seconds: scale ? duration / scale : null };
}
/** True when the bytes begin the way an MP4 or a QuickTime file does. */
export const looksLikeMp4 = (file: Buffer): boolean =>
  file.length > 12 && ["ftyp", "moov", "mdat", "free", "skip"].includes(fourcc(file, 4));

/** Everything the headers of an MP4 or a WAV file will say, with no decoding of the content. */
export function mediaInfo(file: Buffer): MediaInfo {
  if (file.length > 8 && fourcc(file, 0) === "RIFF" && fourcc(file, 8) === "WAVE") {
    const sound = readWav(file);
    return {
      format: "wav", bytes: file.length, seconds: Number(sound.seconds.toFixed(3)),
      channels: sound.channels, sampleRate: sound.sampleRate,
      note: "Read from the WAV file's own header.",
    };
  }
  if (!looksLikeMp4(file))
    throw new Error("Only MP4 video and WAV sound files can be read here. " + videoLimits);
  const top = mp4Boxes(file);
  const brand = top.find((box) => box.type === "ftyp");
  const moov = top.find((box) => box.type === "moov");
  const inside = moov ? mp4Boxes(moov.body) : [];
  const mvhd = inside.find((box) => box.type === "mvhd");
  return {
    format: "mp4",
    bytes: file.length,
    seconds: mvhd ? Number((movieHeader(mvhd.body).seconds ?? 0).toFixed(3)) || null : null,
    ...(brand && brand.body.length >= 4 ? { brand: fourcc(brand.body, 0) } : {}),
    tracks: inside.filter((box) => box.type === "trak").length,
    note: `Read from the file's own headers. ${videoLimits}`,
  };
}

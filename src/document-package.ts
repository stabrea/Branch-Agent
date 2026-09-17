import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Word, spreadsheet and slide files are folders of XML inside a zip, so writing one is the same job
 * as reading one turned around. Node already ships everything needed — deflate and a checksum — so
 * there is no new dependency here, only the container format written out by hand.
 *
 * The second half of this file exists for editing. When the assistant changes one sentence in a
 * document somebody else wrote, every other part of that document must come back exactly as it went
 * in: the same bytes, not a re-squeezed copy that happens to say the same thing. So an edit reads
 * each part's *packed* bytes and copies them straight across, and only the parts it actually
 * touched are unpacked, changed and packed again.
 */
export interface PackEntry {
  name: string;
  /** What the part says. Text is written as UTF-8. */
  body: Buffer | string;
}
/** One part of a container as it lies on disk: still packed, with the numbers that describe it. */
export interface RawEntry {
  name: string;
  /** 0 when the part is stored as-is, 8 when it is deflated. */
  method: number;
  crc: number;
  packed: Buffer;
  size: number;
}
/** How many parts one container may hold, and how large the whole of it may be. */
export const packEntryLimit = 2000;
export const packBytesLimit = 64 * 1024 * 1024;

const asBuffer = (body: Buffer | string): Buffer => (typeof body === "string" ? Buffer.from(body, "utf8") : body);

/**
 * A zip container built from parts, deflating each one. The parts are written in the order given,
 * which for an Office file matters: `[Content_Types].xml` comes first because that is where every
 * reader looks to find out what the rest of the parts are.
 */
export function packZip(entries: PackEntry[]): Buffer {
  return packRaw(entries.map((entry) => {
    const raw = asBuffer(entry.body);
    return { name: entry.name, method: 8, crc: crc32(raw), packed: deflateRawSync(raw), size: raw.length };
  }));
}

/** The same container, from parts that are already packed. This is what keeps an edit byte-for-byte. */
export function packRaw(entries: RawEntry[]): Buffer {
  if (entries.length > packEntryLimit) throw new Error("That document has more parts than can be written at once");
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    locals.push(localHeader(entry, name.length), name, entry.packed);
    central.push(centralHeader(entry, name.length, offset), name);
    offset += 30 + name.length + entry.packed.length;
    if (offset > packBytesLimit) throw new Error("That document would be larger than can be written at once");
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function localHeader(entry: RawEntry, nameLength: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(entry.method, 8);
  header.writeUInt32LE(entry.crc >>> 0, 14); header.writeUInt32LE(entry.packed.length, 18);
  header.writeUInt32LE(entry.size, 22); header.writeUInt16LE(nameLength, 26);
  return header;
}
function centralHeader(entry: RawEntry, nameLength: number, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.method, 10); header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.packed.length, 20); header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(nameLength, 28); header.writeUInt32LE(offset, 42);
  return header;
}

/**
 * Every part of a container, still packed, in the order the container lists them. Nothing is
 * unpacked here, so a document built to unpack into gigabytes costs nothing to walk; a part is only
 * unpacked when a caller asks for its text.
 */
export function unpackRaw(bytes: Buffer): RawEntry[] {
  let pos = endOfDirectory(bytes);
  const entries: RawEntry[] = [];
  while (pos + 46 <= bytes.length && bytes.readUInt32LE(pos) === 0x02014b50 && entries.length < packEntryLimit) {
    const nameLength = bytes.readUInt16LE(pos + 28);
    const name = bytes.toString("utf8", pos + 46, pos + 46 + nameLength);
    entries.push({
      name, method: bytes.readUInt16LE(pos + 10), crc: bytes.readUInt32LE(pos + 16),
      size: bytes.readUInt32LE(pos + 24), packed: packedBody(bytes, bytes.readUInt32LE(pos + 42), bytes.readUInt32LE(pos + 20)),
    });
    pos += 46 + nameLength + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
  }
  if (!entries.length) throw new Error("That file is not a Word, spreadsheet or slide document this build can change");
  return entries;
}
function endOfDirectory(bytes: Buffer): number {
  for (let pos = bytes.length - 22; pos >= 0; pos--)
    if (bytes.readUInt32LE(pos) === 0x06054b50) return bytes.readUInt32LE(pos + 16);
  throw new Error("That file is not a Word, spreadsheet or slide document this build can change");
}
function packedBody(bytes: Buffer, header: number, packedSize: number): Buffer {
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== 0x04034b50) throw new Error("Damaged document part");
  const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
  return Buffer.from(bytes.subarray(start, start + packedSize));
}

/** What one part says, unpacked only when asked for. */
export function entryText(entry: RawEntry): string {
  if (entry.method === 0) return entry.packed.toString("utf8");
  if (entry.method !== 8) throw new Error("That document is packed in a way this build cannot change");
  return inflateRawSync(entry.packed, { maxOutputLength: packBytesLimit }).toString("utf8");
}
/** One part replaced with new words; every other part of the container is left exactly as it was. */
export function replaceEntry(entries: RawEntry[], name: string, text: string): RawEntry[] {
  const raw = Buffer.from(text, "utf8");
  const next: RawEntry = { name, method: 8, crc: crc32(raw), packed: deflateRawSync(raw), size: raw.length };
  return entries.some((entry) => entry.name === name)
    ? entries.map((entry) => (entry.name === name ? next : entry))
    : [...entries, next];
}

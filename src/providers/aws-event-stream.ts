/**
 * Amazon does not stream in the text format every other service uses; it sends a chain of binary
 * frames, each with its own length and checksums. This reads those frames back. Nothing here talks
 * to the network: it takes bytes and gives back the small JSON messages inside them.
 */
export interface AwsEvent {
  /** The kind of message, from the frame's `:event-type` label, for example "contentBlockDelta". */
  type: string;
  payload: unknown;
}

const table = (() => {
  const values = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[n] = c;
  }
  return values;
})();
/** The ordinary CRC-32 checksum Amazon puts on every frame. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The headers of one frame: a name, a type marker, and a value. Only text values are read. */
function readHeaders(bytes: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const nameLength = bytes.readUInt8(at);
    at += 1;
    const name = bytes.toString("utf8", at, at + nameLength);
    at += nameLength;
    const type = bytes.readUInt8(at);
    at += 1;
    if (type === 7) {
      const valueLength = bytes.readUInt16BE(at);
      at += 2;
      headers[name] = bytes.toString("utf8", at, at + valueLength);
      at += valueLength;
    } else if (type === 6) {
      at += 1; // a byte
    } else if (type === 0 || type === 1) {
      // true and false carry no value
    } else {
      throw new Error("This part of the reply used a format Branch does not read");
    }
  }
  return headers;
}

/** Builds one frame, which is how the tests make a fake Amazon reply to read back. */
export function encodeEvent(type: string, payload: unknown): Buffer {
  const name = Buffer.from(":event-type", "utf8"), value = Buffer.from(type, "utf8");
  const header = Buffer.concat([
    Buffer.from([name.length]), name, Buffer.from([7]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(value.length); return b; })(), value,
  ]);
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const total = 16 + header.length + body.length;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(header.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude));
  const withoutCrc = Buffer.concat([prelude, preludeCrc, header, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(withoutCrc));
  return Buffer.concat([withoutCrc, messageCrc]);
}

/**
 * Feeds bytes in and gets whole frames out. Frames arrive split across reads, so anything
 * incomplete is held until the rest turns up; a frame whose checksum is wrong stops the stream
 * rather than being guessed at.
 */
export class AwsEventFraming {
  private buffer = Buffer.alloc(0);
  private seen = 0;
  push(chunk: Uint8Array): AwsEvent[] {
    this.seen += chunk.byteLength;
    if (this.seen > 8 * 1048576) throw new Error("The reply from Amazon was longer than Branch will read");
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const events: AwsEvent[] = [];
    while (this.buffer.length >= 16) {
      const total = this.buffer.readUInt32BE(0);
      if (total < 16 || total > 1048576) throw new Error("Amazon sent a reply Branch could not make sense of");
      if (this.buffer.length < total) break;
      events.push(this.decode(this.buffer.subarray(0, total)));
      this.buffer = this.buffer.subarray(total);
    }
    return events;
  }
  private decode(frame: Buffer): AwsEvent {
    const headerLength = frame.readUInt32BE(4);
    if (crc32(frame.subarray(0, 8)) !== frame.readUInt32BE(8))
      throw new Error("Part of Amazon's reply arrived damaged");
    if (crc32(frame.subarray(0, frame.length - 4)) !== frame.readUInt32BE(frame.length - 4))
      throw new Error("Part of Amazon's reply arrived damaged");
    const headers = readHeaders(frame.subarray(12, 12 + headerLength));
    const body = frame.subarray(12 + headerLength, frame.length - 4).toString("utf8");
    return { type: headers[":event-type"] ?? headers[":exception-type"] ?? "unknown", payload: body ? (JSON.parse(body) as unknown) : null };
  }
  /** True when nothing half-read is left over, which is how a truncated stream is spotted. */
  get complete(): boolean {
    return this.buffer.length === 0;
  }
}

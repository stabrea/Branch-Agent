/**
 * The small slice of Protocol Buffers that Mumble's control channel needs, written by hand so no
 * dependency is added. Field numbers follow Mumble.proto
 * (https://github.com/mumble-voip/mumble/blob/master/src/Mumble.proto).
 *
 * Every control message travels as a 2-byte message type and a 4-byte length (both big-endian),
 * then the protobuf body.
 */
export const MumbleType = {
  Version: 0, UDPTunnel: 1, Authenticate: 2, Ping: 3, Reject: 4, ServerSync: 5,
  ChannelState: 7, UserRemove: 8, UserState: 9, TextMessage: 11,
} as const;

/** A value to write: a number or bigint is a varint, a string is length-delimited, a boolean is 0/1. */
export type FieldValue = number | bigint | string | boolean;

export function varint(value: number | bigint): Buffer {
  let rest = BigInt(value);
  if (rest < 0n) throw new Error("Negative numbers are not written here");
  const bytes: number[] = [];
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest > 0n ? low | 0x80 : low);
  } while (rest > 0n);
  return Buffer.from(bytes);
}

/** Writes fields in order. A repeated field is written once per value, unpacked, as proto2 does. */
export function encodeFields(fields: [number, FieldValue | undefined][]): Buffer {
  const parts: Buffer[] = [];
  for (const [field, value] of fields) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      const bytes = Buffer.from(value, "utf8");
      parts.push(varint((field << 3) | 2), varint(bytes.length), bytes);
    } else {
      parts.push(varint(field << 3), varint(typeof value === "boolean" ? (value ? 1 : 0) : value));
    }
  }
  return Buffer.concat(parts);
}

/** One decoded message: each field number maps to every value seen (varints as bigint, bytes as Buffer). */
export type Fields = Map<number, (bigint | Buffer)[]>;

function readVarint(data: Buffer, at: number): [bigint, number] {
  let value = 0n;
  for (let shift = 0n, i = at; i < data.length && shift < 70n; i++, shift += 7n) {
    const byte = data[i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, i + 1];
  }
  throw new Error("A Mumble message ended in the middle of a number");
}

export function decodeFields(data: Buffer): Fields {
  const fields: Fields = new Map();
  const add = (field: number, value: bigint | Buffer) => { const list = fields.get(field) ?? []; list.push(value); fields.set(field, list); };
  let at = 0;
  while (at < data.length) {
    const [key, next] = readVarint(data, at);
    at = next;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) { const [value, after] = readVarint(data, at); add(field, value); at = after; }
    else if (wire === 2) {
      const [length, after] = readVarint(data, at);
      const end = after + Number(length);
      if (end > data.length) throw new Error("A Mumble message is shorter than it says");
      add(field, data.subarray(after, end));
      at = end;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error("A Mumble message used a field shape this client does not read");
  }
  return fields;
}

/** The first value of a number field, if present. */
export function numberField(fields: Fields, field: number): number | undefined {
  const value = fields.get(field)?.[0];
  return typeof value === "bigint" ? Number(value) : undefined;
}
/** Every value of a repeated number field, packed or not. */
export function numberList(fields: Fields, field: number): number[] {
  const out: number[] = [];
  for (const value of fields.get(field) ?? []) {
    if (typeof value === "bigint") { out.push(Number(value)); continue; }
    for (let at = 0; at < value.length;) { const [n, next] = readVarint(value, at); out.push(Number(n)); at = next; }
  }
  return out;
}
export function textField(fields: Fields, field: number): string | undefined {
  const value = fields.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString("utf8") : undefined;
}

export function frame(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(type, 0);
  head.writeUInt32BE(body.length, 2);
  return Buffer.concat([head, body]);
}

/** Collects bytes and hands over whole frames. Anything over 8 MB is refused as broken. */
export function frameReader(onFrame: (type: number, body: Buffer) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 6) {
      const length = pending.readUInt32BE(2);
      if (length > 8 * 1024 * 1024) throw new Error("The Mumble server sent a message too large to be real");
      if (pending.length < 6 + length) return;
      const type = pending.readUInt16BE(0);
      const body = pending.subarray(6, 6 + length);
      pending = pending.subarray(6 + length);
      onFrame(type, body);
    }
  };
}

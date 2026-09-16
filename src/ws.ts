import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { Store } from "./store.js";

/**
 * A small WebSocket server (RFC 6455, text frames, no extensions) that streams a run's events in
 * order, so clients that prefer a socket over Server-Sent Events get the same ordered activity.
 * Browsers cannot set an Authorization header on a socket, so the session token travels in the
 * Sec-WebSocket-Protocol header as "bearer, <token>".
 */
const magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key: string): string {
  return createHash("sha1").update(key + magic).digest("base64");
}
export function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length])
    : payload.length < 65536 ? Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()])
    : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([head, payload]);
}
/** Decodes one client frame (masked) if complete; returns its opcode and payload, or null when more bytes are needed. */
export function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f, masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f, offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { opcode, payload, consumed: offset + maskLength + length };
}

export function tokenFromProtocol(request: IncomingMessage, token: string): boolean {
  const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const supplied = offered[0] === "bearer" ? offered[1] ?? "" : "";
  return supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

/** Completes the handshake and streams the run's events; ends with an "end" message when the run is over. */
export async function serveRunSocket(store: Store, runId: string, request: IncomingMessage, socket: Duplex, options: { pollMs?: number; maxMs?: number } = {}): Promise<void> {
  const key = String(request.headers["sec-websocket-key"] ?? "");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "Sec-WebSocket-Protocol: bearer", "", ""].join("\r\n"));
  let open = true, pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
      pending = pending.subarray(decoded.consumed);
      if (decoded.opcode === 0x8) { open = false; socket.end(Buffer.from([0x88, 0x00])); }
      else if (decoded.opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload]));
    }
  });
  socket.on("close", () => { open = false; });
  socket.on("error", () => { open = false; });
  const deadline = Date.now() + (options.maxMs ?? 150000);
  let last = 0;
  while (open && Date.now() < deadline) {
    for (const event of store.events(runId).filter((e) => e.id > last)) {
      socket.write(frame(JSON.stringify({ id: event.id, kind: event.kind, data: event.data, createdAt: event.createdAt })));
      last = event.id;
    }
    const run = store.run(runId);
    if (!run || run.status !== "running") { socket.write(frame(JSON.stringify({ kind: "end", status: run?.status ?? "unknown" }))); break; }
    await delay(options.pollMs ?? 250);
  }
  if (open) socket.end(Buffer.from([0x88, 0x00]));
}

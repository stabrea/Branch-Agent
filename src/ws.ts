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
  return frameOf(Buffer.from(text, "utf8"), 0x81);
}
/** The same frame with the binary opcode, for sound travelling either way. */
export function binaryFrame(payload: Buffer): Buffer {
  return frameOf(payload, 0x82);
}
function frameOf(payload: Buffer, opcode: number): Buffer {
  const head = payload.length < 126 ? Buffer.from([opcode, payload.length])
    : payload.length < 65536 ? Buffer.concat([Buffer.from([opcode, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()])
    : Buffer.concat([Buffer.from([opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([head, payload]);
}
/** Decodes one frame if complete; returns whether it is final, its opcode and payload, or null when more bytes are needed. */
export function readFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const fin = (buffer[0]! & 0x80) !== 0, opcode = buffer[0]! & 0x0f, masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f, offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { fin, opcode, payload, consumed: offset + maskLength + length };
}

export function tokenFromProtocol(request: IncomingMessage, token: string): boolean {
  const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
  const supplied = offered[0] === "bearer" ? offered[1] ?? "" : "";
  return supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

/**
 * What something on the server side of a run socket may write down it. Sound never goes through
 * the event log on its way to the browser: the event log is read by a poll and is kept on disk,
 * and a live conversation's audio is neither slow enough for one nor meant to be kept at all.
 */
export interface RunSocketWriter {
  text(value: string): void;
  binary(payload: Buffer): void;
  open(): boolean;
}
/** Hooks for a run socket that carries more than events, so a live voice conversation can use it. */
export interface RunSocketHooks {
  /** Every frame the browser sends up. Binary frames are microphone sound. */
  onClientFrame?(payload: Buffer, binary: boolean, reply: RunSocketWriter): void;
  onOpen?(reply: RunSocketWriter): void;
  onClose?(): void;
  /**
   * True while a live conversation is still going. A task's socket otherwise gives up after a
   * couple of minutes, which is shorter than a conversation is allowed to last; a live one is held
   * open instead, and its own limits on minutes and money are what end it.
   */
  liveOpen?(): boolean;
}

/** Completes the handshake and streams the run's events; ends with an "end" message when the run is over. */
/** Integration review (mac7/nodes): the most a run socket holds of a message still arriving. */
const runSocketBuffer = 4 * 1024 * 1024;

export async function serveRunSocket(store: Store, runId: string, request: IncomingMessage, socket: Duplex, options: { pollMs?: number; maxMs?: number; pingMs?: number; idleMs?: number } & RunSocketHooks = {}): Promise<void> {
  const key = String(request.headers["sec-websocket-key"] ?? "");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "Sec-WebSocket-Protocol: bearer", "", ""].join("\r\n"));
  let open = true, pending = Buffer.alloc(0), heard = Date.now();
  const reply: RunSocketWriter = {
    text: (value) => { if (open) socket.write(frame(value)); },
    binary: (payload) => { if (open) socket.write(binaryFrame(payload)); },
    open: () => open,
  };
  socket.on("data", (chunk: Buffer) => {
    heard = Date.now();
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > runSocketBuffer) { shut(); socket.destroy(); return; }
    for (let decoded = readFrame(pending); decoded && open; decoded = readFrame(pending)) {
      pending = pending.subarray(decoded.consumed);
      if (decoded.opcode === 0x8) { open = false; socket.end(Buffer.from([0x88, 0x00])); }
      else if (decoded.opcode === 0x9) { if (decoded.payload.length <= 125) socket.write(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload])); }
      // A text or binary frame from the browser: a live conversation's sound, or a line typed while
      // it is talking. Nothing here reads them itself; whoever asked for the hook does.
      else if (decoded.opcode === 0x1 || decoded.opcode === 0x2)
        try { options.onClientFrame?.(decoded.payload, decoded.opcode === 0x2, reply); } catch { /* one bad frame does not end the socket */ }
    }
  });
  const shut = (): void => { if (!open) return; open = false; try { options.onClose?.(); } catch { /* closing */ } };
  socket.on("close", shut);
  socket.on("error", shut);
  // Integration review (mac7/nodes): a peer that hangs up its half, or goes silent without closing,
  // used to keep a live conversation's loop running for ever. It is asked with a ping, then let go.
  socket.once("end", () => { shut(); socket.destroy(); });
  const pingMs = options.pingMs ?? 20_000, idleMs = options.idleMs ?? 60_000;
  const ping = setInterval(() => {
    if (!open) return;
    if (Date.now() - heard > idleMs) { shut(); socket.destroy(); return; }
    socket.write(Buffer.from([0x89, 0x00]));
  }, pingMs);
  ping.unref();
  options.onOpen?.(reply);
  try {
    await pollRun(store, runId, socket, () => open, options);
  } finally {
    clearInterval(ping);
  }
  if (open) { shut(); socket.end(Buffer.from([0x88, 0x00])); }
}

async function pollRun(store: Store, runId: string, socket: Duplex, isOpen: () => boolean, options: { pollMs?: number; maxMs?: number } & RunSocketHooks): Promise<void> {
  const deadline = Date.now() + (options.maxMs ?? 150000);
  let last = 0;
  while (isOpen() && (Date.now() < deadline || options.liveOpen?.() === true)) {
    for (const event of store.events(runId).filter((e) => e.id > last)) {
      socket.write(frame(JSON.stringify({ id: event.id, kind: event.kind, data: event.data, createdAt: event.createdAt })));
      last = event.id;
    }
    const run = store.run(runId);
    if ((!run || run.status !== "running") && options.liveOpen?.() !== true) {
      socket.write(frame(JSON.stringify({ kind: "end", status: run?.status ?? "unknown" })));
      break;
    }
    await delay(options.pollMs ?? 250);
  }
}

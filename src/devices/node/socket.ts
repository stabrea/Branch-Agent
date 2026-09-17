import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { maskedFrame } from "../../channels/ws-client.js";
import { acceptKey, readFrame } from "../../ws.js";
import { mediaLimitBytes } from "../capabilities.js";
import { socketPath } from "../protocol.js";

/**
 * mac7/nodes: the node's end of the device socket. It dials out (a node never listens), speaks
 * masked frames as a client must, and hands whole text and binary messages to its owner.
 */
export interface NodeSocket {
  text(value: unknown): void;
  binary(payload: Buffer): void;
  close(): void;
  readonly closed: Promise<void>;
}
export interface NodeSocketEvents {
  onText(text: string): void;
  /** Any frame at all, pings included, so the node can tell a silent connection from a quiet one. */
  onActivity(): void;
}
export type DialNode = (hub: string, deviceId: string, events: NodeSocketEvents) => Promise<NodeSocket>;

export class RefusedError extends Error {
  constructor(readonly status: number) { super(`Branch refused the connection (${status}).`); }
}

/** `http://host:port` → `ws://host:port/api/devices/socket`. */
export function socketAddress(hub: string): URL {
  const url = new URL(hub);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The Branch address must start with http:// or https://");
  return new URL(socketPath, url);
}

export const dialNode: DialNode = (hub, deviceId, events) => new Promise((resolve, reject) => {
  const url = socketAddress(hub);
  const key = randomBytes(16).toString("base64");
  const call = url.protocol === "https:" ? httpsRequest : httpRequest;
  const outgoing = call({
    protocol: url.protocol, hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname, method: "GET",
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-version": "13", "x-branch-node": deviceId },
  });
  const fail = (error: Error): void => { outgoing.destroy(); reject(error); };
  outgoing.setTimeout(20_000, () => fail(new Error("Branch did not answer in time.")));
  outgoing.on("error", fail);
  outgoing.on("response", (response) => fail(new RefusedError(response.statusCode ?? 0)));
  outgoing.on("upgrade", (response, socket, head) => {
    if (String(response.headers["sec-websocket-accept"] ?? "") !== acceptKey(key)) { socket.destroy(); reject(new Error("Branch answered with a bad handshake.")); return; }
    resolve(attach(socket as Socket, head, events));
  });
  outgoing.end();
});

function attach(socket: Socket, head: Buffer, events: NodeSocketEvents): NodeSocket {
  let pending = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let done = (): void => undefined;
  const closed = new Promise<void>((resolve) => { done = resolve; });
  const drain = (): void => {
    for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
      pending = pending.subarray(decoded.consumed);
      events.onActivity();
      if (decoded.opcode === 0x8) { socket.end(maskedFrame(Buffer.alloc(0), 0x8)); return; }
      if (decoded.opcode === 0x9) { socket.write(maskedFrame(decoded.payload, 0xa)); continue; }
      if (decoded.opcode === 0x1 && decoded.fin) {
        try { events.onText(decoded.payload.toString("utf8")); } catch { /* one bad message must not end the socket */ }
      }
    }
  };
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > 1024 * 1024) { socket.destroy(); return; }
    drain();
  });
  if (pending.length) setImmediate(drain);
  socket.on("close", () => done());
  socket.once("end", () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.setTimeout(0);
  socket.setNoDelay(true);
  return {
    text: (value) => { if (socket.writable) socket.write(maskedFrame(Buffer.from(JSON.stringify(value), "utf8"), 0x1)); },
    binary: (payload) => {
      if (payload.length > mediaLimitBytes + 32) throw new Error("Too large to send.");
      if (socket.writable) socket.write(maskedFrame(payload, 0x2));
    },
    close: () => { if (socket.writable) socket.end(maskedFrame(Buffer.alloc(0), 0x8)); else socket.destroy(); },
    closed,
  };
}

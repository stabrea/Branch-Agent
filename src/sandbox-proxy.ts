import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer as createNetServer, isIP, type Socket } from "node:net";
import { redactLeaks } from "./leak-guard.js";
import { scrubSecrets } from "./locker.js";
import type { WallNetwork } from "./sandbox.js";

/**
 * Branch's own door to the network for a program behind the wall. The wall lets the program reach
 * only this door; the door asks, for every site, whether the owner has allowed it. A site nobody has
 * decided about is refused for now and remembered, and when the command ends the task stops with
 * "may programs reach github.com?" on the ordinary approval card.
 *
 * "Limited" lets programs read only: GET and HEAD. A secure tunnel hides its method, so in that mode
 * tunnels are refused and a program has to ask for the plain address.
 *
 * Keys stay at the edge. A program behind the wall is given a stand-in (`branch_` and 32 letters)
 * for each saved key the owner tied to a site. When a request to exactly that site carries the
 * stand-in, the door swaps in the real key, sends the request on over a secure connection, and
 * takes the key — and anything else key-shaped — back out of the answer. A stand-in headed anywhere
 * else is refused. A secure tunnel the program opens itself cannot be read, so a stand-in inside one
 * stays a stand-in and the real key never leaves.
 *
 * The shape of the door follows Codex's `codex-rs/network-proxy` and the stand-ins follow IronClaw's
 * `ironclaw_secrets/src/placeholder.rs` and `managed_egress.rs` (Apache-2.0 / MIT, see
 * THIRD_PARTY_NOTICES.md). Both were written afresh here in TypeScript.
 */

export const placeholderPrefix = "branch_";
const placeholderPattern = /branch_[a-f0-9]{32}/g;
export const newPlaceholder = (): string => `${placeholderPrefix}${randomBytes(16).toString("hex")}`;

export interface EdgeKey { name: string; placeholder: string; value: string; site: string }
export type SiteDecision = "allow" | "deny" | "ask";
export interface ProxyOptions {
  network: Exclude<WallNetwork, "none">;
  decide(host: string): SiteDecision;
  /** The owner's network rules; throws a plain reason when a site may not be reached. */
  check?: ((target: URL) => Promise<void>) | undefined;
  keys?: readonly EdgeKey[];
  /** Where a request really goes. Replaced in tests so a plain local server stands in for a site. */
  upstream?: ((target: { host: string; port: number; secure: boolean }) => { host: string; port: number; secure: boolean }) | undefined;
  /** Listen on a local socket file instead of a port (Linux, where the program has its own network). */
  paths?: { http: string; socks: string };
}
export interface ProxyAddress { httpPort?: number; socksPort?: number; httpPath?: string; socksPath?: string }

const hopHeaders = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]);
const maxBuffered = 16 * 1024 * 1024;

export class SandboxProxy {
  /** Sites a program tried that nobody has decided about yet, in the order they were tried. */
  readonly asked: string[] = [];
  /** Plain reasons for everything the door refused, for the task's record. */
  readonly refused: string[] = [];
  /** The kinds of key-shaped values taken out of answers. */
  readonly hidden = new Set<string>();
  private readonly http: Server;
  private readonly socks = createNetServer((socket) => void this.socksConnection(socket));
  private readonly sockets = new Set<Socket>();
  constructor(private readonly options: ProxyOptions) {
    this.http = createHttpServer((request, response) => void this.forward(request, response));
    this.http.on("connect", (request: IncomingMessage, socket: Socket, head: Buffer) => void this.tunnel(request, socket, head));
    for (const server of [this.http, this.socks]) server.on("connection", (socket: Socket) => this.track(socket));
  }
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }
  async start(): Promise<ProxyAddress> {
    const listen = (server: Server | ReturnType<typeof createNetServer>, path?: string) => new Promise<number | undefined>((resolve, reject) => {
      server.once("error", reject);
      const done = () => { const at = server.address(); resolve(typeof at === "object" && at ? at.port : undefined); };
      if (path) server.listen(path, done); else server.listen(0, "127.0.0.1", done);
    });
    const paths = this.options.paths;
    const httpPort = await listen(this.http, paths?.http), socksPort = await listen(this.socks, paths?.socks);
    return paths ? { httpPath: paths.http, socksPath: paths.socks } : { httpPort: httpPort!, socksPort: socksPort! };
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([this.http, this.socks].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }

  /** Whether a program may reach this site now; a reason when it may not. */
  private async admit(host: string, port: number, secure: boolean): Promise<string | null> {
    const name = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!name || name.length > 253) return "That is not a site name.";
    const decision = this.options.decide(name);
    if (decision === "deny") return `You have not allowed programs to reach ${name}.`;
    if (decision === "ask") {
      if (!this.asked.includes(name)) this.asked.push(name);
      return `Branch is asking the owner whether programs may reach ${name}. Try again once they have answered.`;
    }
    try { await this.options.check?.(new URL(`${secure ? "https" : "http"}://${isIP(name) === 6 ? `[${name}]` : name}:${port}/`)); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    return null;
  }
  private refuse(reason: string): string { this.refused.push(reason); return reason; }
  private route(host: string, port: number, secure: boolean) {
    return this.options.upstream?.({ host, port, secure }) ?? { host, port, secure };
  }

  // ---------------------------------------------------------------- tunnels (CONNECT and SOCKS)

  private async tunnel(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const target = /^([^:\s]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(request.url ?? "");
    const reason = !target ? "That is not a site and a port."
      : this.options.network === "limited" ? "Programs may only read from sites, and a secure tunnel hides what it does. Ask for the plain address instead."
        : await this.admit(target[1]!, Number(target[2]), true);
    if (reason || !target) { socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${this.refuse(reason ?? "")}\n`); return; }
    const to = this.route(target[1]!.replace(/^\[|\]$/g, ""), Number(target[2]), true);
    const upstream = this.track2(connect(to.port, to.host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }), socket);
  }
  private track2(upstream: Socket, downstream: Socket): Socket {
    this.track(upstream);
    upstream.on("error", () => downstream.destroy());
    downstream.on("close", () => upstream.destroy());
    return upstream;
  }

  private async socksConnection(socket: Socket): Promise<void> {
    const read = byteReader(socket);
    try {
      const [version, count] = await read(2);
      if (version !== 5) throw new Error("not SOCKS5");
      await read(count!);
      socket.write(Buffer.from([5, 0]));
      const [, command, , kind] = await read(4);
      const host = kind === 1 ? [...await read(4)].join(".")
        : kind === 3 ? (await read((await read(1))[0]!)).toString("latin1")
          : kind === 4 ? ipv6Text(await read(16)) : "";
      const port = (await read(2)).readUInt16BE(0);
      const reason = command !== 1 ? "Only connecting is supported."
        : this.options.network === "limited" ? "Programs may only read from sites, and a direct connection hides what it does."
          : await this.admit(host, port, port === 443);
      if (reason) { this.refuse(reason); socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const to = this.route(host, port, port === 443);
      const upstream = this.track2(connect(to.port, to.host, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        read.release();
        upstream.pipe(socket).pipe(upstream);
      }), socket);
    } catch { socket.destroy(); }
  }

  // ---------------------------------------------------------------- plain requests

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deny = (status: number, reason: string) => { response.writeHead(status, { "content-type": "text/plain" }).end(`${this.refuse(reason)}\n`); };
    let url: URL;
    try { url = new URL(request.url ?? ""); } catch { deny(400, "Send the whole address through the proxy."); return; }
    if (url.protocol !== "http:") { deny(400, "Only plain addresses go through this way."); return; }
    const method = (request.method ?? "GET").toUpperCase();
    if (this.options.network === "limited" && method !== "GET" && method !== "HEAD") { deny(405, "Programs may only read from sites (GET and HEAD)."); return; }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const swap = this.swapsFor(request, url, host);
    if (typeof swap === "string") { deny(403, swap); return; }
    const secure = swap.length > 0;
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const reason = await this.admit(host, port, secure);
    if (reason) { deny(403, reason); return; }
    this.send(request, response, { url, host, port, secure, swap, method });
  }

  /** The keys this request carries stand-ins for, or why it may not carry them. */
  private swapsFor(request: IncomingMessage, url: URL, host: string): EdgeKey[] | string {
    const text = [url.href, ...Object.values(request.headers).flat()].join("\n");
    const found = new Set(text.match(placeholderPattern) ?? []);
    const keys: EdgeKey[] = [];
    for (const placeholder of found) {
      const key = this.options.keys?.find((entry) => entry.placeholder === placeholder);
      if (!key) return "That request carries a stand-in key Branch does not know.";
      if (!key.site) return `No site is set for the key ${key.name}, so Branch does not send it anywhere. The owner sets one in Settings, Computer.`;
      if (key.site !== host) return `The key ${key.name} belongs to ${key.site}, so it is not sent to ${host}.`;
      keys.push(key);
    }
    return keys;
  }

  private send(request: IncomingMessage, response: ServerResponse,
    target: { url: URL; host: string; port: number; secure: boolean; swap: EdgeKey[]; method: string }): void {
    const { swap } = target;
    const put = (value: string) => swap.reduce((text, key) => text.split(key.placeholder).join(key.value), value);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !hopHeaders.has(name)) headers[name] = Array.isArray(value) ? value.map(put) : put(value);
    const to = this.route(target.host, target.port, target.secure);
    const path = put(`${target.url.pathname}${target.url.search}`);
    const make = to.secure ? httpsRequest : httpRequest;
    const outgoing = make({ host: to.host, port: to.port, method: target.method, path, headers,
      ...(to.secure ? { servername: isIP(target.host) ? undefined : target.host } : {}) }, (answer) => {
      if (!swap.length) { response.writeHead(answer.statusCode ?? 502, cleanHeaders(answer.headers)); answer.pipe(response); return; }
      void this.cleaned(answer, swap).then(({ status, headers: out, body }) => response.writeHead(status, out).end(body))
        .catch(() => response.destroy());
    });
    outgoing.on("error", () => { if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" }); response.end("The site could not be reached.\n"); });
    request.pipe(outgoing);
  }

  /** An answer to a request that carried a real key, with that key and anything key-shaped taken out. */
  private async cleaned(answer: IncomingMessage, swap: EdgeKey[]) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of answer) {
      size += (chunk as Buffer).length;
      if (size > maxBuffered) throw new Error("answer too large");
      chunks.push(chunk as Buffer);
    }
    const values = Object.fromEntries(swap.map((key) => [key.name, key.value]));
    const clean = (text: string) => {
      const redacted = redactLeaks(scrubSecrets(text, values));
      for (const kind of redacted.kinds) this.hidden.add(kind);
      return redacted.text;
    };
    const headers = cleanHeaders(answer.headers);
    for (const [name, value] of Object.entries(headers))
      headers[name] = Array.isArray(value) ? value.map(clean) : clean(value);
    delete headers["content-length"];
    const raw = Buffer.concat(chunks);
    const type = String(answer.headers["content-type"] ?? "");
    const textual = !answer.headers["content-encoding"] && (!type || /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript))|\+json|\+xml/i.test(type));
    // Anything that is not plain text cannot be checked, so it is not passed on at all.
    const body = textual ? Buffer.from(clean(raw.toString("utf8"))) : Buffer.from("Branch held back an answer it could not check for keys.\n");
    return { status: textual ? answer.statusCode ?? 502 : 502, headers: textual ? headers : { "content-type": "text/plain" }, body };
  }
}

function cleanHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !hopHeaders.has(name)) out[name] = value;
  return out;
}

function ipv6Text(bytes: Buffer): string {
  const groups: string[] = [];
  for (let at = 0; at < 16; at += 2) groups.push(bytes.readUInt16BE(at).toString(16));
  return groups.join(":");
}

/** Reads exact byte counts from a socket, keeping what arrives early; `release` hands the rest back. */
function byteReader(socket: Socket) {
  let held = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  const onData = (chunk: Buffer) => { held = Buffer.concat([held, chunk]); wake?.(); };
  const onEnd = () => wake?.();
  socket.on("data", onData);
  socket.on("close", onEnd);
  const read = async (count: number): Promise<Buffer> => {
    while (held.length < count) {
      if (socket.destroyed) throw new Error("closed");
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
    }
    const out = held.subarray(0, count);
    held = held.subarray(count);
    return out;
  };
  read.release = () => {
    socket.off("data", onData);
    socket.off("close", onEnd);
    if (held.length) socket.unshift(held);
  };
  return read;
}

/** The variables that point ordinary programs at the door. */
export function proxyEnvironment(address: { httpPort: number; socksPort: number }): NodeJS.ProcessEnv {
  const http = `http://127.0.0.1:${address.httpPort}`, socks = `socks5h://127.0.0.1:${address.socksPort}`;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "", no_proxy: "" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY"]) { env[name] = http; env[name.toLowerCase()] = http; }
  env.ALL_PROXY = socks; env.all_proxy = socks;
  return env;
}

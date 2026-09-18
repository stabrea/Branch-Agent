import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, createServer as createNetServer, isIP, type Socket } from "node:net";
import { redactLeaks } from "./leak-guard.js";
import { scrubSecrets } from "./locker.js";
import { isPrivateAddress } from "./network-policy.js";
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
 *
 * Integration review (mac3/os-sandbox): the door only answers a caller that knows this run's own
 * secret (sent as the proxy's user name and password, which ordinary programs do by themselves when
 * it is part of the proxy address), never reaches this computer or a private network whatever the
 * web rules say, and connects to the very address it checked, so a name cannot change its answer
 * between the check and the connection.
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
  upstream?: ((target: Route) => { host: string; port: number; secure: boolean }) | undefined;
  /** How a site name becomes addresses. Replaced in tests. */
  resolve?: ((host: string) => Promise<string[]>) | undefined;
  /** Listen on a local socket file instead of a port (Linux, where the program has its own network). */
  paths?: { http: string; socks: string };
}
/** Where a request goes: the site's name (for the secure handshake and the Host line) and the checked address. */
export interface Route { host: string; address: string; port: number; secure: boolean }
export interface ProxyAddress { httpPort?: number; socksPort?: number; httpPath?: string; socksPath?: string }

const hopHeaders = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]);
const maxBuffered = 16 * 1024 * 1024;
/** How many new sites one command may ask about; the task stops on the first anyway. */
const maxAsked = 16;
const connectTimeoutMs = 30_000;
const siteName = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/;
const defaultResolve = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

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
  /** This run's own secret: a caller that does not send it is turned away before anything else. */
  readonly secret = randomBytes(18).toString("hex");
  constructor(private readonly options: ProxyOptions) {
    this.http = createHttpServer((request, response) => void this.forward(request, response).catch(() => response.destroy()));
    this.http.on("connect", (request: IncomingMessage, socket: Socket, head: Buffer) =>
      void this.tunnel(request, socket, head).catch(() => socket.destroy()));
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

  /** Whether a program may reach this site now: the checked address to connect to, or why not. */
  private async admit(host: string, port: number, secure: boolean): Promise<{ address: string } | { reason: string }> {
    const name = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (!name || name.length > 253 || !(isIP(name) || siteName.test(name))) return { reason: "That is not a site name." };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { reason: "That is not a port." };
    const decision = this.options.decide(name);
    if (decision === "deny") return { reason: `You have not allowed programs to reach ${name}.` };
    if (decision === "ask") {
      if (!this.asked.includes(name) && this.asked.length < maxAsked) this.asked.push(name);
      return { reason: `Branch is asking the owner whether programs may reach ${name}. Try again once they have answered.` };
    }
    try { await this.options.check?.(new URL(`${secure ? "https" : "http"}://${isIP(name) === 6 ? `[${name}]` : name}:${port}/`)); }
    catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
    return this.pinned(name);
  }
  /** The one address the connection will use, looked up once; never this computer or a private network. */
  private async pinned(name: string): Promise<{ address: string } | { reason: string }> {
    const addresses = isIP(name) ? [name] : await (this.options.resolve ?? defaultResolve)(name).catch(() => []);
    if (!addresses.length) return { reason: `${name} could not be found.` };
    if (addresses.some(isPrivateAddress))
      return { reason: `${name} points at this computer or a private network, which programs behind the wall may never reach.` };
    return { address: addresses[0]! };
  }
  /** Whether the caller knows this run's secret, as a proxy user name and password. */
  private knows(user: string, password: string): boolean {
    const want = Buffer.from(`branch:${this.secret}`), got = Buffer.from(`${user}:${password}`);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  private authorised(request: IncomingMessage): boolean {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(String(request.headers["proxy-authorization"] ?? ""));
    if (!match) return false;
    const text = Buffer.from(match[1]!, "base64").toString("utf8"), colon = text.indexOf(":");
    return colon > 0 && this.knows(text.slice(0, colon), text.slice(colon + 1));
  }
  private refuse(reason: string): string { this.refused.push(reason); return reason; }
  private route(target: Route): { host: string; port: number; secure: boolean } {
    return this.options.upstream?.(target) ?? { host: target.address, port: target.port, secure: target.secure };
  }
  /** Connects to the checked address, giving up if the site does not answer in time. */
  private dial(to: { host: string; port: number }, downstream: Socket, ready: (upstream: Socket) => void): void {
    const upstream = this.track2(connect(to.port, to.host), downstream);
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
    upstream.once("connect", () => { upstream.setTimeout(0); ready(upstream); });
  }

  // ---------------------------------------------------------------- tunnels (CONNECT and SOCKS)

  private async tunnel(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (!this.authorised(request)) {
      socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="branch"\r\ncontent-type: text/plain\r\n\r\n${this.refuse("A program without this run's door secret was turned away.")}\n`);
      return;
    }
    const target = /^([^:\s]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(request.url ?? "");
    // Port 443 is the secure tunnel; to any other port the program speaks plainly inside it. Saying
    // otherwise would show the owner's network rules an https address for a plain one (the SOCKS
    // door already reads the port this way).
    const port = target ? Number(target[2]) : 0;
    const secure = port === 443;
    // A tunnel to a real port other than 443 carries plain words, so a refusal can be said inside it.
    // A port that is not a port has no inside, so that one keeps the refusal on the tunnel's own reply.
    const plain = Boolean(target) && port >= 1 && port <= 65535 && !secure;
    const admitted = !target ? { reason: "That is not a site and a port." }
      : this.options.network === "limited" ? { reason: "Programs may only read from sites, and a secure tunnel hides what it does. Ask for the plain address instead." }
        : await this.admit(target[1]!, port, secure);
    if ("reason" in admitted || !target) {
      const reason = this.refuse("reason" in admitted ? admitted.reason : "");
      // A program that opens a plain tunnel reads an ordinary answer inside it, so the reason reaches
      // it in words rather than as a bare network error. Nothing is dialled and nothing leaves: the
      // refusal is written here and the tunnel ends. A secure tunnel would only see a failed
      // handshake, so that one keeps the refusal on the tunnel's own reply.
      if (plain) { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); socket.end(plainRefusal(reason)); return; }
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${reason}\n`);
      return;
    }
    const host = target[1]!.replace(/^\[|\]$/g, "").toLowerCase();
    this.dial(this.route({ host, address: admitted.address, port, secure }), socket, (upstream) => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
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
      if (!(await this.socksGreeting(socket, read))) return;
      const [, command, , kind] = await read(4);
      const host = kind === 1 ? [...await read(4)].join(".")
        : kind === 3 ? (await read((await read(1))[0]!)).toString("latin1")
          : kind === 4 ? ipv6Text(await read(16)) : "";
      const port = (await read(2)).readUInt16BE(0);
      const admitted = command !== 1 ? { reason: "Only connecting is supported." }
        : this.options.network === "limited" ? { reason: "Programs may only read from sites, and a direct connection hides what it does." }
          : await this.admit(host, port, port === 443);
      if ("reason" in admitted) { this.refuse(admitted.reason); socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const route = { host: host.toLowerCase(), address: admitted.address, port, secure: port === 443 };
      this.dial(this.route(route), socket, (upstream) => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        read.release();
        upstream.pipe(socket).pipe(upstream);
      });
    } catch { socket.destroy(); }
  }
  /** SOCKS5 with a user name and password only (RFC 1929): the password is this run's secret. */
  private async socksGreeting(socket: Socket, read: ReturnType<typeof byteReader>): Promise<boolean> {
    const [version, count] = await read(2);
    if (version !== 5) throw new Error("not SOCKS5");
    const methods = await read(count!);
    if (!methods.includes(2)) { this.refuse("A program without this run's door secret was turned away."); socket.end(Buffer.from([5, 0xff])); return false; }
    socket.write(Buffer.from([5, 2]));
    const [, userLength] = await read(2);
    const user = (await read(userLength!)).toString("utf8");
    const password = (await read((await read(1))[0]!)).toString("utf8");
    const ok = this.knows(user, password);
    socket.write(Buffer.from([1, ok ? 0 : 1]));
    if (!ok) { this.refuse("A program without this run's door secret was turned away."); socket.end(); }
    return ok;
  }

  // ---------------------------------------------------------------- plain requests

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deny = (status: number, reason: string) => { response.writeHead(status, { "content-type": "text/plain" }).end(`${this.refuse(reason)}\n`); };
    if (!this.authorised(request)) {
      response.writeHead(407, { "proxy-authenticate": 'Basic realm="branch"', "content-type": "text/plain" })
        .end(`${this.refuse("A program without this run's door secret was turned away.")}\n`);
      return;
    }
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
    const admitted = await this.admit(host, port, secure);
    if ("reason" in admitted) { deny(403, admitted.reason); return; }
    this.send(request, response, { url, host, address: admitted.address, port, secure, swap, method });
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
    target: { url: URL; host: string; address: string; port: number; secure: boolean; swap: EdgeKey[]; method: string }): void {
    const { swap } = target;
    const put = (value: string) => swap.reduce((text, key) => text.split(key.placeholder).join(key.value), value);
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !hopHeaders.has(name)) headers[name] = Array.isArray(value) ? value.map(put) : put(value);
    // The site named in the address is the site asked about, checked, and (for a key) the key's own.
    headers.host = target.url.host;
    const to = this.route({ host: target.host, address: target.address, port: target.port, secure: target.secure });
    const path = put(`${target.url.pathname}${target.url.search}`);
    const make = to.secure ? httpsRequest : httpRequest;
    const outgoing = make({ host: to.host, port: to.port, method: target.method, path, headers,
      ...(to.secure ? { servername: isIP(target.host) ? undefined : target.host } : {}) }, (answer) => {
      if (!swap.length) { response.writeHead(answer.statusCode ?? 502, cleanHeaders(answer.headers)); answer.pipe(response); return; }
      void this.cleaned(answer, swap).then(({ status, headers: out, body }) => response.writeHead(status, out).end(body))
        .catch(() => response.destroy());
    });
    outgoing.setTimeout(connectTimeoutMs * 4, () => outgoing.destroy());
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

/** A refusal a program reads as an ordinary answer, inside a plain tunnel it opened. */
function plainRefusal(reason: string): string {
  const body = `${reason}\n`;
  return `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
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
export function proxyEnvironment(address: { httpPort: number; socksPort: number }, secret: string): NodeJS.ProcessEnv {
  const http = `http://branch:${secret}@127.0.0.1:${address.httpPort}`, socks = `socks5h://branch:${secret}@127.0.0.1:${address.socksPort}`;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "", no_proxy: "" };
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY"]) { env[name] = http; env[name.toLowerCase()] = http; }
  env.ALL_PROXY = socks; env.all_proxy = socks;
  return env;
}

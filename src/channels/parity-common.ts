import { timingSafeEqual } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { handle } from "./email.js";
import { reconnectDelay } from "./ws-client.js";
import { MarkKeeper, type ChannelMark } from "./catch-up.js"; // mac6/bucket-16

/**
 * Pieces shared by the chat services added in wave mac3: a checked JSON call, a polling loop, a
 * line-based socket for the plain-text protocols (IRC, XMPP's stream, MQTT's bytes), and short
 * handles for ids the delivery ledger cannot hold.
 */

/** Compares two secrets without leaking how much of them matched. */
export function sameSecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
/** One header's value, whichever shape Node handed it over in. */
export function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name.toLowerCase()];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * One HTTP call that expects JSON back. The address may carry a key, so it never appears in an
 * error; a redirect is refused so the network settings checked on the way out still hold.
 */
export async function callJson(
  fetchImpl: typeof fetch, service: string, url: string, init: RequestInit & { json?: unknown; form?: Record<string, string> } = {},
): Promise<unknown> {
  const { json, form, headers, ...rest } = init;
  const body = json !== undefined ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : rest.body;
  const contentType = json !== undefined ? { "content-type": "application/json" }
    : form ? { "content-type": "application/x-www-form-urlencoded" } : {};
  const response = await fetchImpl(url, {
    ...rest, ...(body !== undefined ? { body } : {}),
    headers: { accept: "application/json", ...contentType, ...(headers as Record<string, string> | undefined) },
    redirect: "error", signal: rest.signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${service} refused the request (${response.status})`);
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return { text }; }
}

/** Ids longer than the delivery ledger allows get a stable short handle; the real one is remembered. */
export class ShortIds {
  private readonly full = new Map<string, string>();
  short(value: string, prefix: string): string {
    const shortened = handle(value, prefix);
    if (shortened !== value) {
      this.full.set(shortened, value);
      if (this.full.size > 1000) this.full.delete(this.full.keys().next().value!);
    }
    return shortened;
  }
  long(value: string): string { return this.full.get(value) ?? value; }
}

/**
 * A channel that asks the service "anything new?" on a timer. The first answer is only used to
 * learn where things stand, so a restart never replies to old messages. A failed poll waits longer
 * each time, and stopping ends the loop rather than leaving it retrying.
 */
export abstract class PollingChannel implements ChannelAdapter {
  abstract readonly kind: string;
  readonly id: string;
  maxTextLength = 3500;
  protected state: ChannelHealth = { state: "reconnecting", reason: "Connecting" };
  protected readonly ids = new ShortIds();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  constructor(id: string, protected readonly everyMs: number, protected readonly retryBaseMs = 1000) { this.id = id; }
  abstract botName(): string | null;
  /** Returns what arrived since the last call. `first` is true for the call that only takes stock. */
  protected abstract poll(first: boolean): Promise<InboundMessage[]>;
  abstract send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined>;
  /** Anything the service needs before the first poll, such as signing in. */
  protected async prepare(): Promise<void> { /* most services need nothing */ }
  // ---- mac6/bucket-16: catching up after a restart (src/channels/catch-up.ts) ----------------
  /** Where this service was read up to, kept across restarts. Null: take stock from now. */
  catchUp: ChannelMark | null = null;
  /** The place after the last poll, for services that can carry on from one. */
  protected placeMark(): string | null { return null; }
  /** Carries on from a saved place instead of taking stock. False when the service cannot. */
  protected resumeFrom(_mark: string): boolean { return false; }
  private resumeSaved(): boolean {
    const saved = this.catchUp?.load();
    return !!saved && this.resumeFrom(saved);
  }
  // ---- end mac6/bucket-16 ----------------------------------------------------------------------
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    let first = true;
    const keeper = new MarkKeeper(this.catchUp); // mac6/bucket-16
    for (let failures = 0; !this.stopping;) {
      try {
        if (first) { await this.prepare(); if (this.resumeSaved()) first = false; }
        const batch = await this.poll(first);
        first = false;
        failures = 0;
        this.state = { state: "connected" };
        const handling: Promise<unknown>[] = [];
        for (const message of batch) { if (this.stopping) return; handling.push(onMessage(message).catch(() => undefined)); }
        void keeper.after(this.placeMark(), handling);
      } catch (error) {
        if (this.stopping) return;
        failures++;
        this.state = { state: "reconnecting", reason: `Could not reach ${this.kind}: ${error instanceof Error ? error.message : String(error)}` };
      }
      await this.pause(failures ? reconnectDelay(failures, this.retryBaseMs) : this.everyMs);
    }
  }
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }
}

/** How a plain socket is opened. Tests hand in their own; the network check happens before this. */
export interface SocketTarget { host: string; port: number; tls: boolean; servername?: string }
export type SocketOpener = (target: SocketTarget) => Promise<Duplex>;
export const openSocket: SocketOpener = (target) => new Promise((resolve, reject) => {
  const onError = (error: Error) => reject(error);
  const socket: Socket = target.tls
    ? tlsConnect({ host: target.host, port: target.port, servername: target.servername ?? target.host }, () => resolve(socket))
    : tcpConnect({ host: target.host, port: target.port }, () => resolve(socket));
  socket.once("error", onError);
  socket.setTimeout(30000, () => socket.destroy(new Error("The chat server did not answer in time")));
  socket.once("connect", () => socket.setTimeout(0));
  socket.once("secureConnect", () => socket.setTimeout(0));
});

/** Splits a socket's bytes into lines and hands each one over, without its line ending. */
export function readLines(socket: Duplex, onLine: (line: string) => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > 1 << 20) pending = "";
    let at: number;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, "");
      pending = pending.slice(at + 1);
      try { onLine(line); } catch { /* one bad line must not take the connection down */ }
    }
  });
}

/** Splits a reply into lines no longer than `limit`, for protocols that cannot carry a newline. */
export function lineChunks(text: string, limit: number): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let rest = line.trim();
    if (!rest) continue;
    while (rest.length > limit) {
      const cut = rest.lastIndexOf(" ", limit) > limit / 2 ? rest.lastIndexOf(" ", limit) : limit;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out.length ? out : [" "];
}

/** What a service's builder is handed: its saved settings are parsed by its own schema first. */
export interface ParityDeps {
  /** The channel id the owner chose. */
  id: string;
  /** A named secret: an environment variable of that name first, then the default project's locker. */
  secret(name: string): Promise<string>;
  /** A fetch that checks every address against the owner's network settings first. */
  fetch: typeof fetch;
  /** Refuses an address the network settings do not allow. Call it before opening a raw socket. */
  assertAllowed(url: URL, what: string): Promise<void>;
  /** A WebSocket opener that has already checked the address. */
  connectWs: import("./ws-client.js").WebSocketConnect;
  /** Opens a plain or TLS socket. It does not check anything: call `assertAllowed` first. */
  openSocket: SocketOpener;
  platform: NodeJS.Platform;
}
/**
 * One chat service added in wave mac3. `settings` is the strict shape of what the owner writes in
 * the connections file besides `type`, `id`, `activation`, `pairing` and `allowlist`.
 */
export interface ParityService {
  kind: string;
  name: string;
  /** The service's own documentation for the API used here. */
  docs: string;
  /** What the owner has to find and save, in their words. */
  needs: string[];
  /** How people reach the assistant: "polls" asks the service, "socket" holds a connection open,
   * "posted" means the service posts to this computer's web address, "send only" cannot answer. */
  receives: "polls" | "socket" | "posted" | "program" | "send only";
  /** True for a service only this operating system can reach. */
  platforms?: NodeJS.Platform[];
  settings: import("zod").ZodType<Record<string, unknown>>;
  build(settings: Record<string, unknown>, deps: ParityDeps): Promise<ChannelAdapter>;
}
/** Writes a service down with its settings typed, then hands it over in the shape the list holds. */
export function defineService<S extends import("zod").ZodObject>(service: Omit<ParityService, "settings" | "build"> & {
  settings: S;
  build(settings: import("zod").infer<S>, deps: ParityDeps): Promise<ChannelAdapter>;
}): ParityService {
  return service as unknown as ParityService;
}
/** A saved secret's name as the connections file writes it. */
export const secretName = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A service that can be written to but cannot hand anything back (push notification services). */
export abstract class SendOnlyChannel implements ChannelAdapter {
  abstract readonly kind: string;
  abstract readonly maxTextLength: number;
  constructor(readonly id: string, private readonly label: string) {}
  botName(): string | null { return null; }
  health(): ChannelHealth { return { state: "connected", reason: `${this.label} can be sent to but cannot hand messages back` }; }
  async start(): Promise<void> { /* nothing to listen to */ }
  async stop(): Promise<void> { /* nothing is held open */ }
  abstract send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined>;
}

/**
 * Integration review (channels-parity): a signed post can be copied and posted again later. The
 * already-seen list forgets after two minutes, so a service that signs the time of a post also has
 * that time checked here, and every post taken in is remembered for as long as its time would still
 * pass. A signed time in seconds or milliseconds is accepted, since not every service says which.
 */
export class FreshPosts {
  private readonly taken = new Map<string, number>();
  constructor(private readonly windowMs = 5 * 60_000, private readonly now: () => number = Date.now) {}
  /** Throws for a post from outside the window, or for a copy of one already taken in. */
  admit(signedAt: string | number, fingerprint: string, service: string): void {
    const now = this.now();
    const value = typeof signedAt === "number" ? signedAt : /^\d{1,20}$/.test(signedAt.trim()) ? Number(signedAt) : Number.NaN;
    const ms = value < 1e11 ? value * 1000 : value;
    if (!Number.isFinite(ms) || Math.abs(now - ms) > this.windowMs) throw new Error(`The ${service} post is too old or has no time on it`);
    for (const [key, until] of this.taken) if (until <= now) this.taken.delete(key);
    if (this.taken.has(fingerprint)) throw new Error(`The ${service} post was already taken in`);
    this.taken.set(fingerprint, now + 2 * this.windowMs);
    if (this.taken.size > 10_000) this.taken.delete(this.taken.keys().next().value!);
  }
}

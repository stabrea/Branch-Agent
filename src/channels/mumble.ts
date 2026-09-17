import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, secretName, ShortIds, type SocketOpener } from "./parity-common.js";
import {
  decodeFields, encodeFields, frame, frameReader, MumbleType, numberField, numberList, textField, type Fields,
} from "./mumble-proto.js";

/**
 * Mumble text chat, over the server's TLS control channel (https://mumble-protocol.readthedocs.io).
 * Branch signs in as an ordinary user, keeps the connection alive with a Ping every fifteen
 * seconds, and reads the people and channels the server announces so a reply reaches the right
 * one. A message sent to the assistant alone is a direct chat; a message in a channel is answered
 * when it contains the assistant's name. Mumble carries text as HTML, so what arrives is stripped
 * to plain words and what goes out is escaped.
 *
 * Most Mumble servers use a certificate they signed themselves. The certificate is still checked by
 * default: the owner either saves the server's SHA-256 fingerprint (pinning) or explicitly allows
 * self-signed certificates. The message layout was checked against OpenFang's mumble adapter
 * (MIT/Apache-2.0).
 */
export type MumbleOpen = () => Promise<Duplex>;
export interface MumbleOptions {
  id: string;
  open: MumbleOpen;
  username: string;
  password?: string;
  passwordName?: string;
  /** A channel to move into after signing in, by name. */
  channel?: string;
  pingMs?: number;
  retryBaseMs?: number;
}
interface Person { name: string; who: string }

/** Why a server certificate is refused, or null when it is accepted. */
export function refusePeer(peer: { authorized: boolean; error?: string | undefined; fingerprint256?: string | undefined },
  rules: { allowSelfSigned: boolean; fingerprint?: string | undefined }): string | null {
  const plain = (value: string) => value.replace(/[^a-f0-9]/gi, "").toLowerCase();
  if (rules.fingerprint) {
    return peer.fingerprint256 && plain(peer.fingerprint256) === plain(rules.fingerprint) ? null
      : "The Mumble server's certificate does not match the saved fingerprint";
  }
  if (peer.authorized) return null;
  if (rules.allowSelfSigned && /SELF_SIGNED/.test(peer.error ?? "")) return null;
  return "The Mumble server's certificate is not trusted. Save its SHA-256 fingerprint as certificateFingerprint, or allow self-signed certificates";
}

/** A TLS connection that checks the certificate by fingerprint or accepts a self-signed one on request. */
export function pinnedOpener(host: string, port: number, rules: { allowSelfSigned: boolean; fingerprint?: string | undefined }): MumbleOpen {
  return () => new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const refused = refusePeer({ authorized: socket.authorized, error: socket.authorizationError?.toString(),
        fingerprint256: socket.getPeerCertificate().fingerprint256 }, rules);
      if (refused) { socket.destroy(); reject(new Error(refused)); return; }
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
    socket.setTimeout(30000, () => socket.destroy(new Error("The Mumble server did not answer in time")));
  });
}

/** Mumble text is HTML: tags go, line breaks stay, the common entities are read back. */
export function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}
export function textToHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>");
}
const rejectReasons: Record<number, string> = {
  1: "The Mumble server needs a newer client", 2: "The Mumble server did not accept the username",
  3: "The Mumble server refused the password", 4: "The Mumble server refused the password",
  5: "That username is already in use on the Mumble server", 6: "The Mumble server is full",
  7: "The Mumble server needs a client certificate",
};

export class MumbleChannel implements ChannelAdapter {
  readonly kind = "mumble";
  readonly id: string;
  readonly maxTextLength = 3500;
  private socket: Duplex | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to the Mumble server" };
  private session: number | null = null;
  private refused: string | null = null;
  private readonly people = new Map<number, Person>();
  private readonly channels = new Map<string, number>();
  private readonly ids = new ShortIds();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private counter = 0;
  constructor(private readonly options: MumbleOptions) { this.id = options.id; }
  botName(): string | null { return this.options.username; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.destroy();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        await this.live(onMessage);
        if (this.state.state === "connected") attempt = 0;
        this.state = this.refused ? { state: "needs attention", reason: this.refused }
          : { state: "reconnecting", reason: "The Mumble server closed the connection; reconnecting" };
      } catch (error) {
        this.state = { state: /certificate/.test(String(error)) ? "needs attention" : "reconnecting",
          reason: error instanceof Error ? error.message : String(error) };
      }
      if (this.timer) clearInterval(this.timer);
      this.socket = null;
      this.session = null;
      this.people.clear();
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** One connection, from the version exchange to close. */
  private async live(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.refused = null;
    const socket = await this.options.open();
    this.socket = socket;
    const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.once("error", () => resolve()); });
    const read = frameReader((type, body) => {
      try { this.onFrame(type, decodeFields(body), onMessage); } catch { /* one bad message must not end the connection */ }
    });
    socket.on("data", (chunk: Buffer) => { try { read(chunk); } catch { socket.destroy(); } });
    this.write(MumbleType.Version, encodeFields([[1, 0x010500], [2, "Branch Agent"], [3, process.platform], [5, (1n << 48n) | (5n << 32n)]]));
    this.write(MumbleType.Authenticate, encodeFields([[1, this.options.username], [2, this.options.password], [5, true]]));
    this.timer = setInterval(() => this.write(MumbleType.Ping, encodeFields([[1, BigInt(Date.now())]])), this.options.pingMs ?? 15000);
    this.timer.unref();
    await closed;
  }
  private write(type: number, body: Buffer): void {
    if (this.socket?.writable) this.socket.write(frame(type, body));
  }
  private onFrame(type: number, fields: Fields, onMessage: (message: InboundMessage) => Promise<void>): void {
    if (type === MumbleType.ServerSync) return this.synced(fields);
    if (type === MumbleType.ChannelState) {
      const id = numberField(fields, 1), name = textField(fields, 3);
      if (id !== undefined && name !== undefined) this.channels.set(name, id);
      return;
    }
    if (type === MumbleType.UserState) return this.userState(fields);
    if (type === MumbleType.UserRemove) { const session = numberField(fields, 1); if (session !== undefined) this.people.delete(session); return; }
    if (type === MumbleType.Reject) {
      const kind = numberField(fields, 1) ?? 0;
      const where = kind === 3 || kind === 4 ? `. Save the right one as ${this.options.passwordName ?? "a secret"}` : "";
      this.refused = `${rejectReasons[kind] ?? "The Mumble server refused the sign-in"}${where}`;
      this.socket?.destroy();
      return;
    }
    if (type !== MumbleType.TextMessage) return;
    const inbound = this.inbound(fields);
    if (inbound) void onMessage(inbound).catch(() => undefined);
  }
  private synced(fields: Fields): void {
    this.session = numberField(fields, 1) ?? null;
    this.state = { state: "connected" };
    const channel = this.options.channel ? this.channels.get(this.options.channel) : undefined;
    if (this.session !== null && channel !== undefined) this.write(MumbleType.UserState, encodeFields([[1, this.session], [5, channel]]));
  }
  /** Remembers who is connected, and by what that person can be recognised next time. */
  private userState(fields: Fields): void {
    const session = numberField(fields, 1);
    if (session === undefined) return;
    const known = this.people.get(session);
    const name = textField(fields, 3) ?? known?.name;
    if (!name) return;
    const userId = numberField(fields, 4), hash = textField(fields, 21);
    // A registered account or a certificate cannot be taken over; a guest is only known by name.
    const who = userId !== undefined ? `mumble-id:${userId}` : hash ? `mumble-cert:${hash}` : known?.who ?? `mumble-guest:${name}`;
    this.people.set(session, { name, who });
  }
  private inbound(fields: Fields): InboundMessage | null {
    const actor = numberField(fields, 1);
    const person = actor === undefined ? undefined : this.people.get(actor);
    if (actor === undefined || actor === this.session || !person || person.name === this.options.username) return null;
    const text = htmlToText(textField(fields, 5) ?? "");
    if (!text) return null;
    const toMe = this.session !== null && numberList(fields, 2).includes(this.session);
    const channel = numberList(fields, 3)[0];
    if (!toMe && channel === undefined) return null;
    const me = this.options.username.toLowerCase();
    const named = text.toLowerCase().includes(me);
    const words = named ? text.replace(new RegExp(this.options.username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "").replace(/^[\s,:@]+/, "").trim() : text;
    return {
      channel: this.id, chatKind: toMe ? "direct" : "group",
      chatId: this.ids.short(toMe ? `user:${person.who}` : `channel:${channel}`, "chat"),
      ...(toMe ? {} : { chatTitle: `Mumble channel ${channel}` }),
      senderId: this.ids.short(person.who, "who"), senderName: person.name,
      text: words || text, addressed: toMe || named, messageId: `${Date.now()}-${++this.counter}`,
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const target = this.ids.long(chatId);
    const message = textToHtml(text.slice(0, this.maxTextLength));
    if (!this.socket || this.session === null) throw new Error("The Mumble server is not connected, so the message could not be sent");
    if (target.startsWith("channel:")) {
      const channel = Number(target.slice(8));
      if (!Number.isInteger(channel) || channel < 0) throw new Error("That is not a Mumble channel");
      this.write(MumbleType.TextMessage, encodeFields([[3, channel], [5, message]]));
      return undefined;
    }
    const who = target.startsWith("user:") ? target.slice(5) : "";
    const session = [...this.people].find(([, person]) => person.who === who)?.[0];
    if (session === undefined) throw new Error("That person is not connected to the Mumble server right now");
    this.write(MumbleType.TextMessage, encodeFields([[2, session], [5, message]]));
    return undefined;
  }
}

const fingerprint = z.string().regex(/^(?:[A-Fa-f0-9]{2}:?){31}[A-Fa-f0-9]{2}$/);
export const mumbleService = defineService({
  kind: "mumble", name: "Mumble", docs: "https://mumble-protocol.readthedocs.io/en/latest/",
  needs: ["The Mumble server's name and port", "A username for the assistant",
    "The server password, saved as a secret, if the server has one",
    "The server certificate's SHA-256 fingerprint, if the server signed its own certificate"],
  receives: "socket",
  settings: z.object({
    server: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).default(64738),
    username: z.string().min(1).max(64).regex(/^[^\s<>&"]+$/),
    channel: z.string().min(1).max(100).optional(),
    passwordSecret: z.string().regex(secretName).optional(),
    certificateFingerprint: fingerprint.optional(),
    allowSelfSigned: z.boolean().default(false),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(`https://${settings.server}`), "Mumble server");
    const checked = settings.allowSelfSigned || !!settings.certificateFingerprint;
    const open: MumbleOpen = checked
      ? pinnedOpener(settings.server, settings.port, { allowSelfSigned: settings.allowSelfSigned, fingerprint: settings.certificateFingerprint })
      : openerFrom(deps.openSocket, settings.server, settings.port);
    return new MumbleChannel({
      id: deps.id, open, username: settings.username,
      ...(settings.channel ? { channel: settings.channel } : {}),
      ...(settings.passwordSecret ? { password: await deps.secret(settings.passwordSecret), passwordName: settings.passwordSecret } : {}),
    });
  },
});

/** The ordinary, fully verified TLS connection. */
export function openerFrom(open: SocketOpener, host: string, port: number): MumbleOpen {
  return () => open({ host, port, tls: true });
}

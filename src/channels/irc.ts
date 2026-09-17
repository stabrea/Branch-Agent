import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import type { WebSocketConnect } from "./ws-client.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, lineChunks, readLines, secretName, ShortIds, type SocketOpener } from "./parity-common.js";

/**
 * IRC (RFC 1459 / 2812 with IRCv3 SASL), over a plain or TLS socket, and Twitch chat, which is IRC
 * carried inside a WebSocket. Written from the protocol documents; the line parsing follows the
 * message grammar in RFC 2812 section 2.3.1.
 *
 * A channel message is answered when it starts with the assistant's nick; a private message always
 * is. IRC cannot carry a newline, so a reply goes out one line at a time, spaced so the server's
 * flood protection does not disconnect the assistant.
 */
export interface IrcLine { tags: Record<string, string>; prefix: string; command: string; params: string[] }

/** Reads one IRC line into its parts. Returns null for an empty line. */
export function parseIrcLine(raw: string): IrcLine | null {
  let rest = raw.trim();
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    for (const part of rest.slice(1, end).split(";")) {
      const [key, value = ""] = part.split("=");
      if (key) tags[key] = value.replace(/\\s/g, " ").replace(/\\:/g, ";").replace(/\\\\/g, "\\");
    }
    rest = rest.slice(end + 1).trimStart();
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1).trimStart();
  }
  const trailingAt = rest.indexOf(" :");
  const head = trailingAt >= 0 ? rest.slice(0, trailingAt) : rest;
  const params = head.split(" ").filter(Boolean);
  const command = (params.shift() ?? "").toUpperCase();
  if (trailingAt >= 0) params.push(rest.slice(trailingAt + 2));
  return { tags, prefix, command, params };
}

/**
 * mac6/bucket-16: who sent a line. A sender signed in to the network's accounts (IRCv3 account-tag)
 * is `account:<name>`, which nobody else can take by changing nick; anyone else is known only by nick.
 */
export function ircAccount(tag: string | undefined, nick: string): string {
  return tag && tag !== "*" && !/[\s\0]/.test(tag) ? `account:${tag}` : nick;
}

/** A carriage return or newline in user text would start a second command, so both are removed. */
function clean(value: string): string { return value.replace(/[\r\n\0]/g, " "); }

/** One open connection, whichever way it travels. */
export interface IrcLink { write(line: string): void; close(): void; closed: Promise<void> }
export type IrcDial = (onLine: (line: string) => void) => Promise<IrcLink>;

/** A plain or TLS socket to an IRC server. */
export function socketDial(open: SocketOpener, host: string, port: number, tls: boolean): IrcDial {
  return async (onLine) => {
    const socket = await open({ host, port, tls });
    readLines(socket, onLine);
    const closed = new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.once("error", () => resolve()); });
    return { write: (line) => { if (socket.writable) socket.write(`${line}\r\n`); }, close: () => socket.destroy(), closed };
  };
}
/** Twitch sends several IRC lines inside one WebSocket message. */
export function webSocketDial(connect: WebSocketConnect, address: string): IrcDial {
  return async (onLine) => {
    const socket = await connect(address, { onMessage: (text) => { for (const line of text.split(/\r?\n/)) if (line) onLine(line); } });
    return { write: (line) => socket.send(line), close: () => socket.close(), closed: socket.closed };
  };
}

export interface IrcOptions {
  id: string;
  kind?: string;
  dial: IrcDial;
  nick: string;
  /** Channels to join, with their leading #. */
  channels: string[];
  realname?: string;
  /** Sent with SASL PLAIN when given (or as the PASS line for Twitch). */
  password?: string;
  /** Twitch: send PASS instead of SASL and ask for the tags that carry user ids. */
  twitch?: boolean;
  lineLength?: number;
  lineGapMs?: number;
  retryBaseMs?: number;
}

export class IrcChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind: string;
  readonly maxTextLength = 2000;
  private link: IrcLink | null = null;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to the chat server" };
  private stopping = false;
  private loop: Promise<void> | null = null;
  private nick: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly ids = new ShortIds();
  private counter = 0;
  /** mac6/bucket-16 integration: account tags are read only after the server agreed to send them. */
  private accountTags = false;
  constructor(private readonly options: IrcOptions) {
    this.id = options.id;
    this.kind = options.kind ?? "irc";
    this.nick = options.nick;
  }
  botName(): string | null { return this.nick; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.link) { this.link.write("QUIT :Goodbye"); this.link.close(); }
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const link = await this.options.dial((line) => this.onLine(line, onMessage));
        this.link = link;
        this.greet(link);
        await link.closed;
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping) this.state = { state: "reconnecting", reason: "The chat server closed the connection" };
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Could not reach the chat server: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.link = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** Introduces the assistant. SASL runs first when there is a password, so no channel sees it unsigned. */
  private greet(link: IrcLink): void {
    const { password, twitch } = this.options;
    this.accountTags = false;
    if (twitch) {
      link.write("CAP REQ :twitch.tv/tags twitch.tv/commands");
      if (password) link.write(`PASS ${password.startsWith("oauth:") ? password : `oauth:${password}`}`);
    } else {
      // mac6/bucket-16: IRCv3 account-tag names the signed-in account behind each message.
      link.write("CAP REQ :account-tag");
      if (password) link.write("CAP REQ :sasl");
    }
    link.write(`NICK ${this.nick}`);
    if (!twitch) link.write(`USER ${this.nick} 0 * :${clean(this.options.realname ?? "Branch assistant")}`);
  }
  private onLine(raw: string, onMessage: (message: InboundMessage) => Promise<void>): void {
    const line = parseIrcLine(raw);
    const link = this.link;
    if (!line || !link) return;
    switch (line.command) {
      case "PING": link.write(`PONG :${line.params.at(-1) ?? ""}`); return;
      case "CAP": return this.onCap(line, link);
      case "AUTHENTICATE": return this.onAuthenticate(line, link);
      case "903": link.write("CAP END"); return;
      case "904": case "905":
        this.state = { state: "needs attention", reason: "The chat server did not accept the saved password" };
        link.write("CAP END"); return;
      case "001":
        this.nick = line.params[0] ?? this.nick;
        this.state = { state: "connected" };
        for (const name of this.options.channels) link.write(`JOIN ${clean(name)}`);
        return;
      case "433": this.nick = `${this.nick}_`; link.write(`NICK ${this.nick}`); return;
      case "PRIVMSG": { const inbound = this.inbound(line); if (inbound) void onMessage(inbound).catch(() => undefined); return; }
      default: return;
    }
  }
  private onCap(line: IrcLine, link: IrcLink): void {
    const verb = line.params[1]?.toUpperCase();
    if (this.options.twitch || (verb !== "ACK" && verb !== "NAK")) return;
    const caps = (line.params.at(-1) ?? "").toLowerCase().split(/\s+/);
    if (verb === "ACK" && caps.includes("account-tag")) this.accountTags = true;
    if (caps.includes("sasl")) { link.write(verb === "ACK" ? "AUTHENTICATE PLAIN" : "CAP END"); return; }
    // mac6/bucket-16: the answer about account-tag; without a password nothing else is waiting.
    if (caps.includes("account-tag")) { if (!this.options.password) link.write("CAP END"); return; }
    if (verb === "NAK") link.write("CAP END");
  }
  private onAuthenticate(line: IrcLine, link: IrcLink): void {
    if (line.params[0] !== "+" || !this.options.password) return;
    const token = Buffer.from(`${this.options.nick}\0${this.options.nick}\0${this.options.password}`).toString("base64");
    for (let at = 0; at < token.length; at += 400) link.write(`AUTHENTICATE ${token.slice(at, at + 400)}`);
    if (token.length % 400 === 0) link.write("AUTHENTICATE +");
  }
  private inbound(line: IrcLine): InboundMessage | null {
    const [target = "", text = ""] = line.params;
    const nick = line.prefix.split("!")[0] ?? "";
    if (!nick || !text || nick.toLowerCase() === this.nick.toLowerCase()) return null;
    if (text.startsWith("")) return null; // CTCP (actions, version requests) is not conversation.
    const direct = !/^[#&!+]/.test(target);
    const lower = text.toLowerCase(), me = this.nick.toLowerCase();
    const named = lower.startsWith(`${me}:`) || lower.startsWith(`${me},`) || lower.startsWith(`@${me}`);
    const words = named ? text.slice(text.search(/[:,\s]/) + 1).trim() : text;
    const account = line.tags["user-id"] ? `twitch:${line.tags["user-id"]}` : ircAccount(this.accountTags ? line.tags.account : undefined, nick);
    return {
      channel: this.id, chatId: this.ids.short(direct ? nick : target, "chat"), chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: target }),
      senderId: this.ids.short(account, "who"), senderName: line.tags["display-name"] || nick,
      text: words || text, addressed: direct || named || lower.includes(me),
      messageId: line.tags.id ?? `${Date.now()}-${++this.counter}`,
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const target = clean(this.ids.long(chatId));
    const lines = lineChunks(text, this.options.lineLength ?? 400).slice(0, 40);
    const gap = this.options.lineGapMs ?? 700;
    const sending = this.queue.then(async () => {
      for (const [index, line] of lines.entries()) {
        if (!this.link) throw new Error("The chat server is not connected, so the message could not be sent");
        this.link.write(`PRIVMSG ${target} :${clean(line)}`);
        if (index < lines.length - 1) await new Promise((resolve) => setTimeout(resolve, gap));
      }
    });
    this.queue = sending.catch(() => undefined);
    await sending;
    return undefined;
  }
}

const channelName = z.string().regex(/^[#&][^\s,\x07]{1,49}$/);
export const ircService = defineService({
  kind: "irc", name: "IRC", docs: "https://www.rfc-editor.org/rfc/rfc2812",
  needs: ["The server name and port", "A nick for the assistant, and the channels it should join",
    "The account password, saved as a secret, if the nick is registered"],
  receives: "socket",
  settings: z.object({
    server: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).default(6697),
    tls: z.boolean().default(true),
    nick: z.string().regex(/^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,29}$/),
    channels: z.array(channelName).max(20).default([]),
    passwordSecret: z.string().regex(secretName).optional(),
  }).strict(),
  async build(settings, deps) {
    // A raw socket has no fetch to guard it, so the server is checked by name as the mail servers are.
    await deps.assertAllowed(new URL(`https://${settings.server}`), "IRC server");
    return new IrcChannel({
      id: deps.id, nick: settings.nick, channels: settings.channels,
      dial: socketDial(deps.openSocket, settings.server, settings.port, settings.tls),
      ...(settings.passwordSecret ? { password: await deps.secret(settings.passwordSecret) } : {}),
    });
  },
});

export const twitchService = defineService({
  kind: "twitch", name: "Twitch chat", docs: "https://dev.twitch.tv/docs/chat/irc/",
  needs: ["The assistant's Twitch login name", "A user access token with the chat:read and chat:edit scopes, saved as a secret",
    "The channels to join"],
  receives: "socket",
  settings: z.object({
    login: z.string().regex(/^[a-z0-9_]{3,25}$/),
    channels: z.array(z.string().regex(/^#?[a-z0-9_]{3,25}$/)).min(1).max(20),
    tokenSecret: z.string().regex(secretName).default("TWITCH_CHAT_TOKEN"),
    address: z.string().regex(/^wss?:\/\//).default("wss://irc-ws.chat.twitch.tv:443"),
  }).strict(),
  async build(settings, deps) {
    return new IrcChannel({
      id: deps.id, kind: "twitch", nick: settings.login, twitch: true, lineLength: 450, lineGapMs: 1600,
      channels: settings.channels.map((name) => (name.startsWith("#") ? name : `#${name}`)),
      password: await deps.secret(settings.tokenSecret),
      dial: webSocketDial(deps.connectWs, settings.address),
    });
  },
});

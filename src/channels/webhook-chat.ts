import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { handle } from "./email.js";
import { type ChannelEntry, type SignatureScheme, type VerifyScheme } from "./catalog.js";
import { fill, fillJson, readPath } from "../json-template.js";

/**
 * One adapter for every team-chat service that works the same way: an address the owner pastes in
 * to send to, and an address of ours the service posts to when somebody writes. Which headers,
 * which JSON shape and which signature belong to which service is read out of `data/channels.json`;
 * nothing here knows the name of any service.
 *
 * Everything else a channel needs — pairing codes, the allowlist, answering only when addressed,
 * splitting a long reply, retrying, quiet hours, and the "reply y / a / n" approval fallback — is
 * the router's and the delivery ledger's work and is inherited unchanged.
 */
export interface WebhookChatOptions {
  id: string;
  entry: ChannelEntry;
  /** The incoming webhook address, for the services that send that way. Never logged: it is a key. */
  webhookUrl?: string;
  /** The access token, for the services with a proper API. */
  token?: string;
  /** The shared word or signing key the service proves itself with; falls back to the token. */
  secret?: string;
  /** The service's own address, for the services hosted per company. */
  apiBase?: string;
  /** What the bot is called, so a mention of it can be recognised in a group. */
  botName?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
/** What the service posted, once it has been proved genuine. */
export type ReceiveResult = { accepted: number; challenge?: undefined } | { accepted: 0; challenge: string };

export class WebhookChatAdapter implements ChannelAdapter {
  readonly kind: string;
  readonly id: string;
  readonly maxTextLength: number;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private state: ChannelHealth = { state: "connected" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  /** Chat and message ids can be longer than the ledger allows, so long ones get a short handle. */
  private readonly longIds = new Map<string, string>();
  constructor(private readonly options: WebhookChatOptions) {
    this.id = options.id;
    this.kind = options.entry.id;
    this.maxTextLength = options.entry.maxTextLength;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }
  botName(): string | null { return this.options.botName ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    this.state = this.options.entry.receive
      ? { state: "connected", reason: `Waiting for ${this.options.entry.name} to post messages to this computer's web address` }
      : { state: "connected", reason: `${this.options.entry.name} can be sent to but cannot hand messages back` };
  }
  async stop(): Promise<void> { this.deliver = null; }

  /**
   * Handles one post from the service. The signature is checked over the exact bytes before the
   * JSON is believed; an unsigned or wrongly signed post is refused and nothing is read from it.
   */
  async receive(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<ReceiveResult> {
    const { entry } = this.options;
    const receive = entry.receive;
    if (!receive) throw new Error(`${entry.name} cannot hand messages back to this computer`);
    const body: unknown = JSON.parse(raw.toString("utf8"));
    const check = receive.challenge;
    if (check && String(readPath(body, check.whenField) ?? "") === check.whenValue) {
      this.assertGenuine({ kind: "body-token", field: check.tokenField ?? "token" }, raw, headers, body);
      return { accepted: 0, challenge: String(readPath(body, check.echoField) ?? "") };
    }
    this.assertGenuine(receive.verify, raw, headers, body);
    const events = receive.eventsPath ? readPath(body, receive.eventsPath) : [body];
    let accepted = 0;
    for (const event of Array.isArray(events) ? events.slice(0, 20) : []) {
      const inbound = this.inbound(event);
      if (!inbound || !this.deliver) continue;
      accepted++;
      await this.deliver(inbound).catch(() => undefined);
    }
    return { accepted };
  }

  /** Turns one event into a message the router can answer, or null when it is not one. */
  private inbound(event: unknown): InboundMessage | null {
    const { entry } = this.options;
    const receive = entry.receive!;
    const { fields } = receive;
    const kindOf = (path: string | undefined) => (path ? String(readPath(event, path) ?? "") : "");
    if (receive.messageTypes.length && !receive.messageTypes.includes(kindOf(fields.eventType))) return null;
    const text = this.textOf(event);
    const chatId = String(readPath(event, fields.chatId) ?? "");
    const senderId = String(readPath(event, fields.senderId) ?? "");
    if (!text || !chatId || !senderId) return null;
    const kindValue = kindOf(fields.chatKind);
    const chatKind = !kindValue ? receive.defaultChatKind
      : receive.groupValues.includes(kindValue) ? "group" : "direct";
    const mention = this.options.botName ? fill(entry.mention, { botName: this.options.botName }) : "";
    // Without a bot name there is nothing to look for, so a group message counts as addressed
    // rather than being dropped in silence.
    const addressed = chatKind === "direct" || !mention || text.includes(mention);
    const title = fields.chatTitle ? String(readPath(event, fields.chatTitle) ?? "") : "";
    return {
      channel: this.id, chatId: this.short(chatId, "chat"), chatKind,
      ...(chatKind === "group" ? { chatTitle: title || chatId } : {}),
      senderId: this.short(senderId, "who"),
      senderName: (fields.senderName ? String(readPath(event, fields.senderName) ?? "") : "") || senderId,
      text: (mention ? text.split(mention).join(" ").replace(/[ 	]{2,}/g, " ") : text).trim() || text,
      addressed, messageId: this.short(String(readPath(event, fields.messageId) ?? ""), "msg"),
    };
  }
  /** The words, out of a plain field or out of the little JSON document some services wrap them in. */
  private textOf(event: unknown): string {
    const receive = this.options.entry.receive!;
    const raw = readPath(event, receive.fields.text);
    if (typeof raw !== "string") return "";
    if (!receive.textInsideJson) return raw;
    try {
      const inner: unknown = JSON.parse(raw);
      const value = inner && typeof inner === "object" ? (inner as Record<string, unknown>)[receive.textInsideJson] : undefined;
      return typeof value === "string" ? value : "";
    } catch { return ""; }
  }
  /** Shortens an id the ledger could not hold, remembering the real one so a reply can reach it. */
  private short(value: string, prefix: string): string {
    const shortened = handle(value, prefix);
    if (shortened !== value) this.longIds.set(shortened, value);
    if (this.longIds.size > 500) this.longIds.delete(this.longIds.keys().next().value!);
    return shortened;
  }
  private full(value: string): string { return this.longIds.get(value) ?? value; }

  /** Refuses a post that is not signed the way this service's row says it must be. */
  private assertGenuine(verify: VerifyScheme, raw: Buffer, headers: Record<string, string | string[] | undefined>, body: unknown): void {
    const name = this.options.entry.name;
    const header = (key: string) => { const value = headers[key.toLowerCase()]; return (Array.isArray(value) ? value[0] : value) ?? ""; };
    const secret = this.options.secret || this.options.token || "";
    if (!secret) throw new Error(`No shared secret is saved for ${name}, so its messages cannot be trusted`);
    if (verify.kind === "header-token") {
      if (!sameSecret(header(verify.header), secret)) throw new Error(`The message was not sent by ${name}`);
      return;
    }
    if (verify.kind === "body-token") {
      if (!sameSecret(String(readPath(body, verify.field) ?? ""), secret)) throw new Error(`The message was not sent by ${name}`);
      return;
    }
    const timestamp = verify.timestampHeader ? header(verify.timestampHeader) : "";
    if (verify.timestampHeader) {
      const sent = Number(timestamp);
      const seconds = !Number.isFinite(sent) ? NaN : sent > 1e11 ? sent / 1000 : sent;
      if (!Number.isFinite(seconds) || Math.abs(this.now() / 1000 - seconds) > verify.toleranceSeconds)
        throw new Error(`That ${name} message is too old to be acted on`);
    }
    const supplied = header(verify.header);
    const expected = verify.prefix + sign(verify.scheme, secret, raw, timestamp);
    if (!sameSecret(supplied, expected)) throw new Error(`The message was not signed by ${name}`);
  }

  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const { entry } = this.options;
    const values = {
      webhookUrl: this.options.webhookUrl ?? "", token: this.options.token ?? "",
      secret: this.options.secret ?? "", apiBase: (this.options.apiBase ?? "").replace(/\/$/, ""),
      botName: this.options.botName ?? "", chatId: this.full(chatId),
      text: text.slice(0, entry.maxTextLength), replyTo: replyToMessageId ? this.full(replyToMessageId) : "",
    };
    const address = new URL(fill(entry.send.url, values));
    if (entry.send.signQuery) this.signAddress(address, entry.send.signQuery);
    const filled = fillJson(entry.send.body, values) as Record<string, unknown>;
    const json = entry.send.encoding === "json";
    const response = await this.fetch(address.href, {
      method: "POST",
      headers: {
        ...(json ? {} : { "content-type": "application/x-www-form-urlencoded" }),
        ...Object.fromEntries(Object.entries(entry.send.headers).map(([key, value]) => [key, fill(value, values)])),
      },
      body: json ? JSON.stringify(filled) : new URLSearchParams(Object.entries(filled).map(([key, value]) => [key, String(value)])).toString(),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
    // The address holds the key for several of these services, so it never appears in an error.
    if (!response.ok) throw new Error(`${entry.name} refused the message (${response.status})`);
    if (!entry.send.messageIdPath) return undefined;
    const answered: unknown = await response.json().catch(() => undefined);
    const id = readPath(answered, entry.send.messageIdPath);
    return id === undefined ? undefined : this.short(String(id), "msg");
  }
  /** Signs the address itself, for the services that put the proof in the query rather than a header. */
  private signAddress(address: URL, config: NonNullable<ChannelEntry["send"]["signQuery"]>): void {
    const stamp = String(config.milliseconds ? this.now() : Math.floor(this.now() / 1000));
    address.searchParams.set(config.timestampParam, stamp);
    address.searchParams.set(config.param, sign(config.scheme, this.options.secret || this.options.token || "", Buffer.alloc(0), stamp));
  }
}

/** The signature this scheme asks for, written the way the service writes it down. */
export function sign(scheme: SignatureScheme, secret: string, body: Buffer, timestamp: string): string {
  const key = scheme.keyEncoding === "base64" ? Buffer.from(secret, "base64") : Buffer.from(secret, "utf8");
  const payload = scheme.signs === "body" ? body
    : scheme.signs === "timestamp-body" ? Buffer.concat([Buffer.from(`${timestamp}\n`, "utf8"), body])
      : Buffer.from(`${timestamp}\n${secret}`, "utf8");
  return createHmac(scheme.algorithm, key).update(payload).digest(scheme.encoding);
}
/** Compares two secrets without leaking how much of them matched. */
function sameSecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

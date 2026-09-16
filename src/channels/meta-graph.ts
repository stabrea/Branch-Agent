import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";

/**
 * The pieces every Meta service shares: the one-off check Meta makes on a web address, and the
 * signature over the exact bytes of every later post. WhatsApp, Messenger and Instagram all work
 * this way, so they share this file rather than each carrying a copy.
 *
 * Messenger and Instagram additionally need Meta to review the app before anybody outside your own
 * team can write to it. Branch builds the connection; the review is something the owner has to
 * apply for, and `needsAppReview` says so wherever the connection is listed.
 */
export function metaSignature(raw: Buffer, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(raw).digest("hex");
}
/** Compares two secrets without leaking how much of them matched. */
export function sameSecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
/** Throws unless the post carries Meta's signature over exactly these bytes. */
export function assertMetaSigned(raw: Buffer, signature: string | undefined, appSecret: string, service: string): void {
  if (!sameSecret(signature ?? "", metaSignature(raw, appSecret))) throw new Error(`The message was not signed by ${service}`);
}
/** Answers Meta's one-off check that this address belongs to the owner. */
export function metaChallenge(query: URLSearchParams, verifyToken: string, service: string): string {
  const mode = query.get("hub.mode"), token = query.get("hub.verify_token"), challenge = query.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) throw new Error(`That is not a ${service} verification request`);
  if (!sameSecret(token ?? "", verifyToken)) throw new Error("The verification word did not match");
  return challenge;
}

/** Messenger and Instagram post the same shape down the same kind of address. */
const messagingSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({
    id: z.string().optional(),
    messaging: z.array(z.object({
      sender: z.object({ id: z.string() }).passthrough(),
      recipient: z.object({ id: z.string().optional() }).passthrough().optional(),
      message: z.object({ mid: z.string().optional(), text: z.string().optional(), is_echo: z.boolean().optional() }).passthrough().optional(),
    }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough();

export interface MetaMessagingOptions {
  id: string;
  /** "messenger" or "instagram"; only the names in messages differ. */
  service: "messenger" | "instagram";
  /** The page (Messenger) or professional account (Instagram) the assistant answers as. */
  pageId: string;
  token: string;
  verifyToken: string;
  appSecret: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

/**
 * Facebook Messenger and Instagram direct messages, over Meta's Graph API. This is the same webhook
 * and send shape WhatsApp uses; only the JSON around the words differs, so the signature check and
 * the address check come from this file and nothing is duplicated.
 */
export class MetaMessagingAdapter implements ChannelAdapter {
  readonly kind: string;
  readonly id: string;
  /** Meta refuses a message longer than 2000 characters on both of these. */
  readonly maxTextLength = 1900;
  /**
   * True, always: Meta will not let a page message anybody outside your own team until the app has
   * been through their review. The Connections list shows this so it is not a surprise.
   */
  readonly needsAppReview = true;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private state: ChannelHealth = { state: "connected" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  constructor(private readonly options: MetaMessagingOptions) {
    this.id = options.id;
    this.kind = options.service;
    this.base = (options.apiBase ?? "https://graph.facebook.com/v21.0").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  private get name(): string { return this.options.service === "instagram" ? "Instagram" : "Messenger"; }
  botName(): string | null { return this.options.pageId; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    this.state = { state: "connected",
      reason: `Waiting for ${this.name} to post messages here. Meta must review the app before people outside your team can write to it.` };
  }
  async stop(): Promise<void> { this.deliver = null; }
  verify(query: URLSearchParams): string { return metaChallenge(query, this.options.verifyToken, this.name); }
  async receive(raw: Buffer, signature: string | undefined): Promise<{ accepted: number }> {
    assertMetaSigned(raw, signature, this.options.appSecret, this.name);
    const body = messagingSchema.parse(JSON.parse(raw.toString("utf8")));
    let accepted = 0;
    for (const entry of body.entry) for (const event of entry.messaging) {
      // The page's own posts come back down the same address; answering them would loop.
      if (event.message?.is_echo || !event.message?.text || event.sender.id === this.options.pageId) continue;
      if (!this.deliver) continue;
      accepted++;
      await this.deliver({
        channel: this.id, chatId: event.sender.id, chatKind: "direct", senderId: event.sender.id,
        senderName: event.sender.id, text: event.message.text, addressed: true,
        messageId: event.message.mid ?? `${entry.id ?? this.options.pageId}:${accepted}`,
      }).catch(() => undefined);
    }
    return { accepted };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const response = await this.fetch(`${this.base}/${encodeURIComponent(this.options.pageId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: chatId }, messaging_type: "RESPONSE", message: { text: text.slice(0, this.maxTextLength) } }),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`${this.name} refused the message (${response.status})`);
    const parsed = z.object({ message_id: z.string().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.message_id : undefined;
  }
}

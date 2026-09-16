import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";

/**
 * WhatsApp through Meta's Cloud API. WhatsApp pushes messages to a web address instead of holding a
 * socket open, so this adapter waits to be handed requests by the server route rather than
 * connecting anywhere itself. Meta checks the address once with a challenge, and signs every later
 * request; a request without a matching signature is refused. Replies go out through the Graph API.
 *
 * WhatsApp only allows a free-form reply within twenty-four hours of the person's last message.
 * Outside that window the send is refused with a plain reason, so the delivery ledger holds the
 * message, tries again, and finally shows it to the owner under "Messages still to send".
 */
export interface WhatsAppOptions {
  id: string;
  /** Graph API access token for the WhatsApp business account. */
  token: string;
  /** The phone number id the business sends from. */
  phoneNumberId: string;
  /** Shared with Meta when the address is first verified. */
  verifyToken: string;
  /** The app secret, used to check the signature on every request Meta sends. */
  appSecret: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** How long after someone writes we may still reply; twenty-four hours by default. */
  sessionWindowMs?: number;
  now?: () => number;
}
const valueSchema = z.object({
  messaging_product: z.string().optional(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough()).default([]),
  messages: z.array(z.object({
    id: z.string(), from: z.string(), timestamp: z.string().optional(), type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough();
const webhookSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({ changes: z.array(z.object({ value: valueSchema }).passthrough()).default([]) }).passthrough()).default([]),
}).passthrough();

export class WhatsAppAdapter implements ChannelAdapter {
  readonly kind = "whatsapp";
  readonly id: string;
  /** WhatsApp text messages stop at 4096 characters. */
  readonly maxTextLength = 4000;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private state: ChannelHealth = { state: "connected" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  /** When each person last wrote, so we know whether we may still answer them. */
  private readonly lastHeard = new Map<string, number>();
  constructor(private readonly options: WhatsAppOptions) {
    this.id = options.id;
    this.base = (options.apiBase ?? "https://graph.facebook.com/v21.0").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }
  botName(): string | null { return this.options.phoneNumberId; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    this.state = { state: "connected", reason: "Waiting for WhatsApp to send messages to this computer's web address" };
  }
  async stop(): Promise<void> { this.deliver = null; }
  /** Answers Meta's one-off check that this address belongs to the owner. */
  verify(query: URLSearchParams): string {
    const mode = query.get("hub.mode"), token = query.get("hub.verify_token"), challenge = query.get("hub.challenge");
    if (mode !== "subscribe" || !challenge) throw new Error("That is not a WhatsApp verification request");
    if (!sameSecret(token ?? "", this.options.verifyToken)) throw new Error("The verification word did not match");
    return challenge;
  }
  /**
   * Checks the signature over the exact bytes Meta sent, then turns each message into one the
   * router can answer. An unsigned or wrongly signed request is refused before anything is read.
   */
  async receive(raw: Buffer, signature: string | undefined): Promise<{ accepted: number }> {
    const expected = "sha256=" + createHmac("sha256", this.options.appSecret).update(raw).digest("hex");
    if (!sameSecret(signature ?? "", expected)) throw new Error("The message was not signed by WhatsApp");
    const body = webhookSchema.parse(JSON.parse(raw.toString("utf8")));
    let accepted = 0;
    for (const entry of body.entry) for (const change of entry.changes) {
      for (const message of change.value.messages) {
        const name = change.value.contacts.find((contact) => contact.wa_id === message.from)?.profile?.name;
        this.lastHeard.set(message.from, this.now());
        const inbound = this.inbound(message, name);
        if (!inbound || !this.deliver) continue;
        accepted++;
        await this.deliver(inbound).catch(() => undefined);
      }
    }
    return { accepted };
  }
  private inbound(message: { id: string; from: string; type?: string | undefined; text?: { body: string } | undefined }, name?: string): InboundMessage | null {
    if ((message.type ?? "text") !== "text" || !message.text?.body) return null;
    return {
      channel: this.id, chatId: message.from, chatKind: "direct", senderId: message.from,
      senderName: name ?? message.from, text: message.text.body, addressed: true, messageId: message.id,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const heard = this.lastHeard.get(chatId);
    const window = this.options.sessionWindowMs ?? 24 * 60 * 60 * 1000;
    if (heard !== undefined && this.now() - heard > window)
      throw new Error("Outside WhatsApp's 24-hour reply window; waiting until they write again");
    const response = await this.fetch(`${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: chatId,
        type: "text", text: { body: text.slice(0, this.maxTextLength), preview_url: false },
        ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`WhatsApp refused the message (${response.status})`);
    const parsed = z.object({ messages: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.messages[0]?.id : undefined;
  }
}
/** Compares two secrets without leaking how much of them matched. */
function sameSecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

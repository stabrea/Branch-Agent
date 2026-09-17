import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, headerOf, sameSecret, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Pumble, through a Pumble app with a bot user. Pumble posts each event to this computer's address.
 *
 * The signing rule is Pumble's own, read from its official Node SDK (npm `pumble-sdk` 1.1.13, by
 * Pumble / CAKE.com, ISC, lib/core/adapters/http/middlewares.js): the headers
 * `x-pumble-request-timestamp` and `x-pumble-request-signature` carry the hex HMAC-SHA256, made with
 * the app's signing secret, of `<timestamp>:<exact body>`. It is not OpenFang's: OpenFang's
 * crates/openfang-channels/src/pumble.rs checks no signature at all. The SDK does not say what unit
 * the timestamp is in, so no freshness window is applied; a resent copy is dropped by the
 * already-seen list instead.
 *
 * An event arrives as `{ messageType: "PUMBLE_EVENT", eventType: "NEW_MESSAGE", body: "<JSON>" }`,
 * with the message itself in short keys: `tx` text, `cId` channel, `aId` author, `mId` message id.
 * Replies go to `POST /v1/channels/{cId}/messages` (or `/messages/{thread root}` in a channel) with
 * the bot token in the `token` header and the app key in `x-app-token`.
 * Docs: https://pumble.com/help/integrations/add-pumble-apps/pumble-app-sdk/
 */
export interface PumbleOptions {
  id: string;
  signingSecret: string;
  botToken: string;
  appKey: string;
  /** The bot user's id, from the app's installation, so its own messages are never answered. */
  botUserId: string;
  botName?: string;
  apiBase: string;
  botTokenName?: string;
  fetch?: typeof fetch;
}

const EnvelopeSchema = z.object({
  messageType: z.string(),
  eventType: z.string().optional(),
  body: z.string().optional(),
}).passthrough();
const MessageSchema = z.object({
  mId: z.string().min(1), cId: z.string().min(1), aId: z.string().min(1),
  tx: z.string().default(""), trId: z.string().optional(), mu: z.array(z.string()).optional(),
}).passthrough();
const ChannelSchema = z.object({ channel: z.object({ channelType: z.string() }).passthrough() }).passthrough();

function readJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export class PumbleChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "pumble";
  readonly id: string;
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "connected", reason: "Waiting for Pumble to post a message" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  /** Whether each channel is a one-to-one chat, asked once per channel. */
  private readonly direct = new Map<string, boolean>();
  /** The thread each group message sits in, so a reply stays in it. */
  private readonly threads = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: PumbleOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.botName ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliver = onMessage; }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    const timestamp = headerOf(headers, "x-pumble-request-timestamp");
    const signature = headerOf(headers, "x-pumble-request-signature");
    if (!timestamp || !signature) throw new Error("The post carried no Pumble signature");
    const expected = createHmac("sha256", this.options.signingSecret).update(`${timestamp}:`).update(raw).digest("hex");
    if (!sameSecret(signature.toLowerCase(), expected)) throw new Error("The Pumble signature did not match");
    // Only now, with the signature proved, is the post itself read.
    const envelope = EnvelopeSchema.safeParse(readJson(raw.toString("utf8")));
    if (!envelope.success || !["PUMBLE_EVENT", "APP_EVENT"].includes(envelope.data.messageType)
      || envelope.data.eventType !== "NEW_MESSAGE" || !envelope.data.body) return { accepted: 0 };
    const body = MessageSchema.safeParse(readJson(envelope.data.body));
    if (!body.success || !this.deliver) return { accepted: 0 };
    // The post is genuine from here on, so a failed lookup is not held against it.
    const message = await this.inbound(body.data).catch(() => null);
    if (!message) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  private async inbound(body: z.infer<typeof MessageSchema>): Promise<InboundMessage | null> {
    if (body.aId === this.options.botUserId || !body.tx.trim()) return null;
    const direct = await this.isDirect(body.cId);
    // Pumble writes a mention as <<@user id>> in the text and lists who was mentioned in `mu`.
    const tag = `<<@${this.options.botUserId}>>`;
    const mentioned = body.tx.includes(tag) || !!body.mu?.includes(this.options.botUserId);
    const text = body.tx.split(tag).join(" ").replace(/\s+/g, " ").trim();
    const chatId = this.ids.short(body.cId, "chat");
    const messageId = this.ids.short(body.mId, "msg");
    const senderId = this.ids.short(body.aId, "who");
    if (!this.seen.first(SeenMessages.key(messageId, senderId, chatId, text))) return null;
    if (!direct) this.threads.set(messageId, body.trId || body.mId);
    return {
      channel: this.id, chatId, chatKind: direct ? "direct" : "group", senderId, senderName: body.aId,
      text, addressed: direct || mentioned, messageId,
    };
  }

  private async isDirect(channelId: string): Promise<boolean> {
    const known = this.direct.get(channelId);
    if (known !== undefined) return known;
    const answer = ChannelSchema.parse(await this.call(`/v1/channels/${encodeURIComponent(channelId)}`, { method: "GET" }));
    const direct = answer.channel.channelType === "DIRECT";
    this.direct.set(channelId, direct);
    if (this.direct.size > 1000) this.direct.delete(this.direct.keys().next().value!);
    return direct;
  }

  private async call(path: string, init: Parameters<typeof callJson>[3]): Promise<unknown> {
    try {
      const answer = await callJson(this.fetchImpl, "Pumble", `${this.options.apiBase.replace(/\/$/, "")}${path}`, {
        ...init, headers: { token: this.options.botToken, "x-app-token": this.options.appKey },
      });
      this.state = { state: "connected" };
      return answer;
    } catch (error) {
      if (/\((401|403)\)/.test(String(error)))
        this.state = { state: "needs attention", reason: `The bot token was refused. Save a new one as ${this.options.botTokenName ?? "PUMBLE_BOT_TOKEN"}` };
      throw error;
    }
  }

  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const channel = encodeURIComponent(this.ids.long(chatId));
    const root = replyToMessageId ? this.threads.get(replyToMessageId) : undefined;
    const path = root ? `/v1/channels/${channel}/messages/${encodeURIComponent(root)}` : `/v1/channels/${channel}/messages`;
    const answer = await this.call(path, { method: "POST", json: { text: text.slice(0, this.maxTextLength) } });
    const sent = z.object({ id: z.string() }).passthrough().safeParse(answer);
    return sent.success ? this.ids.short(sent.data.id, "msg") : undefined;
  }
}

export const pumbleService = defineService({
  kind: "pumble", name: "Pumble", docs: "https://pumble.com/help/integrations/add-pumble-apps/pumble-app-sdk/",
  needs: [
    "A Pumble app with a bot user, with its event address set to the address Branch shows",
    "The app's signing secret, saved as a secret", "The app key, saved as a secret",
    "The bot token from the app's installation, saved as a secret", "The bot user's id",
  ],
  receives: "posted",
  settings: z.object({
    signingSecretSecret: z.string().regex(secretName).default("PUMBLE_SIGNING_SECRET"),
    botTokenSecret: z.string().regex(secretName).default("PUMBLE_BOT_TOKEN"),
    appKeySecret: z.string().regex(secretName).default("PUMBLE_APP_KEY"),
    botUserId: z.string().min(1).max(100),
    botName: z.string().min(1).max(80).optional(),
    apiBase: z.string().url().default("https://api-ga.pumble.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Pumble address");
    return new PumbleChannel({
      id: deps.id, apiBase: settings.apiBase, fetch: deps.fetch, botUserId: settings.botUserId,
      botTokenName: settings.botTokenSecret,
      signingSecret: await deps.secret(settings.signingSecretSecret),
      botToken: await deps.secret(settings.botTokenSecret),
      appKey: await deps.secret(settings.appKeySecret),
      ...(settings.botName ? { botName: settings.botName } : {}),
    });
  },
});

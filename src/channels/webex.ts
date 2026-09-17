import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, FreshPosts, headerOf, sameSecret, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Webex, through a Webex bot and a webhook on `messages` / `created`. Webex signs each post with the
 * webhook's secret: `X-Spark-Signature` is the hex HMAC-SHA1 of the exact body. The post only
 * carries the message's id, so the words are fetched with the bot token (`GET /v1/messages/{id}`).
 * Webex only tells a bot about a group message when the bot is mentioned, and the text then starts
 * with the bot's name, which is taken off. Replies go to `POST /v1/messages` in the same room, in
 * the same thread.
 * API: https://developer.webex.com/docs/api/guides/webhooks and https://developer.webex.com/docs/api/v1/messages
 */
export interface WebexOptions {
  id: string;
  botToken: string;
  webhookSecret: string;
  apiBase: string;
  botTokenName?: string;
  fetch?: typeof fetch;
}

const EventSchema = z.object({
  resource: z.string(),
  event: z.string(),
  data: z.object({ id: z.string().min(1), personId: z.string().optional() }).passthrough(),
}).passthrough();
const MessageSchema = z.object({
  id: z.string().min(1), roomId: z.string().min(1), roomType: z.enum(["direct", "group"]),
  personId: z.string().min(1), personEmail: z.string().optional(), text: z.string().default(""),
  parentId: z.string().optional(), created: z.string().default(""),
}).passthrough();
const MeSchema = z.object({ id: z.string().min(1), displayName: z.string().default("") }).passthrough();

export class WebexChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "webex";
  readonly id: string;
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "reconnecting", reason: "Checking the bot token with Webex" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private me: z.infer<typeof MeSchema> | null = null;
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  private readonly fresh = new FreshPosts();
  /** The thread each message sits in, so a reply stays in it. */
  private readonly threads = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: WebexOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.me?.displayName || null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    await this.whoAmI().catch(() => undefined);
  }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    const signature = headerOf(headers, "x-spark-signature").toLowerCase();
    const expected = createHmac("sha1", this.options.webhookSecret).update(raw).digest("hex");
    if (!sameSecret(signature, expected)) throw new Error("The Webex signature did not match");
    // Only now, with the signature proved, is the post itself read.
    const event = EventSchema.safeParse(readJson(raw));
    if (!event.success || event.data.resource !== "messages" || event.data.event !== "created" || !this.deliver) return { accepted: 0 };
    // The post is genuine from here on, so a failure to fetch the words is not held against it;
    // the health line says what went wrong.
    const message = await this.fetchMessage(event.data.data).catch(() => null);
    if (!message) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  private async fetchMessage(data: z.infer<typeof EventSchema>["data"]): Promise<InboundMessage | null> {
    const me = await this.whoAmI();
    if (data.personId === me.id) return null;
    const message = MessageSchema.parse(await this.call(`/v1/messages/${encodeURIComponent(data.id)}`));
    // Webex signs no time, so a copied post is caught by the message's own creation time, as Webex
    // itself reports it, and by taking each message in only once.
    this.fresh.admit(Date.parse(message.created), `id:${message.id}`, "Webex");
    return this.inbound(message, me);
  }

  private inbound(message: z.infer<typeof MessageSchema>, me: z.infer<typeof MeSchema>): InboundMessage | null {
    if (message.personId === me.id) return null;
    const group = message.roomType === "group";
    let text = message.text.trim();
    if (group && me.displayName && text.toLowerCase().startsWith(me.displayName.toLowerCase()))
      text = text.slice(me.displayName.length).replace(/^[\s,:]+/, "");
    if (!text) return null;
    const chatId = this.ids.short(message.roomId, "chat");
    const messageId = this.ids.short(message.id, "msg");
    const senderId = this.ids.short(message.personId, "who");
    if (!this.seen.first(SeenMessages.key(messageId, senderId, chatId, text))) return null;
    this.threads.set(messageId, message.parentId ?? message.id);
    if (this.threads.size > 1000) this.threads.delete(this.threads.keys().next().value!);
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct", senderId,
      senderName: message.personEmail ?? message.personId, text,
      // Webex only posts a group message to a bot when the bot was mentioned in it.
      addressed: true, messageId,
    };
  }

  private async whoAmI(): Promise<z.infer<typeof MeSchema>> {
    if (!this.me) this.me = MeSchema.parse(await this.call("/v1/people/me"));
    return this.me;
  }

  private async call(path: string, init: Parameters<typeof callJson>[3] = { method: "GET" }): Promise<unknown> {
    try {
      const answer = await callJson(this.fetchImpl, "Webex", `${this.options.apiBase.replace(/\/$/, "")}${path}`, {
        ...init, headers: { authorization: `Bearer ${this.options.botToken}` },
      });
      this.state = { state: "connected" };
      return answer;
    } catch (error) {
      this.state = /\((401|403)\)/.test(String(error))
        ? { state: "needs attention", reason: `The bot token was refused. Save a new one as ${this.options.botTokenName ?? "WEBEX_BOT_TOKEN"}` }
        : { state: "reconnecting", reason: `Could not reach Webex: ${error instanceof Error ? error.message : String(error)}` };
      throw error;
    }
  }

  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const parentId = replyToMessageId ? this.threads.get(replyToMessageId) : undefined;
    const answer = await this.call("/v1/messages", {
      method: "POST",
      json: { roomId: this.ids.long(chatId), text: text.slice(0, this.maxTextLength), ...(parentId ? { parentId } : {}) },
    });
    const sent = z.object({ id: z.string() }).passthrough().safeParse(answer);
    return sent.success ? this.ids.short(sent.data.id, "msg") : undefined;
  }
}

function readJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString("utf8")) as unknown; } catch { return undefined; }
}

export const webexService = defineService({
  kind: "webex", name: "Webex", docs: "https://developer.webex.com/docs/api/guides/webhooks",
  needs: [
    "A Webex bot made at developer.webex.com, and its access token saved as a secret",
    "A webhook for messages created, pointing at the address Branch shows, made with a secret you choose and save as a secret",
  ],
  receives: "posted",
  settings: z.object({
    botTokenSecret: z.string().regex(secretName).default("WEBEX_BOT_TOKEN"),
    webhookSecret: z.string().regex(secretName).default("WEBEX_WEBHOOK_SECRET"),
    apiBase: z.string().url().default("https://webexapis.com"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Webex address");
    return new WebexChannel({
      id: deps.id, apiBase: settings.apiBase, fetch: deps.fetch, botTokenName: settings.botTokenSecret,
      botToken: await deps.secret(settings.botTokenSecret), webhookSecret: await deps.secret(settings.webhookSecret),
    });
  },
});

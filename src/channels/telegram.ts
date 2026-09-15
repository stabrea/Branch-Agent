import { z } from "zod";
import type { ChannelAdapter, InboundMessage } from "./router.js";

/**
 * Telegram Bot API adapter using long polling. Only text messages are delivered; a message is
 * "addressed" when it mentions the bot's username or replies to one of the bot's messages.
 */
export interface TelegramOptions {
  id: string;
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  pollTimeoutSeconds?: number;
}
const userSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional() }).passthrough();
const messageSchema = z.object({
  message_id: z.number(),
  text: z.string().optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }).passthrough(),
  entities: z.array(z.object({ type: z.string(), offset: z.number(), length: z.number() })).optional(),
  reply_to_message: z.object({ from: userSchema.optional() }).passthrough().optional(),
}).passthrough();
const updateSchema = z.object({ update_id: z.number(), message: messageSchema.optional() }).passthrough();
const responseSchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional() });

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  readonly id: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly pollTimeout: number;
  private username: string | null = null;
  private offset = 0;
  private stopping = new AbortController();
  private loop: Promise<void> | null = null;
  constructor(private readonly options: TelegramOptions) {
    this.id = options.id;
    this.base = `${(options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${options.token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.pollTimeout = options.pollTimeoutSeconds ?? 25;
  }
  botName(): string | null { return this.username; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const me = userSchema.parse(await this.call("getMe", {}));
    this.username = me.username ?? null;
    this.loop = this.poll(onMessage);
  }
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop?.catch(() => undefined);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: Number(chatId), text,
      ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
  }
  private async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        const updates = z.array(updateSchema).parse(await this.call("getUpdates", { offset: this.offset, timeout: this.pollTimeout, allowed_updates: ["message"] }, true));
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const message = update.message && this.inbound(update.message);
          if (message) await onMessage(message).catch(() => undefined);
        }
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        void error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  private inbound(message: z.infer<typeof messageSchema>): InboundMessage | null {
    if (!message.text || !message.from || message.from.is_bot) return null;
    const mention = this.username ? `@${this.username.toLowerCase()}` : null;
    const mentioned = !!mention && (message.entities ?? []).some((entity) =>
      entity.type === "mention" && message.text!.slice(entity.offset, entity.offset + entity.length).toLowerCase() === mention);
    const replyToBot = !!this.username && message.reply_to_message?.from?.username === this.username;
    const direct = message.chat.type === "private";
    const text = mention && mentioned ? message.text.replace(new RegExp(mention, "ig"), "").trim() : message.text;
    return {
      channel: this.id, chatId: String(message.chat.id), chatKind: direct ? "direct" : "group",
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      senderId: String(message.from.id), senderName: message.from.username ?? message.from.first_name ?? String(message.from.id),
      text, addressed: direct || mentioned || replyToBot, messageId: String(message.message_id),
    };
  }
  private async call(method: string, body: unknown, longPoll = false): Promise<unknown> {
    const signal = longPoll ? AbortSignal.any([this.stopping.signal, AbortSignal.timeout((this.pollTimeout + 10) * 1000)]) : AbortSignal.timeout(20000);
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram ${method} failed: ${parsed.description ?? response.status}`);
    return parsed.result;
  }
}

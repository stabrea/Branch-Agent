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
const voiceSchema = z.object({
  file_id: z.string().min(1).max(200),
  duration: z.number().nonnegative().optional(),
  mime_type: z.string().max(100).optional(),
  file_size: z.number().nonnegative().optional(),
}).passthrough();
const messageSchema = z.object({
  message_id: z.number(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: voiceSchema.optional(),
  audio: voiceSchema.optional(),
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
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const result = await this.call("sendMessage", {
      chat_id: Number(chatId), text,
      ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
    const parsed = z.object({ message_id: z.number() }).passthrough().safeParse(result);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }
  /** Sends a spoken reply as a Telegram voice note. Telegram wants the file as a form upload. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData();
    form.append("chat_id", chatId);
    const extension = mediaType.includes("mpeg") ? "mp3" : mediaType.includes("wav") ? "wav" : "ogg";
    form.append("audio", new Blob([new Uint8Array(audio)], { type: mediaType }), `reply.${extension}`);
    if (replyToMessageId) form.append("reply_to_message_id", replyToMessageId);
    const response = await this.fetch(`${this.base}/sendAudio`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram sendAudio failed: ${parsed.description ?? response.status}`);
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    return message.success ? String(message.data.message_id) : undefined;
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
    const spoken = message.voice ?? message.audio;
    const written = message.text ?? (spoken ? message.caption ?? "" : undefined);
    if (written === undefined || !message.from || message.from.is_bot) return null;
    const mention = this.username ? `@${this.username.toLowerCase()}` : null;
    const mentioned = !!mention && (message.entities ?? []).some((entity) =>
      entity.type === "mention" && written.slice(entity.offset, entity.offset + entity.length).toLowerCase() === mention);
    const replyToBot = !!this.username && message.reply_to_message?.from?.username === this.username;
    const direct = message.chat.type === "private";
    const text = mention && mentioned ? written.replace(new RegExp(mention, "ig"), "").trim() : written;
    return {
      channel: this.id, chatId: String(message.chat.id), chatKind: direct ? "direct" : "group",
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      senderId: String(message.from.id), senderName: message.from.username ?? message.from.first_name ?? String(message.from.id),
      text, addressed: direct || mentioned || replyToBot || (!!spoken && direct), messageId: String(message.message_id),
      ...(spoken ? { voice: {
        mediaType: spoken.mime_type ?? "audio/ogg",
        seconds: spoken.duration,
        bytes: () => this.download(spoken.file_id, spoken.file_size ?? 0),
      } } : {}),
    };
  }
  /** Fetches a voice note's bytes, and only once the message has earned an answer. */
  private async download(fileId: string, declaredSize: number): Promise<Uint8Array> {
    const limit = 20 * 1024 * 1024;
    if (declaredSize > limit) throw new Error("That voice note is larger than 20 MB, so it was not downloaded");
    const info = z.object({ file_path: z.string().min(1).max(400) }).passthrough().parse(await this.call("getFile", { file_id: fileId }));
    const response = await this.fetch(`${this.base.replace("/bot", "/file/bot")}/${info.file_path}`, {
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram would not hand over that voice note (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error("That voice note is larger than 20 MB, so it was not used");
    return bytes;
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

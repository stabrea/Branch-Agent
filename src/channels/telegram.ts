import { z } from "zod";
import type { ChannelAdapter, InboundMessage, OutgoingFile } from "./router.js"; // R17-C: OutgoingFile
import type { ChannelPosition } from "../never-break/channel-position.js";

/**
 * Telegram Bot API adapter using long polling. Text and media messages are delivered; a message is
 * "addressed" when it mentions the bot's username or replies to one of the bot's messages.
 */
export interface TelegramOptions {
  id: string;
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  pollTimeoutSeconds?: number;
  /** mac3/never-break: where the stream was read up to, kept across restarts. */
  position?: ChannelPosition;
}
const userSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional() }).passthrough();
const voiceSchema = z.object({
  file_id: z.string().min(1).max(200),
  duration: z.number().nonnegative().optional(),
  mime_type: z.string().max(100).optional(),
  file_size: z.number().nonnegative().optional(),
}).passthrough();
const mediaSchema = voiceSchema.extend({ file_unique_id: z.string().optional(), file_name: z.string().optional() });
const messageSchema = z.object({
  photo: z.array(mediaSchema).optional(),
  document: mediaSchema.optional(),
  video: mediaSchema.optional(),
  message_id: z.number(),
  message_thread_id: z.number().int().positive().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: voiceSchema.optional(),
  audio: voiceSchema.optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }).passthrough(),
  entities: z.array(z.object({ type: z.string(), offset: z.number(), length: z.number() })).optional(),
  reply_to_message: z.object({ from: userSchema.optional() }).passthrough().optional(),
}).passthrough();
/** A button somebody pressed. Telegram sends the button's own `data` back, at most 64 bytes of it. */
const callbackSchema = z.object({
  id: z.string(),
  data: z.string().max(64).optional(),
  from: userSchema.optional(),
  message: messageSchema.optional(),
}).passthrough();
const updateSchema = z.object({
  update_id: z.number(),
  message: messageSchema.optional(),
  callback_query: callbackSchema.optional(),
}).passthrough();
const responseSchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional() });
/** Topic addresses remain distinct in the router; Telegram receives the underlying chat and thread. */
const topicAddress = (chatId: number, threadId?: number): string =>
  threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
const telegramTarget = (address: string): { chat_id: number; message_thread_id?: number } => {
  const [chatId, threadId] = address.split(":");
  return { chat_id: Number(chatId), ...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }) };
};

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  readonly id: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly pollTimeout: number;
  private username: string | null = null;
  private offset = 0;
  private stopping = new AbortController();
  /** mac3/never-break: messages handed over and not yet settled, and how far everything is settled. */
  private readonly inFlight = new Set<number>();
  private settledUpTo = 0;
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
    this.offset = Math.max(this.offset, this.options.position?.load() ?? 0); // mac3/never-break
    this.loop = this.poll(onMessage);
  }
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop?.catch(() => undefined);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const result = await this.call("sendMessage", {
      ...telegramTarget(chatId), text,
      ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
    const parsed = z.object({ message_id: z.number() }).passthrough().safeParse(result);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }
  /** Sends a spoken reply as a Telegram voice note. Telegram wants the file as a form upload. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData();
    const target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    const extension = mediaType.includes("mpeg") ? "mp3" : mediaType.includes("wav") ? "wav" : "ogg";
    form.append("audio", new Blob([new Uint8Array(audio)], { type: mediaType }), `reply.${extension}`);
    if (replyToMessageId) form.append("reply_to_message_id", replyToMessageId);
    const response = await this.fetch(`${this.base}/sendAudio`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram sendAudio failed: ${parsed.description ?? response.status}`);
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    return message.success ? String(message.data.message_id) : undefined;
  }
  // ---- R17-C (R17-022): a file as a Telegram document. Bots may send up to 50 MB. ----
  readonly maxFileBytes = 50 * 1024 * 1024;
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData();
    const target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    form.append("document", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.name);
    if (file.caption) form.append("caption", file.caption.slice(0, 1024));
    if (replyToMessageId) form.append("reply_to_message_id", replyToMessageId);
    const response = await this.fetch(`${this.base}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram sendDocument failed: ${parsed.description ?? response.status}`);
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    return message.success ? String(message.data.message_id) : undefined;
  }
  // ---- end R17-C ----
  private async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        // "callback_query" has to be asked for by name, or a pressed button never arrives at all.
        const updates = z.array(updateSchema).parse(await this.call("getUpdates", { offset: this.offset, timeout: this.pollTimeout, allowed_updates: ["message", "callback_query"] }, true));
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          // Handed over without waiting: a message sent while a task works is a note for that task,
          // and it has to be read while the task is still going. The router keeps one task per chat.
          const pressed = update.callback_query && this.fromButton(update.callback_query);
          if (pressed) { this.handOver(update.update_id, pressed, onMessage); continue; }
          const message = update.message && this.inbound(update.message);
          this.handOver(update.update_id, message || null, onMessage);
        }
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        void error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  /**
   * mac3/never-break: hands one update to the router without waiting for it, and saves the read
   * position only up to the oldest message still being handled, so a crash never skips one.
   */
  private handOver(id: number, message: InboundMessage | null, onMessage: (message: InboundMessage) => Promise<void>): void {
    const settle = () => {
      this.inFlight.delete(id);
      this.settledUpTo = Math.max(this.settledUpTo, id + 1);
      const oldest = Math.min(...this.inFlight);
      this.options.position?.save(Number.isFinite(oldest) ? Math.min(oldest, this.settledUpTo) : this.settledUpTo);
    };
    if (!message) { settle(); return; }
    this.inFlight.add(id);
    void onMessage(message).catch(() => undefined).finally(settle);
  }
  /**
   * A pressed button, as an ordinary addressed message carrying the button's own value. The router
   * reads it as an answer to whatever this chat's conversation is waiting on; if nothing is waiting
   * it is a short message like any other. Telegram is told the press landed straight away, so the
   * button stops spinning whatever happens next.
   */
  private fromButton(query: z.infer<typeof callbackSchema>): InboundMessage | null {
    const chat = query.message?.chat;
    // mac7/chat-approvals (integration review): the same guard `inbound` puts on an ordinary
    // message. A press carries the sender id a line is matched against, so a bot posting as the
    // person the owner named would otherwise have carried that person's yes.
    if (!chat || !query.from || query.from.is_bot || !query.data) return null;
    void this.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);
    return {
      channel: this.id, chatId: topicAddress(chat.id, query.message?.message_thread_id), chatKind: chat.type === "private" ? "direct" : "group",
      ...(chat.title ? { chatTitle: chat.title } : {}),
      senderId: String(query.from.id),
      senderName: query.from.username ?? query.from.first_name ?? String(query.from.id),
      text: query.data, addressed: true, messageId: String(query.message?.message_id ?? query.id),
    };
  }
  /**
   * A question with buttons to press. Each button's `data` is the answer plus the fingerprint of
   * the exact request, which fits inside Telegram's 64-byte limit; the conversation the answer
   * belongs to is worked out from the chat, not carried in the button.
   */
  async sendButtons(chatId: string, text: string, buttons: { label: string; value: string }[], replyToMessageId?: string): Promise<string | undefined> {
    const result = await this.call("sendMessage", {
      ...telegramTarget(chatId), text,
      reply_markup: { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.value }))] },
      ...(replyToMessageId ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
    const parsed = z.object({ message_id: z.number() }).passthrough().safeParse(result);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }
  /** "typing…" for about five seconds; the router asks again while the task works. */
  async sendTyping(chatId: string): Promise<void> {
    await this.call("sendChatAction", { ...telegramTarget(chatId), action: "typing" });
  }
  /** Telegram shows one reaction from a bot and replaces it, so `previous` needs no removing. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId), reaction: [{ type: "emoji", emoji }],
    });
  }
  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.call("editMessageText", { chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId), text });
    } catch (error) {
      // Sending the same words again is refused with this; the message already says them.
      if (!/message is not modified/i.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
  private inbound(message: z.infer<typeof messageSchema>): InboundMessage | null {
    const spoken = message.voice ?? message.audio;
    const media = message.document ?? message.video ?? message.photo?.at(-1);
    const written = message.text ?? (spoken || media ? message.caption ?? "" : undefined);
    if (written === undefined || !message.from || message.from.is_bot) return null;
    const mention = this.username ? `@${this.username.toLowerCase()}` : null;
    const mentioned = !!mention && (message.entities ?? []).some((entity) =>
      entity.type === "mention" && written.slice(entity.offset, entity.offset + entity.length).toLowerCase() === mention);
    const replyToBot = !!this.username && message.reply_to_message?.from?.username === this.username;
    const direct = message.chat.type === "private";
    const text = mention && mentioned ? written.replace(new RegExp(mention, "ig"), "").trim() : written;
    return {
      channel: this.id, chatId: topicAddress(message.chat.id, message.message_thread_id), chatKind: direct ? "direct" : "group",
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      senderId: String(message.from.id), senderName: message.from.username ?? message.from.first_name ?? String(message.from.id),
      text, addressed: direct || mentioned || replyToBot || (!!spoken && direct), messageId: String(message.message_id),
      ...(media ? { attachments: [{
        name: message.document?.file_name ?? message.video?.file_name ?? `photo-${message.message_id}.jpg`,
        sourceId: media.file_unique_id ?? media.file_id,
        mediaType: message.document?.mime_type ?? message.video?.mime_type ?? "image/jpeg",
        kind: message.document ? "document" as const : message.video ? "video" as const : "picture" as const,
        bytes: () => this.downloadAttachment(media.file_id, media.file_size),
      }] } : {}),
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
  /** Fetch only after the router accepts the sender, enforcing the intake ceiling on both sides. */
  private async downloadAttachment(fileId: string, declaredSize?: number): Promise<Uint8Array> {
    const limit = 20 * 1024 * 1024; // Telegram Bot API getFile download ceiling
    if (declaredSize !== undefined && declaredSize > limit) throw new Error("Telegram attachment exceeds 20 MB");
    const info = z.object({ file_path: z.string().min(1).max(400), file_size: z.number().optional() })
      .passthrough().parse(await this.call("getFile", { file_id: fileId }));
    if (info.file_size !== undefined && info.file_size > limit) throw new Error("Telegram attachment exceeds 20 MB");
    const response = await this.fetch(`${this.base.replace("/bot", "/file/bot")}/${info.file_path}`, {
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram attachment download failed (${response.status})`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); throw new Error("Telegram attachment exceeds 20 MB"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Telegram attachment has no bytes");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("Telegram attachment exceeds 20 MB");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    if (declaredSize !== undefined && size !== declaredSize) throw new Error("Telegram attachment size mismatch");
    if (info.file_size !== undefined && size !== info.file_size) throw new Error("Telegram attachment size mismatch");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
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

import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, headerOf, sameSecret, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Synology Chat, through a Chatbot integration. Synology Chat posts a form to this computer's
 * address when somebody writes to the bot (`token`, `user_id`, `username`, `post_id`, `channel_id`,
 * `text`, `timestamp`); the token is the integration's own and is compared before anything else in
 * the post is used. The reply goes back through the Chatbot's incoming address, which carries its
 * own token and so is kept as a secret and never written into an error, with the form field
 * `payload` holding `{ text, user_ids: [user_id] }`.
 *
 * A Chatbot talks one-to-one only, so every message is a direct message. Synology does not post the
 * bot's own replies back to the outgoing address.
 * Docs: https://kb.synology.com/en-global/DSM/help/Chat/chat_integration
 * The payload and reply shape follow OpenClaw extensions/synology-chat (MIT).
 */
export interface SynologyChatOptions {
  id: string;
  /** The token Synology shows for the outgoing side of the Chatbot. */
  token: string;
  /** The Chatbot's incoming address, with its token inside. A secret. */
  incomingUrl: string;
  incomingUrlName?: string;
  fetch?: typeof fetch;
}

const PostSchema = z.object({
  user_id: z.string().regex(/^\d{1,18}$/),
  username: z.string().max(200).default(""),
  post_id: z.string().max(100).default(""),
  channel_id: z.string().max(100).default(""),
  text: z.string().default(""),
  trigger_word: z.string().max(100).optional(),
});

export class SynologyChatChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "synology-chat";
  readonly id: string;
  /** Synology Chat cuts a message at 2000 characters. */
  readonly maxTextLength = 2000;
  private state: ChannelHealth = { state: "connected", reason: "Waiting for Synology Chat to post a message" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: SynologyChatOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliver = onMessage; }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    // The token travels inside the form, so the form has to be split into fields to find it; none
    // of the other fields is looked at until the token has matched.
    const fields = new URLSearchParams(raw.toString("utf8"));
    const token = fields.get("token") ?? headerOf(headers, "x-synology-token");
    if (!sameSecret(token, this.options.token)) throw new Error("The Synology Chat token did not match");
    const post = PostSchema.safeParse(Object.fromEntries(fields));
    if (!post.success || !this.deliver) return { accepted: 0 };
    const message = this.inbound(post.data);
    if (!message) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  private inbound(post: z.infer<typeof PostSchema>): InboundMessage | null {
    let text = post.text.trim();
    if (post.trigger_word && text.startsWith(post.trigger_word)) text = text.slice(post.trigger_word.length).trim();
    if (!text) return null;
    const chatId = this.ids.short(post.user_id, "chat");
    const messageId = this.ids.short(post.post_id || `${Date.now()}`, "msg");
    if (!this.seen.first(SeenMessages.key(messageId, post.user_id, chatId, text))) return null;
    return {
      channel: this.id, chatId, chatKind: "direct", senderId: this.ids.short(post.user_id, "who"),
      senderName: post.username || post.user_id, text, addressed: true, messageId,
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const userId = Number(this.ids.long(chatId));
    if (!Number.isSafeInteger(userId)) throw new Error("Synology Chat can only write to a person by their number");
    const payload = JSON.stringify({ text: text.slice(0, this.maxTextLength), user_ids: [userId] });
    try {
      const answer = await callJson(this.fetchImpl, "Synology Chat", this.options.incomingUrl, { method: "POST", form: { payload } });
      const result = z.object({ success: z.boolean(), error: z.object({ code: z.number() }).passthrough().optional() }).passthrough().safeParse(answer);
      if (result.success && !result.data.success) throw new Error(`Synology Chat refused the message (code ${result.data.error?.code ?? "unknown"})`);
      this.state = { state: "connected" };
      return undefined;
    } catch (error) {
      if (/\((401|403)\)/.test(String(error)))
        this.state = { state: "needs attention", reason: `Synology Chat refused the Chatbot's address. Copy it again and save it as ${this.options.incomingUrlName ?? "SYNOLOGY_CHAT_INCOMING_URL"}` };
      throw error;
    }
  }
}

export const synologyChatService = defineService({
  kind: "synology-chat", name: "Synology Chat", docs: "https://kb.synology.com/en-global/DSM/help/Chat/chat_integration",
  needs: [
    "A Chatbot made in Synology Chat's Integration settings, with its outgoing address set to the address Branch shows",
    "The Chatbot's token, saved as a secret", "The Chatbot's incoming address, saved as a secret (it has a key inside)",
  ],
  receives: "posted",
  settings: z.object({
    tokenSecret: z.string().regex(secretName).default("SYNOLOGY_CHAT_TOKEN"),
    incomingUrlSecret: z.string().regex(secretName).default("SYNOLOGY_CHAT_INCOMING_URL"),
  }).strict(),
  async build(settings, deps) {
    const incomingUrl = await deps.secret(settings.incomingUrlSecret);
    let parsed: URL;
    try { parsed = new URL(incomingUrl); } catch { throw new Error(`The secret ${settings.incomingUrlSecret} is not a web address`); }
    // Only the host is checked and named, never the whole address: its query holds the token.
    await deps.assertAllowed(new URL(`${parsed.protocol}//${parsed.host}/`), "Synology Chat address");
    return new SynologyChatChannel({
      id: deps.id, incomingUrl, incomingUrlName: settings.incomingUrlSecret, fetch: deps.fetch,
      token: await deps.secret(settings.tokenSecret),
    });
  },
});

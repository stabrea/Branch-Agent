import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Twist conversations (Doist's team messaging). Branch reads the conversations the owner lists,
 * with a bearer token for the assistant's Twist account, and answers in the same conversation.
 * A conversation with only the assistant and one person is direct; in a larger one the assistant
 * answers only when mentioned. API: https://developer.twist.com/v3/.
 * The polling shape follows OpenFang's twist channel (MIT OR Apache-2.0).
 */
const Session = z.object({ id: z.number(), name: z.string().optional() }).passthrough();
const Conversation = z.object({ id: z.number(), user_ids: z.array(z.number()).default([]), title: z.string().nullish() }).passthrough();
const Message = z.object({
  id: z.number(), content: z.string().nullish(), creator: z.number(), creator_name: z.string().nullish(),
  conversation_id: z.number().optional(), posted_ts: z.number().optional(),
}).passthrough();

export interface TwistOptions {
  id: string; token: string; conversations: number[]; api?: string; tokenName?: string; pollMs?: number; fetch?: typeof fetch;
}

export class TwistChannel extends PollingChannel {
  readonly kind = "twist";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private me: z.infer<typeof Session> | null = null;
  private refused: string | null = null;
  private readonly rooms = new Map<number, { group: boolean; title: string; lastTs: number }>();
  private readonly seen = new Set<number>();
  constructor(private readonly options: TwistOptions) {
    super(options.id, options.pollMs ?? 15000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = (options.api ?? "https://api.twist.com").replace(/\/+$/, "");
    this.maxTextLength = 3500;
  }
  botName(): string | null { return this.me?.name ?? null; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  private call(path: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
    return callJson(this.fetchImpl, "Twist", `${this.base}/api/v3${path}`, {
      ...init, headers: { authorization: `Bearer ${this.options.token}` },
    }).catch((error: unknown) => {
      if (/\((401|403)\)$/.test(error instanceof Error ? error.message : ""))
        this.refused = `Twist refused the access token. Make a new one and save it as ${this.options.tokenName ?? "TWIST_ACCESS_TOKEN"}`;
      throw error;
    });
  }
  /** Learns who the assistant is, and whether each listed conversation is one person or several. */
  protected override async prepare(): Promise<void> {
    this.me = Session.parse(await this.call("/users/get_session_user"));
    for (const id of this.options.conversations) {
      const room = Conversation.parse(await this.call(`/conversations/getone?id=${id}`));
      this.rooms.set(id, { group: room.user_ids.length > 2, title: room.title || `Twist conversation ${id}`, lastTs: 0 });
    }
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const messages: InboundMessage[] = [];
    for (const [id, room] of this.rooms) {
      // One second back, so a message posted in the same second is not missed; the seen list drops repeats.
      const since = first ? "" : `&newer_than_ts=${Math.max(0, room.lastTs - 1)}`;
      const batch = z.array(Message).parse(await this.call(`/conversation_messages/get?conversation_id=${id}${since}`));
      for (const message of [...batch].sort((a, b) => a.id - b.id)) {
        room.lastTs = Math.max(room.lastTs, message.posted_ts ?? 0);
        if (this.seen.has(message.id)) continue;
        this.seen.add(message.id);
        if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
        const inbound = first ? null : this.inbound(id, room, message);
        if (inbound) messages.push(inbound);
      }
    }
    this.refused = null;
    return messages;
  }
  private inbound(id: number, room: { group: boolean; title: string }, message: z.infer<typeof Message>): InboundMessage | null {
    if (!this.me || message.creator === this.me.id || !message.content?.trim()) return null;
    const mention = new RegExp(`\\[[^\\]]*\\]\\(twist-mention://${this.me.id}\\)[\\s,:]*`, "g");
    const named = mention.test(message.content);
    const text = message.content.replace(mention, " ").trim();
    if (!text) return null;
    return {
      channel: this.id, chatId: String(id), chatKind: room.group ? "group" : "direct",
      ...(room.group ? { chatTitle: room.title } : {}),
      senderId: String(message.creator), senderName: message.creator_name || String(message.creator),
      text, addressed: !room.group || named, messageId: String(message.id),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const id = Number(chatId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("That is not a Twist conversation");
    const answer = await this.call("/conversation_messages/add", {
      method: "POST", form: { conversation_id: String(id), content: text.slice(0, this.maxTextLength) },
    });
    const sent = z.object({ id: z.number() }).passthrough().safeParse(answer);
    return sent.success ? String(sent.data.id) : undefined;
  }
}

export const twistService = defineService({
  kind: "twist", name: "Twist", docs: "https://developer.twist.com/v3/",
  needs: ["A Twist account for the assistant, added to the conversations it should answer",
    "An access token for that account (a Twist integration), saved as a secret",
    "The ids of those conversations, from their web addresses"],
  receives: "polls",
  settings: z.object({
    conversations: z.array(z.number().int().positive()).min(1).max(50),
    tokenSecret: z.string().regex(secretName).default("TWIST_ACCESS_TOKEN"),
    api: z.string().url().default("https://api.twist.com"),
    pollSeconds: z.number().int().min(5).max(3600).default(15),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.api), "Twist API");
    return new TwistChannel({ id: deps.id, token: await deps.secret(settings.tokenSecret), conversations: settings.conversations,
      api: settings.api, tokenName: settings.tokenSecret, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});

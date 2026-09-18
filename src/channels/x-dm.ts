import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * X (formerly Twitter) direct messages, through the X API v2 with an OAuth 2.0 user access token
 * for the assistant's account (scopes dm.read, dm.write, users.read, tweet.read). Direct-message
 * access needs a paid API plan. A one-to-one conversation id is the two user ids joined by "-";
 * any other id is a group conversation, answered only when the assistant is named.
 * API: https://docs.x.com/x-api/direct-messages/lookup/introduction and
 * https://docs.x.com/x-api/direct-messages/manage/introduction.
 */
const Me = z.object({ data: z.object({ id: z.string(), username: z.string(), name: z.string().optional() }).passthrough() }).passthrough();
const Event = z.object({
  id: z.string(), event_type: z.string().optional(), text: z.string().optional(),
  sender_id: z.string().optional(), dm_conversation_id: z.string().optional(),
}).passthrough();
const Events = z.object({ data: z.array(Event).optional() }).passthrough();
const Sent = z.object({ data: z.object({ dm_event_id: z.string() }).passthrough() }).passthrough();
const fields = "event_types=MessageCreate&dm_event.fields=id,text,sender_id,dm_conversation_id,created_at&max_results=50";

export interface XOptions { id: string; token: string; api?: string; tokenName?: string; pollMs?: number; fetch?: typeof fetch }

export class XChannel extends PollingChannel {
  readonly kind = "x-dm";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private me: z.infer<typeof Me>["data"] | null = null;
  private refused: string | null = null;
  /** Event ids already looked at; the list has no cursor for "newer than", so it is kept here. */
  private readonly seen = new Set<string>();
  constructor(private readonly options: XOptions) {
    super(options.id, options.pollMs ?? 60000, 15000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = (options.api ?? "https://api.x.com").replace(/\/+$/, "");
    this.maxTextLength = 3500;
  }
  botName(): string | null { return this.me?.username ?? null; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  private call(path: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
    return callJson(this.fetchImpl, "X", `${this.base}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.options.token}` },
    }).catch((error: unknown) => {
      const said = error instanceof Error ? error.message : "";
      const name = this.options.tokenName ?? "X_USER_ACCESS_TOKEN";
      if (/\(401\)$/.test(said)) this.refused = `X refused the access token; it may have run out. Make a new user access token and save it as ${name}`;
      if (/\(403\)$/.test(said)) this.refused = "X would not allow direct messages for this app. Direct messages need a paid X API plan and the dm.read and dm.write permissions";
      throw error;
    });
  }
  protected override async prepare(): Promise<void> {
    this.me = Me.parse(await this.call("/2/users/me")).data;
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const events = Events.parse(await this.call(`/2/dm_events?${fields}`)).data ?? [];
    this.refused = null;
    const messages: InboundMessage[] = [];
    // The newest comes first; people are answered in the order they wrote.
    for (const event of [...events].reverse()) {
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
      const inbound = first ? null : this.inbound(event);
      if (inbound) messages.push(inbound);
    }
    return messages;
  }
  private inbound(event: z.infer<typeof Event>): InboundMessage | null {
    const { text, sender_id: sender, dm_conversation_id: conversation } = event;
    if (!this.me || !text?.trim() || !sender || !conversation || sender === this.me.id) return null;
    if (event.event_type && event.event_type !== "MessageCreate") return null;
    const direct = /^\d+-\d+$/.test(conversation);
    const handle = new RegExp(`(^|\\s)@${this.me.username.replace(/[^A-Za-z0-9_]/g, "")}\\b[\\s,:]*`, "gi");
    const named = handle.test(text);
    return {
      channel: this.id, chatId: this.ids.short(conversation, "dm"), chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: "X group message" }),
      senderId: sender, senderName: sender, text: text.replace(handle, " ").trim() || text,
      addressed: direct || named, messageId: this.ids.short(event.id, "msg"),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    const conversation = this.ids.long(chatId);
    if (!/^[\d-]+$/.test(conversation)) throw new Error("That is not an X conversation");
    const answer = await this.call(`/2/dm_conversations/${conversation}/messages`, {
      method: "POST", json: { text: text.slice(0, this.maxTextLength) },
    });
    return this.ids.short(Sent.parse(answer).data.dm_event_id, "msg");
  }
}

export const xService = defineService({
  kind: "x-dm", name: "X", docs: "https://docs.x.com/x-api/direct-messages/lookup/introduction",
  needs: ["Your own X developer account and an app on a paid X API plan: direct messages are not part of the free plan",
    "An OAuth 2.0 user access token for the assistant's X account with dm.read, dm.write, tweet.read and users.read, saved as a secret"],
  receives: "polls",
  settings: z.object({
    tokenSecret: z.string().regex(secretName).default("X_USER_ACCESS_TOKEN"),
    api: z.string().url().default("https://api.x.com"),
    pollSeconds: z.number().int().min(15).max(3600).default(60),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.api), "X API");
    return new XChannel({ id: deps.id, token: await deps.secret(settings.tokenSecret), api: settings.api,
      tokenName: settings.tokenSecret, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});

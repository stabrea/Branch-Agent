import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Mastodon (and any server speaking its API). Branch reads mentions of the assistant's account and
 * answers with a status that mentions the person back, with the same visibility they used, so a
 * private mention stays private. API: https://docs.joinmastodon.org/methods/notifications/ and
 * https://docs.joinmastodon.org/methods/statuses/.
 */
const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " } as Record<string, string>;

/** Status content is HTML; this turns it into the plain words a person typed. */
export function mastodonText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePoint(Number(dec)))
    .replace(/&[a-z]+;/gi, (entity) => named[entity.toLowerCase()] ?? entity);
  return text.trim();
}
function codePoint(value: number): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}
/** Drops the "@assistant" words at the start of a mention. */
export function dropLeadingMentions(text: string, username: string): string {
  const own = new RegExp(`^@${username.replace(/[^A-Za-z0-9_]/g, "")}(@[\\w.-]+)?\\b[\\s,:]*`, "i");
  let rest = text.trimStart();
  for (let next = rest.replace(own, ""); next !== rest; next = rest.replace(own, "")) rest = next.trimStart();
  return rest;
}

const Account = z.object({ id: z.string(), acct: z.string(), username: z.string(), display_name: z.string().optional() }).passthrough();
const Status = z.object({ id: z.string(), content: z.string(), visibility: z.string(), account: Account }).passthrough();
const Notification = z.object({ id: z.string(), type: z.string(), account: Account, status: Status.nullish() }).passthrough();
const Visibility = z.enum(["public", "unlisted", "private", "direct"]);

/** Mastodon ids are numbers written as text, too long for a plain number. */
function newer(a: string, b: string): boolean {
  return a.length !== b.length ? a.length > b.length : a > b;
}

export interface MastodonOptions {
  id: string; instance: string; token: string; maxCharacters?: number; pollMs?: number; fetch?: typeof fetch;
}
interface ChatMemory { acct: string; visibility: z.infer<typeof Visibility>; statusId: string }

export class MastodonChannel extends PollingChannel {
  readonly kind = "mastodon";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly limit: number;
  private me: z.infer<typeof Account> | null = null;
  private lastId: string | null = null;
  private refused: string | null = null;
  /** Who to mention, how visibly, and which status to answer, per chat. */
  private readonly chats = new Map<string, ChatMemory>();
  constructor(private readonly options: MastodonOptions) {
    super(options.id, options.pollMs ?? 30000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = options.instance.replace(/\/+$/, "");
    this.limit = options.maxCharacters ?? 500;
    // Room is left for the "@person" the status starts with, so a piece is not cut short.
    this.maxTextLength = Math.max(100, Math.min(this.limit, 3500) - 80);
  }
  botName(): string | null { return this.me?.username ?? null; }
  override health(): ChannelHealth {
    return this.refused && this.state.state !== "connected" ? { state: "needs attention", reason: this.refused } : this.state;
  }
  private call(path: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
    return callJson(this.fetchImpl, "Mastodon", `${this.base}${path}`, {
      ...init, headers: { authorization: `Bearer ${this.options.token}`, ...(init.headers as Record<string, string> | undefined) },
    }).catch((error: unknown) => {
      if (/\((401|403)\)$/.test(error instanceof Error ? error.message : ""))
        this.refused = "Mastodon refused the access token. Make a new one under Preferences, Development and save it as MASTODON_ACCESS_TOKEN";
      throw error;
    });
  }
  protected override async prepare(): Promise<void> {
    this.me = Account.parse(await this.call("/api/v1/accounts/verify_credentials"));
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const query = `types[]=mention&limit=40${this.lastId ? `&since_id=${encodeURIComponent(this.lastId)}` : ""}`;
    const notes = z.array(Notification).parse(await this.call(`/api/v1/notifications?${query}`));
    this.refused = null;
    for (const note of notes) if (!this.lastId || newer(note.id, this.lastId)) this.lastId = note.id;
    if (first) return [];
    // The newest comes first; people are answered in the order they wrote.
    return notes.reverse().flatMap((note) => {
      const inbound = this.inbound(note);
      return inbound ? [inbound] : [];
    });
  }
  private inbound(note: z.infer<typeof Notification>): InboundMessage | null {
    const status = note.status;
    const visibility = Visibility.safeParse(status?.visibility);
    if (note.type !== "mention" || !status || !visibility.success || !this.me) return null;
    if (status.account.id === this.me.id) return null;
    const text = dropLeadingMentions(mastodonText(status.content), this.me.username);
    if (!text) return null;
    const direct = visibility.data === "direct";
    const chatId = this.ids.short(direct ? status.account.acct : status.id, "chat");
    this.remember(chatId, { acct: status.account.acct, visibility: visibility.data, statusId: status.id });
    return {
      channel: this.id, chatId, chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: `Mention by @${status.account.acct}` }),
      senderId: status.account.id, senderName: status.account.display_name || status.account.acct,
      text, addressed: true, messageId: this.ids.short(status.id, "msg"),
    };
  }
  private remember(chatId: string, memory: ChatMemory): void {
    this.chats.delete(chatId);
    this.chats.set(chatId, memory);
    if (this.chats.size > 1000) this.chats.delete(this.chats.keys().next().value!);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const memory = this.chats.get(chatId) ?? await this.recall(chatId);
    // Later pieces of a long answer carry no reply target, so they follow the status last answered.
    const inReplyTo = replyToMessageId ? this.ids.long(replyToMessageId) : memory.statusId;
    const words = `@${memory.acct} ${text}`.slice(0, this.limit);
    const key = createHash("sha256").update(`${chatId}\n${inReplyTo}\n${words}`).digest("hex");
    const answer = await this.call("/api/v1/statuses", {
      method: "POST", headers: { "idempotency-key": key },
      json: { status: words, visibility: memory.visibility, ...(inReplyTo ? { in_reply_to_id: inReplyTo } : {}) },
    });
    const posted = z.object({ id: z.string() }).passthrough().parse(answer);
    return this.ids.short(posted.id, "msg");
  }
  /** After a restart the memory is gone: a direct chat is its person, a group chat its status. */
  private async recall(chatId: string): Promise<ChatMemory> {
    const long = this.ids.long(chatId);
    if (!/^\d+$/.test(long)) return { acct: long, visibility: "direct", statusId: "" };
    const status = Status.parse(await this.call(`/api/v1/statuses/${long}`));
    const visibility = Visibility.catch("unlisted").parse(status.visibility);
    return { acct: status.account.acct, visibility, statusId: status.id };
  }
}

export const mastodonService = defineService({
  kind: "mastodon", name: "Mastodon", docs: "https://docs.joinmastodon.org/methods/notifications/",
  needs: ["The address of the Mastodon server the assistant's account is on",
    "An access token for that account (Preferences, Development, New application, with read and write access), saved as a secret"],
  receives: "polls",
  settings: z.object({
    instance: z.string().url(),
    tokenSecret: z.string().regex(secretName).default("MASTODON_ACCESS_TOKEN"),
    maxCharacters: z.number().int().min(200).max(100000).default(500),
    pollSeconds: z.number().int().min(10).max(3600).default(30),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.instance), "Mastodon server");
    return new MastodonChannel({ id: deps.id, instance: settings.instance, token: await deps.secret(settings.tokenSecret),
      maxCharacters: settings.maxCharacters, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});

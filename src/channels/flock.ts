import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, headerOf, sameSecret, secretName, ShortIds } from "./parity-common.js";
import type { PostedChannel } from "./parity-switch.js";
import { SeenMessages } from "./seen.js";

/**
 * Flock, through a Flock app with a bot. Flock posts each event to this computer's address with an
 * `X-Flock-Event-Token` header: a JSON Web Token signed (HS256) with the app secret, which is
 * checked, with its expiry, before anything in the post is read. Only `chat.receiveMessage` (a
 * person writing to the bot) is answered. Replies go out through `chat.sendMessage` with the bot
 * token in the body, never in the address.
 * API: https://docs.flock.com/display/flockos/Events and https://docs.flock.com/display/flockos/chat.sendMessage
 * The event shape follows OpenFang's crates/openfang-channels/src/flock.rs (MIT/Apache).
 */
export interface FlockOptions {
  id: string;
  appSecret: string;
  botToken: string;
  /** The app's id; when given, a token made for another app is refused. */
  appId?: string;
  /** The bot's own user id, so its own messages are never answered. */
  botUserId?: string;
  /** What the bot is called, so a mention of it in a group is recognised. */
  botName?: string;
  apiBase: string;
  /** The name the bot token is saved under, for the health line. */
  botTokenName?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const b64json = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
const ClaimsSchema = z.object({ exp: z.number(), appId: z.string().optional(), userId: z.string().optional() }).passthrough();

/** Checks an HS256 token's signature and expiry and returns its claims. Throws on anything else. */
export function verifyHs256(token: string, secret: string, nowSeconds: number): z.infer<typeof ClaimsSchema> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("The Flock event token is missing or malformed");
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!sameSecret(parts[2]!, expected)) throw new Error("The Flock event token was not signed with the app secret");
  const header = z.object({ alg: z.literal("HS256") }).passthrough().safeParse(b64json(parts[0]!));
  if (!header.success) throw new Error("The Flock event token uses an unexpected signing method");
  const claims = ClaimsSchema.safeParse(b64json(parts[1]!));
  if (!claims.success) throw new Error("The Flock event token has no expiry");
  if (claims.data.exp + 300 < nowSeconds) throw new Error("The Flock event token has expired");
  return claims.data;
}

/** The post's JSON, or nothing when it is not JSON at all. */
function readJson(raw: Buffer): unknown {
  try { return JSON.parse(raw.toString("utf8")) as unknown; } catch { return undefined; }
}

const EventSchema = z.object({
  name: z.string(),
  userId: z.string().optional(),
  message: z.object({
    from: z.string().min(1), to: z.string().min(1), text: z.string().default(""),
    uid: z.string().optional(), id: z.string().optional(), fromName: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export class FlockChannel implements ChannelAdapter, PostedChannel {
  readonly kind = "flock";
  readonly id: string;
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "connected", reason: "Waiting for Flock to post a message" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  private readonly ids = new ShortIds();
  private readonly seen = new SeenMessages();
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: FlockOptions) {
    this.id = options.id;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.botName ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> { this.deliver = onMessage; }
  async stop(): Promise<void> { this.deliver = null; }

  async receivePost(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ accepted: number }> {
    const now = Math.floor((this.options.now ?? Date.now)() / 1000);
    const claims = verifyHs256(headerOf(headers, "x-flock-event-token"), this.options.appSecret, now);
    if (this.options.appId && claims.appId !== this.options.appId) throw new Error("The Flock event token was made for another app");
    // Only now, with the token proved, is the post itself read.
    const event = EventSchema.safeParse(readJson(raw));
    if (!event.success) return { accepted: 0 };
    if (claims.userId && event.data.userId && claims.userId !== event.data.userId)
      throw new Error("The Flock event token was made for somebody else");
    const message = event.data.name === "chat.receiveMessage" ? this.inbound(event.data.message) : null;
    if (!message || !this.deliver) return { accepted: 0 };
    void this.deliver(message).catch(() => undefined);
    return { accepted: 1 };
  }

  private inbound(message: z.infer<typeof EventSchema>["message"]): InboundMessage | null {
    if (!message || !message.text.trim()) return null;
    if (this.options.botUserId && message.from === this.options.botUserId) return null;
    // A group's id starts with "g:"; anything else is a person writing to the bot directly.
    const group = message.to.startsWith("g:");
    const name = this.options.botName;
    const mention = name ? new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
    const addressed = !group || !!mention?.test(message.text);
    const text = mention ? message.text.replace(mention, "").trim() : message.text.trim();
    const messageId = this.ids.short(message.uid ?? message.id ?? `${Date.now()}`, "msg");
    const chatId = this.ids.short(group ? message.to : message.from, "chat");
    const senderId = this.ids.short(message.from, "who");
    if (!this.seen.first(SeenMessages.key(messageId, senderId, chatId, text))) return null;
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct", senderId,
      senderName: message.fromName ?? message.from, text, addressed, messageId,
    };
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    try {
      const answer = await callJson(this.fetchImpl, "Flock", `${this.options.apiBase.replace(/\/$/, "")}/chat.sendMessage`, {
        method: "POST", json: { to: this.ids.long(chatId), text: text.slice(0, this.maxTextLength), token: this.options.botToken },
      });
      const parsed = z.object({ uid: z.string().optional(), error: z.unknown().optional() }).passthrough().safeParse(answer);
      if (parsed.success && parsed.data.error !== undefined) throw new Error("Flock refused the message");
      this.state = { state: "connected" };
      return parsed.success ? parsed.data.uid : undefined;
    } catch (error) {
      if (/\((401|403)\)/.test(String(error)))
        this.state = { state: "needs attention", reason: `The bot token was refused. Save a new one as ${this.options.botTokenName ?? "FLOCK_BOT_TOKEN"}` };
      throw error;
    }
  }
}

export const flockService = defineService({
  kind: "flock", name: "Flock", docs: "https://docs.flock.com/display/flockos/Events",
  needs: [
    "A Flock app with a bot, made at dev.flock.com, with its event callback set to the address Branch shows",
    "The app secret, saved as a secret", "The bot token, saved as a secret",
  ],
  receives: "posted",
  settings: z.object({
    appSecretSecret: z.string().regex(secretName).default("FLOCK_APP_SECRET"),
    botTokenSecret: z.string().regex(secretName).default("FLOCK_BOT_TOKEN"),
    appId: z.string().min(1).max(100).optional(),
    botUserId: z.string().min(1).max(100).optional(),
    botName: z.string().min(1).max(80).optional(),
    apiBase: z.string().url().default("https://api.flock.co/v1"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Flock address");
    return new FlockChannel({
      id: deps.id, apiBase: settings.apiBase, fetch: deps.fetch, botTokenName: settings.botTokenSecret,
      appSecret: await deps.secret(settings.appSecretSecret), botToken: await deps.secret(settings.botTokenSecret),
      ...(settings.appId ? { appId: settings.appId } : {}),
      ...(settings.botUserId ? { botUserId: settings.botUserId } : {}),
      ...(settings.botName ? { botName: settings.botName } : {}),
    });
  },
});

import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { callJson, defineService, secretName, ShortIds } from "./parity-common.js";

/**
 * QQ, through Tencent's official QQ bot API v2 (https://bot.q.qq.com/wiki/develop/api-v2/). Not the
 * personal-account protocols (OneBot, NapCat and the like), which break QQ's terms.
 *
 * The app id and client secret buy a short-lived access token, renewed a minute before it runs
 * out. Events arrive over the gateway socket (hello, identify, heartbeats with the last sequence
 * number, resume after a drop). Four kinds of message are handled: a private chat (C2C), an
 * @mention in a group, an @mention in a guild channel, and a guild direct message. QQ only lets a
 * bot answer a message it was sent (a "passive reply"), so each chat remembers the message being
 * answered and every reply names it.
 */
export interface QqBotOptions {
  id: string;
  appId: string;
  clientSecret: string;
  secretName?: string;
  /** https://api.sgroup.qq.com, or the sandbox. A test stand-in may serve the gateway too. */
  apiBase?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  heartbeatMs?: number;
  retryBaseMs?: number;
}

/** PUBLIC_GUILD_MESSAGES, DIRECT_MESSAGE and GROUP_AND_C2C_EVENT. */
const intents = (1 << 30) | (1 << 12) | (1 << 25);
const officialApi = "https://api.sgroup.qq.com";
const qqHost = /(^|\.)qq\.com$/;
const payloadSchema = z.object({ op: z.number(), d: z.unknown().optional(), s: z.number().nullish(), t: z.string().nullish() }).passthrough();
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.union([z.string(), z.number()]) }).passthrough();
const readySchema = z.object({ session_id: z.string(), user: z.object({ id: z.string(), username: z.string().optional() }).passthrough() }).passthrough();
const authorSchema = z.object({
  id: z.string().optional(), user_openid: z.string().optional(), member_openid: z.string().optional(),
  username: z.string().optional(), bot: z.boolean().optional(),
}).passthrough();
const eventSchema = z.object({
  id: z.string().min(1).max(200), content: z.string().max(20000).default(""), author: authorSchema.default({}),
  group_openid: z.string().optional(), channel_id: z.string().optional(), guild_id: z.string().optional(),
}).passthrough();
type QqEvent = z.infer<typeof eventSchema>;

export class QqBotChannel implements ChannelAdapter {
  readonly kind = "qq-bot";
  readonly id: string;
  readonly maxTextLength = 3500;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private token: { value: string; until: number } | null = null;
  private socket: WebSocketConnection | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to QQ" };
  private me: { id: string; name: string } | null = null;
  private session: string | null = null;
  private sequence: number | null = null;
  private refused = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private readonly ids = new ShortIds();
  /** The message each chat last sent, which a reply must name, and how many replies it has had. */
  private readonly answering = new Map<string, { messageId: string; count: number }>();
  constructor(private readonly options: QqBotOptions) {
    this.id = options.id;
    this.api = (options.apiBase ?? officialApi).replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.me?.name ?? null; }
  health(): ChannelHealth {
    if (this.refused) return { state: "needs attention", reason: `QQ refused the app id or client secret. Save the bot's client secret as ${this.options.secretName ?? "QQ_BOT_CLIENT_SECRET"}` };
    return this.state;
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const socket = await (this.options.connect ?? connectWebSocket)(await this.gateway(), {
          onMessage: (text) => void this.receive(text, onMessage).catch(() => undefined),
        });
        this.socket = socket;
        await socket.closed;
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping) this.state = { state: "reconnecting", reason: "QQ closed the connection; reconnecting" };
      } catch (error) {
        this.state = { state: "reconnecting", reason: `Could not reach QQ: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.socket = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** A valid access token, fetched again a minute before the old one runs out. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const answer = await callJson(this.fetch, "QQ", this.options.tokenUrl ?? "https://bots.qq.com/app/getAppAccessToken", {
      method: "POST", json: { appId: this.options.appId, clientSecret: this.options.clientSecret },
    }).catch((error: unknown) => { if (/\((400|401|403)\)/.test(String(error))) this.refused = true; throw error; });
    const parsed = tokenSchema.safeParse(answer);
    this.refused = !parsed.success;
    if (!parsed.success) throw new Error("QQ would not issue an access token");
    const seconds = Math.max(0, Number(parsed.data.expires_in) || 0);
    this.token = { value: parsed.data.access_token, until: Date.now() + Math.max(0, seconds - 60) * 1000 };
    return this.token.value;
  }
  /** Asks QQ where its gateway is, and only follows an address on QQ's own servers. */
  private async gateway(): Promise<string> {
    const answer = await callJson(this.fetch, "QQ", `${this.api}/gateway`, { headers: await this.headers() });
    const url = new URL(z.object({ url: z.string().min(1) }).passthrough().parse(answer).url);
    const host = url.hostname.toLowerCase();
    const apiHost = new URL(this.api).hostname.toLowerCase();
    // Against QQ itself the gateway must be QQ's; a test stand-in may only point back at itself.
    const ok = qqHost.test(apiHost)
      ? url.protocol === "wss:" && qqHost.test(host)
      : host === apiHost && /^wss?:$/.test(url.protocol);
    if (!ok) throw new Error("QQ answered with a gateway that is not QQ's, so it was not used");
    return url.href;
  }
  private async headers(): Promise<Record<string, string>> {
    return { authorization: `QQBot ${await this.accessToken()}` };
  }
  private async receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const payload = payloadSchema.parse(JSON.parse(text));
    if (typeof payload.s === "number") this.sequence = payload.s;
    if (payload.op === 10) return this.hello(payload.d);
    if (payload.op === 7) { this.socket?.close(); return; }
    if (payload.op === 9) { this.session = null; this.sequence = null; this.socket?.close(); return; }
    if (payload.op !== 0) return;
    if (payload.t === "READY") return this.ready(payload.d);
    if (payload.t === "RESUMED") { this.state = { state: "connected" }; return; }
    const parsed = eventSchema.safeParse(payload.d);
    const inbound = parsed.success && payload.t ? this.inbound(payload.t, parsed.data) : null;
    if (inbound) void onMessage(inbound).catch(() => undefined);
  }
  /** Introduces the bot, or picks the old session up again after a drop. */
  private async hello(data: unknown): Promise<void> {
    const interval = this.options.heartbeatMs ?? z.object({ heartbeat_interval: z.number() }).passthrough().parse(data).heartbeat_interval;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.socket?.send(JSON.stringify({ op: 1, d: this.sequence })), Math.max(20, interval));
    this.heartbeat.unref();
    const token = `QQBot ${await this.accessToken()}`;
    this.socket?.send(JSON.stringify(this.session
      ? { op: 6, d: { token, session_id: this.session, seq: this.sequence ?? 0 } }
      : { op: 2, d: { token, intents, shard: [0, 1], properties: { $os: process.platform, $browser: "Branch Agent", $device: "Branch Agent" } } }));
  }
  private ready(data: unknown): void {
    const parsed = readySchema.parse(data);
    this.me = { id: parsed.user.id, name: parsed.user.username ?? parsed.user.id };
    this.session = parsed.session_id;
    this.state = { state: "connected" };
  }
  /** Turns one of the four message events into a message, or null for anything else. */
  private inbound(type: string, event: QqEvent): InboundMessage | null {
    const where = this.place(type, event);
    if (!where || event.author.bot || (this.me && event.author.id === this.me.id)) return null;
    const text = event.content.replace(/<@!?[\w-]+>/g, "").trim();
    if (!text) return null;
    const chatId = this.ids.short(where.chat, "chat");
    this.answering.set(chatId, { messageId: event.id, count: 0 });
    if (this.answering.size > 1000) this.answering.delete(this.answering.keys().next().value!);
    return {
      channel: this.id, chatId, chatKind: where.direct ? "direct" : "group",
      ...(where.direct ? {} : { chatTitle: where.chat.startsWith("group:") ? "QQ group" : "QQ guild channel" }),
      senderId: this.ids.short(where.sender, "who"), senderName: event.author.username ?? "QQ user",
      // QQ only delivers group and channel messages that @mention the bot.
      text, addressed: true, messageId: this.ids.short(event.id, "msg"),
    };
  }
  /** Where a message came from (and so where its reply goes), written as `endpoint:id`. */
  private place(type: string, event: QqEvent): { chat: string; sender: string; direct: boolean } | null {
    const { author } = event;
    if (type === "C2C_MESSAGE_CREATE") {
      const user = author.user_openid ?? author.id;
      return user ? { chat: `c2c:${user}`, sender: `qq-user:${user}`, direct: true } : null;
    }
    if (type === "GROUP_AT_MESSAGE_CREATE" && event.group_openid && author.member_openid)
      return { chat: `group:${event.group_openid}`, sender: `qq-member:${author.member_openid}`, direct: false };
    if (type === "AT_MESSAGE_CREATE" && event.channel_id && author.id)
      return { chat: `channel:${event.channel_id}`, sender: `qq-guild-user:${author.id}`, direct: false };
    if (type === "DIRECT_MESSAGE_CREATE" && event.guild_id && author.id)
      return { chat: `dm:${event.guild_id}`, sender: `qq-guild-user:${author.id}`, direct: true };
    return null;
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const [endpoint = "", target = ""] = splitOnce(this.ids.long(chatId));
    const answering = this.answering.get(chatId);
    const messageId = replyToMessageId ? this.ids.long(replyToMessageId) : answering?.messageId;
    const sequence = answering && answering.messageId === messageId ? ++answering.count : 1;
    const content = text.slice(0, this.maxTextLength);
    const passive = messageId ? { msg_id: messageId } : {};
    const id = encodeURIComponent(target);
    const route = endpoint === "c2c" ? { path: `/v2/users/${id}/messages`, json: { content, msg_type: 0, ...passive, msg_seq: sequence } }
      : endpoint === "group" ? { path: `/v2/groups/${id}/messages`, json: { content, msg_type: 0, ...passive, msg_seq: sequence } }
        : endpoint === "channel" ? { path: `/channels/${id}/messages`, json: { content, ...passive } }
          : endpoint === "dm" ? { path: `/dms/${id}/messages`, json: { content, ...passive } } : null;
    if (!route || !target) throw new Error("That is not a QQ chat Branch has heard from");
    const answer = await callJson(this.fetch, "QQ", `${this.api}${route.path}`, { method: "POST", json: route.json, headers: await this.headers() });
    const parsed = z.object({ id: z.string() }).passthrough().safeParse(answer);
    return parsed.success ? parsed.data.id : undefined;
  }
}

function splitOnce(value: string): [string, string] {
  const at = value.indexOf(":");
  return at < 0 ? [value, ""] : [value.slice(0, at), value.slice(at + 1)];
}

export const qqBotService = defineService({
  kind: "qq-bot", name: "QQ (official bot)", docs: "https://bot.q.qq.com/wiki/develop/api-v2/",
  needs: ["A bot registered on the QQ open platform (q.qq.com), with its App ID",
    "The bot's client secret (AppSecret), saved as a secret",
    "The message events switched on for the bot; public bots are reviewed by Tencent before strangers can reach them"],
  receives: "socket",
  settings: z.object({
    appId: z.string().regex(/^\d{3,20}$/),
    clientSecretSecret: z.string().regex(secretName).default("QQ_BOT_CLIENT_SECRET"),
    sandbox: z.boolean().default(false),
  }).strict(),
  async build(settings, deps) {
    const apiBase = settings.sandbox ? "https://sandbox.api.sgroup.qq.com" : officialApi;
    await deps.assertAllowed(new URL("https://bots.qq.com"), "QQ sign-in");
    await deps.assertAllowed(new URL(apiBase), "QQ bot API");
    return new QqBotChannel({
      id: deps.id, appId: settings.appId, clientSecret: await deps.secret(settings.clientSecretSecret),
      secretName: settings.clientSecretSecret, apiBase, fetch: deps.fetch, connect: deps.connectWs,
    });
  },
});

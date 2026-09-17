import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { callJson, defineService, secretName } from "./parity-common.js";

/**
 * Guilded, through its official bot API (https://guildedapi.com): messages arrive over the bot
 * socket and replies go out over the REST API, both signed with the bot token as a Bearer header.
 *
 * Guilded bots only see server channels, so every chat is a group and the assistant answers when it
 * is mentioned. After a dropped connection the socket is reopened with the id of the last message
 * seen, and Guilded replays what was missed; the very first connection never asks for a replay, so
 * nothing from before Branch started is answered.
 *
 * Guilded asks clients to send WebSocket ping frames; the shared socket client only answers the
 * server's pings, so the connection relies on Guilded's own pings and is reopened when it drops.
 */
export interface GuildedOptions {
  id: string;
  token: string;
  apiBase?: string;
  socketUrl?: string;
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  tokenName?: string;
  retryBaseMs?: number;
}

const payloadSchema = z.object({ op: z.number(), t: z.string().nullish(), s: z.string().nullish(), d: z.unknown().optional() }).passthrough();
const welcomeSchema = z.object({
  heartbeatIntervalMs: z.number().optional(), lastMessageId: z.string().nullish(),
  user: z.object({ id: z.string().min(1), name: z.string().optional() }).passthrough(),
}).passthrough();
const messageSchema = z.object({
  message: z.object({
    id: z.string().min(1).max(60), channelId: z.string().min(1).max(60), createdBy: z.string().min(1).max(60),
    content: z.string().max(20000).nullish(), createdByWebhookId: z.string().nullish(),
    mentions: z.object({ users: z.array(z.object({ id: z.string() }).passthrough()).nullish() }).passthrough().nullish(),
  }).passthrough(),
}).passthrough();

export class GuildedChannel implements ChannelAdapter {
  readonly kind = "guilded";
  readonly id: string;
  /** Guilded allows four thousand characters; replies are kept shorter. */
  readonly maxTextLength = 3500;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private socket: WebSocketConnection | null = null;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Guilded" };
  private me: { id: string; name: string } | null = null;
  /** The last message seen, sent back on a reconnect so Guilded replays what was missed. */
  private lastMessageId: string | null = null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  constructor(private readonly options: GuildedOptions) {
    this.id = options.id;
    this.api = (options.apiBase ?? "https://www.guilded.gg/api/v1").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.me?.name ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const socket = await (this.options.connect ?? connectWebSocket)(this.options.socketUrl ?? "wss://www.guilded.gg/websocket/v1", {
          headers: { authorization: `Bearer ${this.options.token}`, ...(this.lastMessageId ? { "guilded-last-message-id": this.lastMessageId } : {}) },
          onMessage: (text) => this.receive(text, onMessage),
        });
        this.socket = socket;
        await socket.closed;
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping) this.state = { state: "reconnecting", reason: "Guilded closed the connection; reconnecting" };
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        this.state = /\((401|403)\)/.test(said)
          ? { state: "needs attention", reason: `Guilded refused the bot token. Save a new one as ${this.options.tokenName ?? "GUILDED_BOT_TOKEN"}` }
          : { state: "reconnecting", reason: `Could not reach Guilded: ${said}` };
      }
      this.socket = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  private receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): void {
    const payload = payloadSchema.parse(JSON.parse(text));
    if (payload.op === 1) {
      const welcome = welcomeSchema.parse(payload.d);
      this.me = { id: welcome.user.id, name: welcome.user.name ?? welcome.user.id };
      if (welcome.lastMessageId) this.lastMessageId = welcome.lastMessageId;
      this.state = { state: "connected" };
      return;
    }
    // An unknown replay point: forget it, so the next connection starts from now.
    if (payload.op === 8) { this.lastMessageId = null; this.socket?.close(); return; }
    if (payload.op !== 0) return;
    if (payload.s) this.lastMessageId = payload.s;
    if (payload.t !== "ChatMessageCreated") return;
    const parsed = messageSchema.safeParse(payload.d);
    const inbound = parsed.success ? this.inbound(parsed.data.message) : null;
    if (inbound) void onMessage(inbound).catch(() => undefined);
  }
  private inbound(message: z.infer<typeof messageSchema>["message"]): InboundMessage | null {
    const me = this.me;
    const content = message.content ?? "";
    if (!me || message.createdBy === me.id || message.createdByWebhookId || !content.trim()) return null;
    const mentioned = (message.mentions?.users ?? []).some((user) => user.id === me.id);
    const handle = `@${me.name}`;
    const named = content.toLowerCase().includes(handle.toLowerCase());
    const text = named ? content.replace(new RegExp(escapeRegExp(handle), "gi"), "").trim() : content.trim();
    return {
      channel: this.id, chatId: message.channelId, chatKind: "group", chatTitle: `Guilded channel ${message.channelId}`,
      senderId: message.createdBy, senderName: message.createdBy,
      text: text || content, addressed: mentioned || named, messageId: message.id,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const json = { content: text.slice(0, this.maxTextLength), ...(replyToMessageId ? { replyMessageIds: [replyToMessageId] } : {}) };
    const answer = await callJson(this.fetch, "Guilded", `${this.api}/channels/${encodeURIComponent(chatId)}/messages`, {
      method: "POST", json, headers: { authorization: `Bearer ${this.options.token}` },
    });
    const parsed = z.object({ message: z.object({ id: z.string() }).passthrough() }).passthrough().safeParse(answer);
    return parsed.success ? parsed.data.message.id : undefined;
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export const guildedService = defineService({
  kind: "guilded", name: "Guilded", docs: "https://www.guilded.gg/docs/api/connecting",
  needs: ["A bot made in your Guilded server's settings, under Bots", "The bot's API token, saved as a secret"],
  receives: "socket",
  settings: z.object({
    tokenSecret: z.string().regex(secretName).default("GUILDED_BOT_TOKEN"),
    apiBase: z.string().url().regex(/^https?:\/\//).default("https://www.guilded.gg/api/v1"),
    socketUrl: z.string().url().regex(/^wss?:\/\//).default("wss://www.guilded.gg/websocket/v1"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Guilded API");
    await deps.assertAllowed(new URL(settings.socketUrl.replace(/^ws/, "http")), "Guilded bot socket");
    return new GuildedChannel({
      id: deps.id, token: await deps.secret(settings.tokenSecret), tokenName: settings.tokenSecret,
      apiBase: settings.apiBase, socketUrl: settings.socketUrl, fetch: deps.fetch, connect: deps.connectWs,
    });
  },
});
